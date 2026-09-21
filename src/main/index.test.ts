import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `src/main/index.ts` wires the app together at import time, so each test gets a
 * fresh module registry and re-imports it. Everything it touches — Electron, the
 * store, the network — is a double, so this exercises the real bootstrap path.
 */

import type * as ElectronDoubles from '../test/electron'
import type { FakeAppView } from '../test/appview'
import type { StatuskyBridge } from '../shared/bridge'

type Electron = typeof ElectronDoubles
type AppView = InstanceType<typeof FakeAppView>

interface Booted {
  electron: Electron
  appview: AppView
  /** The bridge the popover would hold, loaded into the same fresh registry. */
  api: StatuskyBridge
  dispose(): void
}

let booted: Booted | null = null

/** Drain the microtask queue, which a macrotask boundary does completely. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface BootOptions {
  /** Adjust the Electron doubles before the app boots. */
  prepare?: (electron: Electron) => void
  /** Config file contents to pretend are already on disk. */
  seed?: Record<string, unknown>
}

async function boot({ prepare, seed }: BootOptions = {}): Promise<Booted> {
  // A fresh registry per test, so `index.ts` re-runs its top-level bootstrap.
  vi.resetModules()
  const electron = (await import('../test/electron')) as Electron
  electron.resetElectron()
  // The generated wiring is compiled for production, which only answers a packaged
  // app served from app://statusky — which is exactly what these tests are booting.
  electron.app.isPackaged = true
  prepare?.(electron)

  const { resetPage } = await import('../test/page')
  resetPage()

  if (seed) {
    const { seedStore } = await import('../test/electron-store')
    seedStore('statusky', seed)
  }

  const { FakeAppView } = await import('../test/appview')
  const { BUILTIN_PROFILES } = await import('../test/harness')
  const appview = new FakeAppView()
  appview.setFeed(BUILTIN_PROFILES.bsky, [])
  appview.setFeed(BUILTIN_PROFILES.blacksky, [])
  const restore = appview.install()

  await import('./index')
  // Let `bootstrap()` run past `await app.whenReady()` and settle its first sync.
  await settle()

  await import('../preload/index')
  const api = electron.exposed.get('statusky') as StatuskyBridge

  booted = {
    electron,
    appview,
    api,
    dispose(): void {
      restore()
      appview.reset()
    }
  }
  return booted
}

afterEach(() => {
  booted?.dispose()
  booted = null
})

describe('single instance', () => {
  it('quits immediately when another copy already holds the lock', async () => {
    const { electron } = await boot({
      prepare: (e) => {
        e.app.singleInstanceLock = false
      }
    })

    expect(electron.app.quit).toHaveBeenCalledTimes(1)
    expect(electron.trays).toHaveLength(0)
    expect(electron.BrowserWindow.instances).toHaveLength(0)
    expect(electron.ipcMain.handlers.size).toBe(0)
  })
})

describe('bootstrap', () => {
  it('hides the dock, claims an app id, and creates the tray and popover', async () => {
    const { electron } = await boot()

    expect(electron.app.dock?.hide).toHaveBeenCalled()
    expect(electron.app.setAppUserModelId).toHaveBeenCalledWith('community.statusky.app')
    expect(electron.trays).toHaveLength(1)
    expect(electron.BrowserWindow.instances).toHaveLength(1)
  })

  it('survives a platform with no dock', async () => {
    const { electron } = await boot({
      prepare: (e) => {
        e.app.dock = null
      }
    })
    expect(electron.trays).toHaveLength(1)
  })

  it('attaches the generated IPC handlers to the popover', async () => {
    const { electron } = await boot()
    const window = electron.BrowserWindow.instances.at(-1)!

    // One handler per non-event method in schemas/statusky.eipc, all bound to the
    // popover's own WebContents rather than registered globally.
    expect(window.webContents.ipc.handlers.size).toBe(19)
    expect(electron.ipcMain.handlers.size).toBe(0)
  })

  it('registers the app:// scheme before the app is ready', async () => {
    const { electron } = await boot()
    expect(electron.privilegedSchemes.map((s) => s.scheme)).toContain('app')
    expect(electron.privilegedSchemes[0]?.privileges).toMatchObject({
      standard: true,
      secure: true
    })
  })

  // In development electron-vite serves the renderer, so the app:// handler would
  // shadow it — and the dev server's own origin is what the dev wiring validates.
  it('leaves the renderer to the dev server when one is running', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    try {
      const { electron } = await boot()

      expect(electron.protocolHandlers.has('app')).toBe(false)
      expect(electron.BrowserWindow.instances.at(-1)?.loaded).toEqual([
        { url: 'http://localhost:5173' }
      ])
    } finally {
      delete process.env.ELECTRON_RENDERER_URL
    }
  })

  it('serves the packaged renderer over app://', async () => {
    const { electron } = await boot()
    expect(electron.protocolHandlers.has('app')).toBe(true)
    expect(electron.BrowserWindow.instances.at(-1)?.loaded).toEqual([
      { url: 'app://statusky/index.html' }
    ])
  })

  it('starts polling, and fetches once on launch', async () => {
    const { appview } = await boot()
    expect(appview.requestsFor('app.bsky.feed.getAuthorFeed').length).toBeGreaterThan(0)
  })

  it('applies the persisted theme to the native theme source on launch', async () => {
    const { electron } = await boot({ seed: { settings: { theme: 'dark' } } })
    expect(electron.nativeTheme.themeSource).toBe('dark')
  })
})

