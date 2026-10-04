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

/**
 * The tray's context menu: the last one built, rather than the first.
 *
 * Bootstrap installs the application menu before anything else builds one, so on
 * macOS `menus[0]` is that and not the tray's. See src/main/menu.ts.
 */
function trayMenu(electron: Electron): ReturnType<typeof electron.Menu.buildFromTemplate> {
  const menu = electron.menus.at(-1)
  if (!menu) throw new Error('No menu has been built.')
  return menu
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
  // Console spies are restored in the tests that make them, but only on the way out of a
  // test that passed; one that failed first must not silence the rest of the file.
  vi.restoreAllMocks()
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
        e.app.dock = undefined
      }
    })
    expect(electron.trays).toHaveLength(1)
  })

  it('attaches the generated IPC handlers to the popover', async () => {
    const { electron } = await boot()
    const window = electron.BrowserWindow.instances.at(-1)!

    // One handler per non-event method in schemas/statusky.eipc, all bound to the
    // popover's own WebContents rather than registered globally.
    expect(window.webContents.ipc.handlers.size).toBe(24)
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
  // Unpackaged, because a dev server only ever serves an app run from source.
  it('leaves the renderer to the dev server when one is running', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    try {
      const { electron } = await boot({
        prepare: (e) => {
          e.app.isPackaged = false
        }
      })

      expect(electron.protocolHandlers.has('app')).toBe(false)
      expect(electron.BrowserWindow.instances.at(-1)?.loaded).toEqual([
        { url: 'http://localhost:5173' }
      ])
    } finally {
      delete process.env.ELECTRON_RENDERER_URL
    }
  })

  // Anything that can set a shipped app's environment could otherwise put a page of its
  // own in a window that looks exactly like Statusky's. See `devServerUrl`.
  it('serves app:// in a packaged build even when the environment names a dev server', async () => {
    process.env.ELECTRON_RENDERER_URL = 'https://attacker.test/'
    try {
      const { electron } = await boot()

      expect(electron.protocolHandlers.has('app')).toBe(true)
      expect(electron.BrowserWindow.instances.at(-1)?.loaded).toEqual([
        { url: 'app://statusky/index.html' }
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

  it('fetches every built-in source once on launch', async () => {
    const { appview } = await boot()
    const { BUILTIN_PROFILES } = await import('../test/harness')

    const actors = appview.requestsFor('app.bsky.feed.getAuthorFeed').map((r) => r.actor)
    expect(actors.toSorted()).toEqual(
      [BUILTIN_PROFILES.bsky.did, BUILTIN_PROFILES.blacksky.did].toSorted()
    )
  })

  it('applies the persisted theme to the native theme source on launch', async () => {
    const { electron } = await boot({ seed: { settings: { theme: 'dark' } } })
    expect(electron.nativeTheme.themeSource).toBe('dark')
  })

  // Electron installs a default menu when nothing else does, and an LSUIElement app
  // never draws it — but its Cmd+R was still eating the renderer's own. See menu.ts.
  it('owns the application menu instead of leaving Electron’s default installed', async () => {
    const { withPlatform } = await import('../test/harness')
    const { electron } = await withPlatform('darwin', () => boot())

    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
    const edit = electron.applicationMenu.current?.submenu('Edit')?.map((e) => e.role)
    expect(edit).toContain('paste')
    expect(electron.applicationMenu.current?.roles()).not.toContain('reload')
  })

  it('fills in the About panel both menus open', async () => {
    const { electron } = await boot()

    expect(electron.app.setAboutPanelOptions).toHaveBeenCalledTimes(1)
    expect(electron.app.aboutPanel).toMatchObject({
      applicationVersion: electron.app.getVersion()
    })
  })

  it('refuses every renderer permission before there is a page to ask', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { electron } = await boot()

    expect(electron.session.defaultSession.request('media')).toBe(false)
    expect(electron.session.defaultSession.check('notifications')).toBe(false)
    warn.mockRestore()
  })

  // Undocking a laptop, or a projector going away, while the popover is open.
  it('moves an open popover back onto the work area when the displays change', async () => {
    const { electron } = await boot()
    const window = electron.BrowserWindow.instances[0]!
    electron.trays[0]!.emit('click')
    expect(window.isVisible()).toBe(true)
    const [, top] = window.getPosition()

    electron.screen.displays[0]!.workArea = { x: 0, y: 200, width: 1440, height: 700 }
    electron.screen.emit('display-metrics-changed', {}, electron.screen.displays[0], ['workArea'])

    expect(window.getPosition()[1]).toBeGreaterThan(top)
    expect(window.getPosition()[1]).toBe(208)
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
        e.dialog.showMessageBox.mockImplementation(() => new Promise<never>(() => {}))
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
    const session = await boot({ seed: AWAY_SEED })
    const { electron, api } = session
    const window = electron.BrowserWindow.instances[0]!
    await twoUpdates(session)
    expect(electron.trays[0]!.tooltip).toContain('2 unread updates')

    await api.Accounts.patch('did:plc:4dtbz2ivhp5app3sbntcccxc', {
      muted: true
    })

    // The channel carries a per-build random prefix; what matters is that it is the
    // generated `State.changed` event and that it carried the new snapshot. The network
    // checks publish on their own channel meanwhile, so the last message is not it.
    const pushed = window.webContents.sent.filter(({ channel }) =>
      channel.endsWith('statusky_$_State_$_changed')
    )
    expect(pushed.at(-1)?.payload).toMatchObject({
      accounts: expect.arrayContaining([expect.objectContaining({ muted: true })]),
      unread: []
    })
    // The muted source's updates stop counting, and the tray says so.
    expect(electron.trays[0]!.tooltip).not.toContain('unread')
  })

  it('mirrors a theme change onto nativeTheme', async () => {
    const { electron, api } = await boot()

    await api.Preferences.patch({ theme: 'dark' })

    expect(electron.nativeTheme.themeSource).toBe('dark')
  })
})

/**
 * Item 24. High contrast is a third theme rather than a shade of the other two, and it
 * arrives on an axis `ThemePreference` cannot express. Windows picks light or dark as
 * part of the high-contrast mode itself, so a pinned preference would overrule the OS's
 * own choice and leave the app light inside a high-contrast dark desktop — which is
 * exactly the kind of wrong that somebody who turned high contrast on cannot afford.
 * Unreachable from a Mac except through the double, which is why it is one.
 */
describe('high contrast', () => {
  it('stands the theme pin down while the OS is in a high-contrast mode', async () => {
    const { electron } = await boot({
      seed: { settings: { theme: 'light' } },
      prepare: (e) => {
        e.nativeTheme.shouldUseHighContrastColors = true
      }
    })

    expect(electron.nativeTheme.themeSource).toBe('system')
  })

  it('hands the pin back when the mode goes off again', async () => {
    const { electron } = await boot({
      seed: { settings: { theme: 'light' } },
      prepare: (e) => {
        e.nativeTheme.shouldUseHighContrastColors = true
      }
    })
    expect(electron.nativeTheme.themeSource).toBe('system')

    electron.nativeTheme.shouldUseHighContrastColors = false
    electron.nativeTheme.emit('updated')

    // The stored setting was never touched, so it is simply back in force.
    expect(electron.nativeTheme.themeSource).toBe('light')
  })

  // It is a mode people switch on to read something difficult and off afterwards, and
  // `updated` is the only notice of it there is.
  it('follows the mode being switched on while the app is running', async () => {
    const { electron } = await boot({ seed: { settings: { theme: 'dark' } } })
    expect(electron.nativeTheme.themeSource).toBe('dark')

    electron.nativeTheme.shouldUseHighContrastColors = true
    electron.nativeTheme.emit('updated')

    expect(electron.nativeTheme.themeSource).toBe('system')
  })

  it('leaves the user’s stored preference exactly where it was', async () => {
    const { electron, api } = await boot({
      seed: { settings: { theme: 'light' } },
      prepare: (e) => {
        e.nativeTheme.shouldUseHighContrastColors = true
      }
    })

    expect(electron.nativeTheme.themeSource).toBe('system')
    expect((await api.State.get()).settings.theme).toBe('light')
  })
})

/**
 * Item 22, across the whole boundary: a real popover calling the real preload bridge,
 * through the generated wiring and the origin validator, into the tray.
 */
describe('reduced motion', () => {
  /** An unread incident, which is what makes the tray announce anything at all. */
  async function withUnread(): Promise<Awaited<ReturnType<typeof boot>>> {
    const running = await boot({
      seed: { cursors: { 'did:plc:4dtbz2ivhp5app3sbntcccxc': '2026-01-01T00:00:00Z' } }
    })
    const { BUILTIN_PROFILES, seedFeed } = await import('../test/harness')
    seedFeed(running.appview, BUILTIN_PROFILES.bsky, [
      { text: 'Investigating elevated error rates', createdAt: '2026-01-02T00:00:00Z' }
    ])
    await running.api.Feed.refresh()
    return running
  }

  it('beats once the popover reports that motion is fine', async () => {
    const { electron, api } = await withUnread()

    await api.Popover.reduceMotion(false)

    expect(electron.trays[0]?.image.path).toMatch(/trayBeat\d+\.png$/)
  })

  it('badges instead of beating once the popover reports the preference', async () => {
    const { electron, api } = await withUnread()
    await api.Popover.reduceMotion(false)

    await api.Popover.reduceMotion(true)

    expect(electron.trays[0]?.image.path).toContain('Dot.png')
  })

  // The state it is safe to be in before any page has loaded, and the one a popover
  // whose renderer will not start leaves the app in for good.
  it('does not beat before any page has reported at all', async () => {
    const { electron } = await withUnread()
    // Still saying there is something unread, just holding still while it does.
    expect(electron.trays[0]?.image.path).toMatch(/Dot\.png$/)
  })
})

describe('launch at login', () => {
  it('only re-registers the login item when the preference actually changes', async () => {
    const { electron, api } = await boot()
    electron.app.setLoginItemSettings.mockClear()

    await api.Preferences.patch({ launchAtLogin: true })
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })

    await api.Preferences.patch({ notificationSound: 'never' })
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledTimes(1)

    await api.Preferences.patch({ launchAtLogin: false })
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledTimes(2)
  })

  it('says nothing when the OS does what it was asked', async () => {
    const { api } = await boot()

    await api.Preferences.patch({ launchAtLogin: true })

    const state = await api.State.get()
    expect(state.loginItem).toEqual({ registered: true, error: null })
  })

  // The macOS 13 case, and the reason the write is not taken as the answer: SMAppService
  // returns without raising anything and registers nothing at all.
  it('carries a login item that quietly did not take into the state', async () => {
    const { api } = await boot({
      prepare: (e) => {
        e.app.loginItemRefuses = true
      }
    })

    await api.Preferences.patch({ launchAtLogin: true })

    const state = await api.State.get()
    // The setting is still what the user asked for; the status says the OS disagreed.
    expect(state.settings.launchAtLogin).toBe(true)
    expect(state.loginItem.registered).toBe(false)
    expect(state.loginItem.error).toContain('Applications folder')
  })

  it('carries a thrown refusal into the state rather than a log nobody reads', async () => {
    const { api } = await boot({
      prepare: (e) => {
        e.app.loginItemThrows = new Error('not a bundled app')
      }
    })

    await api.Preferences.patch({ launchAtLogin: true })

    const state = await api.State.get()
    expect(state.loginItem.registered).toBe(false)
    // Worded for the platform, but always a sentence about the login item rather than a
    // stack trace. See `explainLoginItemFailure`.
    expect(state.loginItem.error).toContain('would not open Statusky at login')
  })

  it('clears the explanation once the OS accepts', async () => {
    const { electron, api } = await boot({
      prepare: (e) => {
        e.app.loginItemRefuses = true
      }
    })

    await api.Preferences.patch({ launchAtLogin: true })
    expect((await api.State.get()).loginItem.error).toContain('would not open Statusky at login')

    // The user moved Statusky into /Applications and tried again.
    electron.app.loginItemRefuses = false
    await api.Preferences.patch({ launchAtLogin: false })
    await api.Preferences.patch({ launchAtLogin: true })

    expect(await api.State.get()).toMatchObject({
      loginItem: { registered: true, error: null }
    })
  })

  /**
   * A registration can go away without the setting changing — the app is re-signed, the
   * autostart entry is deleted by hand, the login item is removed in System Settings —
   * and until now the app would have believed the setting and never looked.
   */
  it('re-registers a login item that has drifted away from the setting', async () => {
    const { electron, api } = await boot({
      seed: { settings: { launchAtLogin: true } }
    })

    // Booted with the preference on and nothing actually registered, so the first
    // change handler notices the disagreement and registers it.
    expect(electron.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect((await api.State.get()).loginItem.registered).toBe(true)
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
    expect(electron.openedExternally).toEqual([state.posts[0]!.url])
  })
})

describe('the buttons on a banner', () => {
  /**
   * The difference between a banner and an interruption: *Mark as read* deals with the
   * update where it stands, and opens nothing. Wired separately from the click for
   * exactly that reason — the click opens the status page, which is the other thing
   * somebody might want and not the same thing.
   */
  it('deals with an update from the banner without opening anything', async () => {
    const { electron, appview, api } = await boot({ seed: AWAY_SEED })
    const { BUILTIN_PROFILES, seedFeed } = await import('../test/harness')
    seedFeed(appview, BUILTIN_PROFILES.bsky, [
      { text: 'Investigating', createdAt: '2026-01-02T00:00:00Z' }
    ])
    await api.Feed.refresh()
    expect((await api.State.get()).unread).toHaveLength(1)

    electron.notifications[0]!.act(0)

    expect((await api.State.get()).unread).toHaveLength(0)
    expect(electron.openedExternally).toHaveLength(0)
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

  // `resume` is every unlock as well as every wake, so a sweep that is still fresh stands.
  it('run again when the machine wakes, once what they measured has gone stale', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { electron, api } = await boot()
      await vi.waitFor(() => expect(healthChecks(electron)).toBe(1))
      // Long enough for every check in the first sweep to have finished or given up.
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await api.State.get()).network.lastSweepAt).not.toBeNull()

      electron.powerMonitor.emit('resume')
      await settle()
      expect(healthChecks(electron)).toBe(1)

      electron.powerMonitor.emit('suspend')
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      electron.powerMonitor.emit('resume')
      await vi.waitFor(() => expect(healthChecks(electron)).toBe(2))
    } finally {
      vi.useRealTimers()
    }
  })

  it('run from the tray menu, and show their dashboard', async () => {
    const { electron, api } = await boot()
    await vi.waitFor(() => expect(healthChecks(electron)).toBe(1))
    const revealed: (string | null)[] = []
    api.Network.onReveal((target) => revealed.push(target.serviceId))
    const window = electron.BrowserWindow.instances[0]!
    window.hide()

    electron.trays[0]!.emit('right-click')
    trayMenu(electron).click('Run network checks')
    await vi.waitFor(() => expect(healthChecks(electron)).toBe(2))

    trayMenu(electron).click('Show network status')
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
    const feeds = (): number => appview.requestsFor('app.bsky.feed.getAuthorFeed').length
    const launched = feeds()

    electron.powerMonitor.emit('resume')
    await settle()
    const woken = feeds()
    expect(woken).toBeGreaterThan(launched)

    electron.powerMonitor.emit('unlock-screen')
    await settle()
    expect(feeds()).toBeGreaterThan(woken)
  })

  it('shows the popover for a second launch and for activation', async () => {
    const { electron } = await boot()
    const window = electron.BrowserWindow.instances[0]!

    // Electron hands the second copy's whole command line over; a plain relaunch is one
    // with no `statusky://` URL on the end of it. See src/main/deep-link.ts.
    electron.app.emit('second-instance', {}, ['/Applications/Statusky.app', '--no-sandbox'])
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
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { electron, appview } = await boot({ seed: { settings: { pollIntervalSec: 60 } } })
      const feeds = (): number => appview.requestsFor('app.bsky.feed.getAuthorFeed').length

      electron.app.emit('before-quit')
      const quitting = feeds()
      await vi.advanceTimersByTimeAsync(300_000)

      expect(feeds()).toBe(quitting)
    } finally {
      vi.useRealTimers()
    }
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

    trayMenu(electron).click('Refresh now')
    await settle()

    const withUnread = await api.State.get()
    expect(withUnread.unread).toHaveLength(1)

    trayMenu(electron).click('Mark all as read')

    const afterRead = await api.State.get()
    expect(afterRead.unread).toEqual([])
  })

  it('quits from the tray menu, tearing down the tray first', async () => {
    const { electron } = await boot()
    electron.trays[0]!.emit('right-click')

    trayMenu(electron).click('Quit Statusky')

    expect(electron.trays[0]!.destroyed).toBe(true)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })

  it('quits from the renderer', async () => {
    const { electron, api } = await boot()
    await api.Host.quit()
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })
})

/**
 * None of these can be raised honestly from a test run — a lid, a cable, a warm laptop
 * and a logout respectively — so they are driven through the `powerMonitor` double.
 * What is being tested here is the wiring: `src/main/power.ts` has its own tests for
 * which event means what.
 */
describe('what the OS says about the machine', () => {
  it('stops polling while it sleeps, and starts again when it wakes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { electron, appview } = await boot({ seed: { settings: { pollIntervalSec: 60 } } })
      const feeds = (): number => appview.requestsFor('app.bsky.feed.getAuthorFeed').length

      electron.powerMonitor.emit('suspend')
      const asleep = feeds()
      await vi.advanceTimersByTimeAsync(300_000)
      expect(feeds()).toBe(asleep)

      electron.powerMonitor.emit('resume')
      await vi.waitFor(() => expect(feeds()).toBeGreaterThan(asleep))
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a laptop that was already on battery at launch as one', async () => {
    const { api } = await boot({
      prepare: (e) => {
        e.powerMonitor.onBattery = true
      }
    })

    expect((await api.State.get()).network.restraint).toBe('battery')
  })

  it('stands the sweeps down while the machine is too hot to measure from', async () => {
    const { electron, api } = await boot()

    electron.powerMonitor.emit('thermal-state-change', { state: 'serious' })

    expect((await api.State.get()).network.restraint).toBe('thermal')
    expect(electron.trays[0]!.tooltip).toContain('under load')
  })

  // `before-quit` covers the tray menu; a logout does not always route through it.
  it('shuts down cleanly when the OS says it is logging out', async () => {
    const { electron } = await boot()
    const event = { preventDefault: vi.fn() }

    electron.powerMonitor.emit('shutdown', event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(electron.trays[0]!.destroyed).toBe(true)
    expect(electron.app.quit).toHaveBeenCalledTimes(1)
  })
})