/**
 * The generated wiring under test is production, so the production cases use it as is.
 * The development cases only swap the constant that records which branch was generated,
 * which is all the startup check reads. The validators stay production.
 */
function developmentWiring(): void {
  vi.doMock('@ipc/environment', () => ({ IPC_ENVIRONMENT: 'development' }))
}

describe('IPC wiring mismatch', () => {
  const MISMATCH = expect.stringContaining('IPC wiring mismatch')

  afterEach(() => {
    vi.doUnmock('@ipc/environment')
    vi.restoreAllMocks()
  })

  it('stays quiet when production wiring runs packaged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { electron } = await boot()

    expect(error).not.toHaveBeenCalledWith(MISMATCH)
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('stays quiet when development wiring runs unpackaged', async () => {
    developmentWiring()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { electron } = await boot({
      prepare: (e) => {
        e.app.isPackaged = false
      }
    })

    expect(error).not.toHaveBeenCalledWith(MISMATCH)
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  // What `npm start` did when it had no `prestart`: every call refused, and the refusal
  // only blames the origin.
  it('names production wiring in an unpackaged app once, and says what to run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { electron, api } = await boot({
      prepare: (e) => {
        e.app.isPackaged = false
      }
    })

    await expect(api.State.get()).rejects.toThrow('did not pass origin validation')
    await expect(api.Feed.refresh()).rejects.toThrow('did not pass origin validation')

    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(MISMATCH)
    const [message] = error.mock.calls[0]!
    expect(message).toContain('production IPC wiring')
    expect(message).toContain('app.isPackaged is false')
    expect(message).toContain('`npm start` or `npm run dev`')
    // Someone running unpackaged is at a terminal; the log is where they are looking.
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('names development wiring in a packaged app in a dialog as well as the log', async () => {
    developmentWiring()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { electron } = await boot()

    expect(error).toHaveBeenCalledTimes(1)
    const [message] = error.mock.calls[0]!
    expect(message).toContain('development IPC wiring')
    expect(message).toContain('app.isPackaged is true')
    expect(message).toContain('`npm run build`')

    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'Statusky was packaged with development IPC wiring',
        detail: message
      })
    )
  })

  it('does not hold up startup for the dialog', async () => {
    developmentWiring()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { electron, appview } = await boot({
      prepare: (e) => {
        // A dialog nobody dismisses.
        e.dialog.showMessageBox.mockImplementation(
          () => new Promise<{ response: number }>(() => {})
        )
      }
    })

    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(electron.trays).toHaveLength(1)
    expect(electron.BrowserWindow.instances).toHaveLength(1)
    expect(appview.requestsFor('app.bsky.feed.getAuthorFeed').length).toBeGreaterThan(0)
  })
})

describe('state changes', () => {
  it('pushes state to the renderer and updates the tray', async () => {
    const { electron, api } = await boot()
    const window = electron.BrowserWindow.instances[0]!
    const sentBefore = window.webContents.sent.length

    await api.Feed.markAllRead()
    await api.Accounts.patch('did:plc:4dtbz2ivhp5app3sbntcccxc', {
      muted: true
    })

    expect(window.webContents.sent.length).toBeGreaterThan(sentBefore)
    // The channel carries a per-build random prefix; what matters is that it is the
    // generated `State.changed` event and that it carried the new snapshot.
    expect(window.webContents.sent.at(-1)?.channel).toMatch(/statusky_\$_State_\$_changed$/)
    expect(window.webContents.sent.at(-1)?.payload).toMatchObject({
      accounts: expect.arrayContaining([expect.objectContaining({ muted: true })])
    })
    expect(electron.trays[0]!.tooltip).toContain('Statusky')
  })

  it('mirrors a theme change onto nativeTheme', async () => {
    const { electron, api } = await boot()

    await api.Preferences.patch({ theme: 'dark' })

    expect(electron.nativeTheme.themeSource).toBe('dark')
  })
})

describe('launch at login', () => {
  it('only re-registers the login item when the preference actually changes', async () => {
    const { electron, api } = await boot()
    electron.app.setLoginItemSettings.mockClear()

    await api.Preferences.patch({ launchAtLogin: true })
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })

    await api.Preferences.patch({ notificationSound: false })
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledTimes(1)

    await api.Preferences.patch({ launchAtLogin: false })
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledTimes(2)
  })

  it('warns instead of crashing when the OS refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api } = await boot({
      prepare: (e) => {
        e.app.loginItemThrows = new Error('not a bundled app')
      }
    })

    await api.Preferences.patch({ launchAtLogin: true })

    expect(warn).toHaveBeenCalledWith('Could not update the login item:', expect.any(Error))
    warn.mockRestore()
  })
})

describe('notifications', () => {
  it('raises OS notifications for posts newer than the cursor', async () => {
    const { electron, appview, api } = await boot({
      seed: { cursors: { 'did:plc:4dtbz2ivhp5app3sbntcccxc': '2026-01-01T00:00:00Z' } }
    })
    const { BUILTIN_PROFILES, seedFeed } = await import('../test/harness')
    seedFeed(appview, BUILTIN_PROFILES.bsky, [
      { text: 'Investigating a new outage', createdAt: '2026-01-02T00:00:00Z' }
    ])

    await api.Feed.refresh()

    expect(electron.notifications).toHaveLength(1)
    expect(electron.notifications[0]?.options.body).toBe('Investigating a new outage')
  })

  // A banner the OS refused is invisible by definition, so the only trace is the log.
  it('warns when the system refuses a notification', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { electron, appview, api } = await boot({
      seed: { cursors: { 'did:plc:4dtbz2ivhp5app3sbntcccxc': '2026-01-01T00:00:00Z' } }
    })
    const { BUILTIN_PROFILES, seedFeed } = await import('../test/harness')
    seedFeed(appview, BUILTIN_PROFILES.bsky, [
      { text: 'Investigating', createdAt: '2026-01-02T00:00:00Z' }
    ])
    electron.Notification.failWith = 'Notifications are not allowed for this application'

    await api.Feed.refresh()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())

    expect(warn).toHaveBeenCalledWith(
      'The system refused a notification:',
      expect.stringContaining('System Settings')
    )
    warn.mockRestore()
  })

  it('marks a clicked notification read and opens it', async () => {
    const { electron, appview, api } = await boot({
      seed: { cursors: { 'did:plc:4dtbz2ivhp5app3sbntcccxc': '2026-01-01T00:00:00Z' } }
    })
    const { BUILTIN_PROFILES, seedFeed } = await import('../test/harness')
    seedFeed(appview, BUILTIN_PROFILES.bsky, [
      { text: 'Investigating', createdAt: '2026-01-02T00:00:00Z' }
    ])
    await api.Feed.refresh()

    const state = await api.State.get()
    expect(state.unread).toHaveLength(1)

    electron.notifications[0]!.click()
    const after = await api.State.get()

    expect(after.unread).toHaveLength(0)
    expect(electron.openedExternally).toHaveLength(1)
  })
})