/** A cursor just under the updates the away tests seed, so both of them are news. */
const AWAY_SEED = { cursors: { 'did:plc:4dtbz2ivhp5app3sbntcccxc': '2026-01-01T00:00:00Z' } }

/** Two updates the user has not seen, arriving through an ordinary refresh. */
async function twoUpdates(session: Booted): Promise<void> {
  const { BUILTIN_PROFILES, seedFeed } = await import('../test/harness')
  seedFeed(session.appview, BUILTIN_PROFILES.bsky, [
    { text: 'Investigating a new outage', createdAt: '2026-01-02T00:00:00Z' },
    { text: 'Identified the cause', createdAt: '2026-01-02T00:10:00Z' }
  ])
  await session.api.Feed.refresh()
}

describe('banners raised while nobody is there', () => {
  it('waits, and then says the lot in one', async () => {
    const session = await boot({ seed: AWAY_SEED })
    const { electron, api } = session
    electron.powerMonitor.emit('lock-screen')

    await twoUpdates(session)
    expect(electron.notifications).toHaveLength(0)
    // Held is not read: the tray has been beating about them the whole time.
    expect((await api.State.get()).unread).toHaveLength(2)

    electron.powerMonitor.emit('unlock-screen')

    expect(electron.notifications).toHaveLength(1)
    expect(electron.notifications[0]?.options.title).toBe('Statusky · While you were away')
    expect(electron.notifications[0]?.options.body).toContain('2 updates')
  })

  it('opens the Timeline from that summary rather than any one post', async () => {
    const session = await boot({ seed: AWAY_SEED })
    const { electron, api } = session
    let caught = 0
    api.Popover.onCatchUp(() => caught++)
    electron.powerMonitor.emit('lock-screen')
    await twoUpdates(session)
    electron.powerMonitor.emit('unlock-screen')

    const window = electron.BrowserWindow.instances[0]!
    window.hide()
    electron.notifications[0]!.click()

    expect(window.isVisible()).toBe(true)
    expect(caught).toBe(1)
    expect(electron.openedExternally).toEqual([])
  })

  it('does not resurrect what the user dealt with in the popover meanwhile', async () => {
    const session = await boot({ seed: AWAY_SEED })
    const { electron, api } = session
    electron.powerMonitor.emit('lock-screen')
    await twoUpdates(session)

    await api.Feed.markAllRead()
    electron.powerMonitor.emit('unlock-screen')

    expect(electron.notifications).toHaveLength(0)
  })

  it('raises the ordinary banner when only one update was held', async () => {
    const session = await boot({ seed: AWAY_SEED })
    const { electron, api } = session
    const { BUILTIN_PROFILES, seedFeed } = await import('../test/harness')
    electron.powerMonitor.emit('lock-screen')
    seedFeed(session.appview, BUILTIN_PROFILES.bsky, [
      { text: 'Investigating a new outage', createdAt: '2026-01-02T00:00:00Z' }
    ])
    await api.Feed.refresh()

    electron.powerMonitor.emit('unlock-screen')

    expect(electron.notifications).toHaveLength(1)
    expect(electron.notifications[0]?.options.body).toBe('Investigating a new outage')
  })

  // Nobody locks the screen to go to lunch; the idle clock is what catches that.
  it('counts a machine nobody has touched for five minutes as nobody being there', async () => {
    const session = await boot({
      seed: AWAY_SEED,
      prepare: (e) => {
        e.powerMonitor.idleState = 'idle'
      }
    })

    await twoUpdates(session)

    expect(session.electron.notifications).toHaveLength(0)
  })
})