describe('network checks', () => {
  const HEALTH = 'https://bsky.network/xrpc/_health'
  const healthChecks = (electron: Electron): number =>
    electron.net.fetch.mock.calls.filter(([url]) => url === HEALTH).length

  it('go through Chromium’s network stack, as a browser tab’s requests would', async () => {
    const { electron } = await boot()
    await vi.waitFor(() => expect(healthChecks(electron)).toBe(1))
    const [, init] = electron.net.fetch.mock.calls.find(([url]) => url === HEALTH)! as unknown as [
      string,
      RequestInit
    ]
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit' })
    expect(electron.FakeNetWebSocket.instances.map((s) => s.url)).toContain(
      'wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos'
    )
  })

  it('run again when the machine wakes', async () => {
    const { electron } = await boot()
    await vi.waitFor(() => expect(healthChecks(electron)).toBe(1))

    electron.powerMonitor.emit('resume')
    await vi.waitFor(() => expect(healthChecks(electron)).toBe(2))
  })

  it('run from the tray menu, and show their dashboard', async () => {
    const { electron, api } = await boot()
    await vi.waitFor(() => expect(healthChecks(electron)).toBe(1))
    const revealed: (string | null)[] = []
    api.Network.onReveal((target) => revealed.push(target.serviceId))
    const window = electron.BrowserWindow.instances[0]!
    window.hide()

    electron.trays[0]!.emit('right-click')
    electron.menus[0]!.click('Run network checks')
    await vi.waitFor(() => expect(healthChecks(electron)).toBe(2))

    electron.menus[0]!.click('Show network status')
    expect(window.isVisible()).toBe(true)
    expect(revealed).toEqual([null])
  })

  it('open the dashboard at the service a clicked notification is about', async () => {
    // The Amazon control answers, so the machine is online and everything else that
    // fails — every Atmosphere service, here — really is down.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { electron, api } = await boot({
        prepare: (e) => e.servedFiles.set('https://checkip.amazonaws.com', '192.0.2.1')
      })
      const revealed: (string | null)[] = []
      api.Network.onReveal((target) => revealed.push(target.serviceId))

      // A failure is believed once it has been seen again, twenty seconds later.
      await vi.waitFor(() => expect(healthChecks(electron)).toBe(1))
      await vi.advanceTimersByTimeAsync(20_000)
      await vi.waitFor(() => expect(electron.notifications.length).toBeGreaterThan(0))

      const window = electron.BrowserWindow.instances[0]!
      window.hide()
      const relay = electron.notifications.find((n) => n.options.body?.startsWith('bsky.network '))!
      expect(relay.options.title).toBe('Network checks · Outage')
      relay.click()

      expect(window.isVisible()).toBe(true)
      expect(revealed).toEqual(['relay:bsky.network'])
      // Nothing on the web to open for a measured outage.
      expect(electron.openedExternally).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('lifecycle events', () => {
  it('refreshes when the machine wakes or unlocks', async () => {
    const { electron, appview } = await boot()
    const before = appview.requestsFor('app.bsky.feed.getAuthorFeed').length

    electron.powerMonitor.emit('resume')
    await settle()
    electron.powerMonitor.emit('unlock-screen')
    await settle()

    expect(appview.requestsFor('app.bsky.feed.getAuthorFeed').length).toBeGreaterThan(before)
  })

  it('shows the popover for a second launch and for activation', async () => {
    const { electron } = await boot()
    const window = electron.BrowserWindow.instances[0]!

    electron.app.emit('second-instance')
    expect(window.isVisible()).toBe(true)

    window.hide()
    electron.app.emit('activate')
    expect(window.isVisible()).toBe(true)
  })

  it('keeps the app alive when the popover closes', async () => {
    const { electron } = await boot()
    expect(electron.app.listenerCount('window-all-closed')).toBe(1)

    electron.app.emit('window-all-closed')

    expect(electron.app.quit).not.toHaveBeenCalled()
  })

  it('stops the poll timer before quitting', async () => {
    const { electron } = await boot()
    electron.app.emit('before-quit')
    expect(electron.app.quit).not.toHaveBeenCalled()
  })

  it('refreshes and marks everything read from the tray menu', async () => {
    const { electron, appview, api } = await boot({
      seed: { cursors: { 'did:plc:4dtbz2ivhp5app3sbntcccxc': '2026-01-01T00:00:00Z' } }
    })
    const { BUILTIN_PROFILES, seedFeed } = await import('../test/harness')
    seedFeed(appview, BUILTIN_PROFILES.bsky, [
      { text: 'Investigating', createdAt: '2026-01-02T00:00:00Z' }
    ])
    electron.trays[0]!.emit('right-click')

    electron.menus[0]!.click('Refresh now')
    await settle()

    const withUnread = await api.State.get()
    expect(withUnread.unread).toHaveLength(1)

    electron.menus[0]!.click('Mark all as read')

    const afterRead = await api.State.get()
    expect(afterRead.unread).toEqual([])
  })

  it('quits from the tray menu, tearing down the tray first', async () => {
    const { electron } = await boot()
    electron.trays[0]!.emit('right-click')

    electron.menus[0]!.click('Quit Statusky')

    expect(electron.trays[0]!.destroyed).toBe(true)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })

  it('quits from the renderer', async () => {
    const { electron, api } = await boot()
    await api.Host.quit()
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })
})