/**
 * *Pause notifications* in the tray menu, which is where somebody reaches for it — a call
 * starting, a screen about to be shared — and not a moment to go looking in Settings.
 * When the snooze ends is `snoozeEnd`'s own test; this is the wiring, and the promise
 * that resuming says at once what the pause held back rather than leaving it for a timer.
 */
describe('pausing notifications from the tray', () => {
  it('holds banners for an hour, and says what it held the moment it is resumed', async () => {
    const session = await boot({ seed: AWAY_SEED })
    const { electron, api } = session

    electron.trays[0]!.emit('right-click')
    const pause = trayMenu(electron).submenu('Pause notifications')!
    const before = Date.now()
    pause.find((entry) => entry.label === 'For 1 hour')!.click!()
    const after = Date.now()

    const until = Date.parse((await api.State.get()).settings.notificationsSnoozedUntil!)
    expect(until).toBeGreaterThanOrEqual(before + 60 * 60_000)
    expect(until).toBeLessThanOrEqual(after + 60 * 60_000)

    await twoUpdates(session)
    expect(electron.notifications).toHaveLength(0)

    electron.trays[0]!.emit('right-click')
    const resume = trayMenu(electron).template.find((entry) =>
      entry.label?.startsWith('Resume notifications')
    )!
    resume.click!()

    expect((await api.State.get()).settings.notificationsSnoozedUntil).toBeNull()
    expect(electron.notifications).toHaveLength(1)
    expect(electron.notifications[0]?.options.title).toBe(
      'Statusky · While notifications were paused'
    )
    expect(electron.notifications[0]?.options.body).toContain('2 updates')
  })

  it('lets nothing it held go up once the app is quitting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const session = await boot({ seed: AWAY_SEED })
      const { electron } = session
      electron.trays[0]!.emit('right-click')
      const pause = trayMenu(electron).submenu('Pause notifications')!
      pause.find((entry) => entry.label === 'For 1 hour')!.click!()
      await twoUpdates(session)

      electron.app.emit('before-quit')
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)

      expect(electron.notifications).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * `statusky://` deep links, end to end through the startup sequence.
 *
 * The link shapes and their refusals are src/main/deep-link.ts's own tests; what is
 * proven here is the wiring — that a link reaches the popover, that it reaches it as one
 * of a closed set of views rather than as a URL, and that the two ways the OS delivers
 * one (macOS's `open-url`, everybody else's relaunch) both arrive.
 */
describe('deep links', () => {
  it('opens the popover for a link that names no view in particular', async () => {
    const { electron } = await boot()
    const window = electron.BrowserWindow.instances[0]!
    window.hide()

    electron.app.emit('open-url', { preventDefault: vi.fn() }, 'statusky://open')

    expect(window.isVisible()).toBe(true)
  })

  it('shows the dashboard at the service a link names', async () => {
    const { electron, api } = await boot()
    const revealed: (string | null)[] = []
    api.Network.onReveal((target) => revealed.push(target.serviceId))

    electron.app.emit(
      'open-url',
      { preventDefault: vi.fn() },
      'statusky://service/relay:bsky.network'
    )

    expect(revealed).toEqual(['relay:bsky.network'])
  })

  /**
   * The check that keeps the promise the scheme makes: a service id is a string chosen
   * by whoever sent the link until it has been matched against what this app measures.
   */
  it('will not pass a service it does not measure to the popover', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { electron, api } = await boot()
    const revealed: (string | null)[] = []
    api.Network.onReveal((target) => revealed.push(target.serviceId))
    try {
      electron.app.emit(
        'open-url',
        { preventDefault: vi.fn() },
        'statusky://service/relay:evil.example'
      )

      // The dashboard itself, rather than a service id somebody else chose.
      expect(revealed).toEqual([null])
    } finally {
      warn.mockRestore()
    }
  })

  /** Windows and Linux have no `open-url`: the link arrives on a second copy's argv. */
  it('takes a link off the command line of a second launch', async () => {
    const { electron, api } = await boot()
    const revealed: (string | null)[] = []
    api.Network.onReveal((target) => revealed.push(target.serviceId))

    electron.app.emit('second-instance', {}, [
      'C:\\statusky\\Statusky.exe',
      'statusky://service/relay:bsky.network'
    ])

    expect(revealed).toEqual(['relay:bsky.network'])
    expect(electron.BrowserWindow.instances[0]!.isVisible()).toBe(true)
  })

  /**
   * The registration itself is Windows-only and is `registerProtocolClient`'s own test.
   * What matters here is that a Mac is left alone: Launch Services reads the scheme out
   * of the packaged Info.plist, and claiming it again from a running process would point
   * the machine's handler at whichever binary happened to be running.
   */
  it('does not claim the scheme from Launch Services on a Mac', async () => {
    const { electron } = await boot()
    expect(electron.app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })
})

/**
 * A handle dragged from a browser onto the menu bar icon. `Model.addAccount` already
 * takes exactly the three things somebody would have selected, so what is wired here is
 * what the user sees afterwards — which cannot be nothing, in either direction.
 */
describe('text dropped on the icon', () => {
  it('watches what was dropped and opens the popover on it', async () => {
    const { electron, appview, api } = await boot()
    const window = electron.BrowserWindow.instances[0]!
    window.hide()
    appview.addProfile({
      did: 'did:plc:dropped000000000000000',
      handle: 'status.example.com',
      displayName: 'Example Status',
      followersCount: 10,
      postsCount: 2
    })
    appview.setFeed(
      {
        did: 'did:plc:dropped000000000000000',
        handle: 'status.example.com',
        displayName: 'Example Status',
        followersCount: 10,
        postsCount: 2
      },
      []
    )

    electron.trays[0]!.dropText('status.example.com')
    await settle()

    expect((await api.State.get()).accounts.map((a) => a.handle)).toContain('status.example.com')
    expect(window.isVisible()).toBe(true)
  })

  /**
   * A drag that lands on the icon and produces absolutely nothing is indistinguishable
   * from the feature not existing. A notification would be the quieter answer and is the
   * one channel that may be silently unavailable on this platform, so it is a dialog —
   * and it quotes back what was dropped, because that is usually where the reason is.
   */
  it('says so when what was dropped is not something it can watch', async () => {
    const { electron } = await boot()

    electron.trays[0]!.dropText('   not a handle at all   ')
    await settle()

    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        detail: expect.stringContaining('not a handle at all')
      })
    )
  })

  it('trims a paragraph down to something a dialog can show', async () => {
    const { electron } = await boot()

    electron.trays[0]!.dropText('x'.repeat(400))
    await settle()

    // 79 characters and an ellipsis: enough to recognise what was dropped, not enough
    // to make a dialog out of a paragraph somebody dragged by accident.
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringMatching(/Dropped: x{79}…$/) })
    )
  })
})

/**
 * The global shortcut: off by default, and reported honestly when the OS will not give
 * it to us. The registration itself is src/main/shortcut.ts's own test; this is the
 * wiring — that the setting reaches the OS, that what the OS said reaches the popover,
 * and that the combination is handed back on the way out.
 */
describe('the global shortcut', () => {
  it('asks for nothing until somebody asks for something', async () => {
    const { electron } = await boot()
    expect(electron.globalShortcut.registrations.size).toBe(0)
  })

  it('registers a shortcut that was already set before this launch', async () => {
    const { electron } = await boot({
      seed: { settings: { globalShortcut: 'CommandOrControl+Shift+S' } }
    })

    expect(electron.globalShortcut.isRegistered('CommandOrControl+Shift+S')).toBe(true)
  })

  it('summons the popover, and puts it away again', async () => {
    const { electron, api } = await boot()
    const window = electron.BrowserWindow.instances[0]!
    window.hide()
    await api.Preferences.patch({ globalShortcut: 'Alt+Shift+S' })

    electron.globalShortcut.press('Alt+Shift+S')
    expect(window.isVisible()).toBe(true)

    electron.globalShortcut.press('Alt+Shift+S')
    expect(window.isVisible()).toBe(false)
  })

  it('only talks to the OS when the setting actually changes', async () => {
    const { electron, api } = await boot()
    await api.Preferences.patch({ globalShortcut: 'Alt+Shift+S' })
    electron.globalShortcut.register.mockClear()

    await api.Preferences.patch({ notificationSound: 'never' })

    expect(electron.globalShortcut.register).not.toHaveBeenCalled()
  })

  /**
   * The failure the whole status field exists for: another application already owns the
   * combination, the registration is refused, and the only other symptom is a key that
   * silently does somebody else's thing.
   */
  it('carries a refused shortcut into the state rather than a key that never fires', async () => {
    const { api } = await boot({
      prepare: (e) => e.globalShortcut.taken.add('Alt+Shift+S')
    })

    await api.Preferences.patch({ globalShortcut: 'Alt+Shift+S' })

    const state = await api.State.get()
    // The setting is still what the user asked for; the status says the machine refused.
    expect(state.settings.globalShortcut).toBe('Alt+Shift+S')
    expect(state.shortcut.registered).toBe(false)
    expect(state.shortcut.error).toContain('Another application')
  })

  it('clears the explanation when a combination is accepted', async () => {
    const { electron, api } = await boot({
      prepare: (e) => e.globalShortcut.taken.add('Alt+Shift+S')
    })
    await api.Preferences.patch({ globalShortcut: 'Alt+Shift+S' })

    await api.Preferences.patch({ globalShortcut: 'CommandOrControl+Shift+S' })

    expect((await api.State.get()).shortcut).toEqual({ registered: true, error: null })
    expect(electron.globalShortcut.isRegistered('CommandOrControl+Shift+S')).toBe(true)
  })

  /**
   * A global shortcut is held against the session rather than against a window: left
   * registered, the combination can stay dead for other applications until logout.
   */
  it('hands the combination back on the way out', async () => {
    const { electron, api } = await boot()
    await api.Preferences.patch({ globalShortcut: 'Alt+Shift+S' })

    electron.app.emit('will-quit')

    expect(electron.globalShortcut.registrations.size).toBe(0)
  })
})

/**
 * Answer the GitHub releases API and leave every other request alone. The network checks
 * are running throughout these tests and go through the same `net.fetch`, so replacing it
 * outright would be measuring the release check with the probes' fixtures.
 */
function serveLatestRelease(electron: Electron, tag: string): void {
  const original = electron.net.fetch.getMockImplementation()!
  electron.net.fetch.mockImplementation(async (input: string | Request, init?: RequestInit) =>
    (typeof input === 'string' ? input : input.url).startsWith('https://api.github.com/')
      ? new Response(JSON.stringify({ tag_name: tag }), { status: 200 })
      : original(input, init)
  )
}

/**
 * Item 27. Two mechanisms, exactly one of them ever running, and the switch between them
 * decided by Squirrel rather than by guessing whether this build is signed. See
 * src/main/update.ts; this is the wiring, which is that the answer lands on `AppState`
 * and never on a notification.
 */
describe('keeping itself up to date', () => {
  it('starts the self-updater on a packaged macOS build', async () => {
    await boot()
    const { selfUpdaters } = await import('../test/update-electron-app')

    expect(selfUpdaters).toHaveLength(1)
  })

  /**
   * The whole point of supplying `onNotifyUser`. The package's default is a modal
   * dialog, and this app has no parent window for one — src/main/index.ts already
   * reasons about exactly that around the wiring-mismatch dialog, and that one at least
   * means something is broken.
   */
  it('puts a finished download in the tray menu, and raises nothing', async () => {
    const { electron, api } = await boot()
    const { lastSelfUpdater } = await import('../test/update-electron-app')

    lastSelfUpdater().finishDownload({ releaseName: '0.9.0' })
    await settle()

    expect((await api.State.get()).update).toEqual({ stage: 'ready', version: '0.9.0' })
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(electron.notifications).toHaveLength(0)

    electron.trays[0]!.emit('right-click')
    expect(trayMenu(electron).item('Restart to update 0.9.0')).toBeDefined()
  })

  /**
   * An ad-hoc signed build — every local one — downloads an update and is then refused
   * by Squirrel.Mac, because the signature does not match the running app. Nothing can
   * see that from here, so nothing tries to: Squirrel says so, and the release check
   * takes over and starts telling the user instead.
   */
  it('falls back to a notice when Squirrel refuses the update', async () => {
    const { electron, api } = await boot({
      prepare: (e) => serveLatestRelease(e, 'v9.9.9')
    })

    electron.autoUpdater.fail('Could not get code signature for running application')
    await settle()
    await settle()

    expect((await api.State.get()).update).toEqual({ stage: 'available', version: '9.9.9' })
    expect(electron.notifications).toHaveLength(0)

    electron.trays[0]!.emit('right-click')
    expect(trayMenu(electron).item('Download Statusky 9.9.9')).toBeDefined()
  })

  /**
   * Linux, which never self-updates at all: Electron's `autoUpdater` is Squirrel.Mac and
   * Squirrel.Windows and nothing else. The deb and the AppImage are direct downloads
   * rather than repository packages, so the only honest thing to do is say so.
   */
  it('only checks and tells on Linux, where nothing can install anything', async () => {
    const { withPlatform } = await import('../test/harness')
    const { electron, api } = await withPlatform('linux', () =>
      boot({ prepare: (e) => serveLatestRelease(e, 'v9.9.9') })
    )
    await settle()

    const { selfUpdaters } = await import('../test/update-electron-app')
    expect(selfUpdaters).toHaveLength(0)
    expect((await api.State.get()).update).toEqual({ stage: 'available', version: '9.9.9' })
    expect(electron.notifications).toHaveLength(0)
  })

  it('says nothing at all when the repository has published no release', async () => {
    const { api } = await boot()
    await settle()

    expect((await api.State.get()).update).toEqual({ stage: 'current', version: null })
  })

  it('stops checking on the way out', async () => {
    const { electron } = await boot()
    const { lastSelfUpdater } = await import('../test/update-electron-app')

    electron.app.emit('before-quit')

    expect(lastSelfUpdater().stopped).toBe(true)
  })
})

/**
 * Squirrel.Windows runs the application itself to tell it that it has been installed,
 * updated or removed. Unreachable from a Mac except by standing where it stands: what is
 * proven is that such a launch never reaches the menu bar, which is the failure a user
 * would see as four tray icons appearing during an install.
 */
describe('a Squirrel lifecycle launch', () => {
  it('quits without building a tray or a window', async () => {
    const argv = process.argv
    const { withPlatform } = await import('../test/harness')
    process.argv = ['Statusky.exe', '--squirrel-obsolete']
    try {
      const { electron } = await withPlatform('win32', () => boot())

      expect(electron.app.quit).toHaveBeenCalled()
      expect(electron.trays).toHaveLength(0)
      expect(electron.BrowserWindow.instances).toHaveLength(0)
    } finally {
      process.argv = argv
    }
  })
})
