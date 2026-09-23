import { describe, expect, it, vi } from 'vitest'
import { ipcErrorMessage } from '../shared/bridge'
import { DEFAULT_PROBE_TARGETS } from '../shared/probe-targets'
import {
  accountSchema,
  appStateSchema,
  networkSnapshotSchema,
  networkSummarySchema,
  probeCheckSchema,
  resolvedProfileSchema,
  serviceProbeSchema,
  settingsSchema,
  statusPostSchema,
  webhookStatusSchema
} from '../shared/schemas'
import type { ProbeTargets } from '../shared/types'
import {
  BrowserWindow,
  Notification,
  Tray,
  dialog,
  exposed,
  ipcMain,
  ipcRenderer,
  nativeImage,
  notifications,
  openedExternally,
  resetElectron,
  shell,
  trays
} from './electron'
import FakeElectronStore, { seedStore, stores } from './electron-store'
import { FakeAppView, embeds, rawPost } from './appview'
import { installBridge } from './bridge'
import { createHarness, flush, withPlatform } from './harness'
import {
  makeAccount,
  makeCheck,
  makeEmbed,
  makeNetworkSummary,
  makePost,
  makeProfile,
  makeService,
  makeSettings,
  makeSnapshot,
  makeState,
  makeWebhookStatus
} from './factories'
import {
  lastSelfUpdater,
  selfUpdateFailure,
  selfUpdaters,
  updateElectronApp
} from './update-electron-app'

/**
 * The doubles are load-bearing: if one of them drifts from the API it stands in
 * for, every test above it becomes a lie. These tests pin their behaviour.
 */

// Captured before any `resetElectron` can clear it. The preload only exposes anything
// to a page on the popover's own origin, so that has to be in place before it loads.
const { resetPage } = await import('./page')
resetPage()
await import('../preload/index')
const PRELOAD: unknown = exposed.get('statusky')

/**
 * Every interface an API object exposes, and every method on each, in a stable order.
 * Takes whatever it is given, because the point is to read what is actually there.
 */
function surface(api: unknown): Record<string, string[]> {
  const interfaces: [string, object][] = Object.entries(api ?? {})
  return Object.fromEntries(
    interfaces
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, methods]) => [name, Object.keys(methods).toSorted()])
  )
}

describe('the Electron double', () => {
  it('routes ipcRenderer.invoke to the matching ipcMain handler', async () => {
    ipcMain.handle('demo:echo', (_event, value) => `echo:${String(value)}`)
    await expect(ipcRenderer.invoke('demo:echo', 'hi')).resolves.toBe('echo:hi')
  })

  it('rejects an invoke with no handler, the way Electron does', async () => {
    await expect(ipcRenderer.invoke('demo:missing')).rejects.toThrow(
      "Error invoking remote method 'demo:missing': Error: No handler registered for 'demo:missing'"
    )
  })

  // Electron structured-clones both ways. A double that passed references would let main
  // and the page share an object, which no real build can do.
  it('hands the handler a copy of each argument, and the caller a copy of the answer', async () => {
    const kept = { count: 1 }
    let received: unknown
    ipcMain.handle('demo:copy', (_event, value) => {
      received = value
      return kept
    })
    const sent = { count: 1 }

    const answer = (await ipcRenderer.invoke('demo:copy', sent)) as { count: number }

    expect(received).toEqual(sent)
    expect(received).not.toBe(sent)
    expect(answer).toEqual(kept)
    answer.count = 2
    expect(kept.count).toBe(1)
  })

  it('refuses an argument that cannot be cloned before any handler sees it', async () => {
    const handler = vi.fn()
    ipcMain.handle('demo:proxy', handler)

    await expect(ipcRenderer.invoke('demo:proxy', new Proxy({}, {}))).rejects.toThrow(
      /could not be cloned/
    )
    expect(handler).not.toHaveBeenCalled()
  })

  // Electron sends a failure back as `String(error)` and nothing else, and the renderer
  // builds a plain `Error` around it: the class, the cause and any fields stay in main.
  it('carries a failure back as its string form alone', async () => {
    ipcMain.handle('demo:fail', () => {
      throw Object.assign(new TypeError('x is not a function', { cause: 'deep' }), { code: 7 })
    })

    const error = (await ipcRenderer.invoke('demo:fail').catch((e: unknown) => e)) as Error

    expect(error.constructor).toBe(Error)
    expect(error.message).toBe(
      "Error invoking remote method 'demo:fail': TypeError: x is not a function"
    )
    expect(error.cause).toBeUndefined()
    expect(error).not.toHaveProperty('code')
    // And that is exactly what the renderer knows how to read.
    expect(ipcErrorMessage(error)).toBe('x is not a function')
  })

  it('asks the calling frame first, then its page, then ipcMain', async () => {
    const window = new BrowserWindow()
    ipcMain.handle('demo:who', () => 'process')
    window.webContents.ipc.handle('demo:who', () => 'page')
    window.webContents.mainFrame.ipc.handle('demo:who', () => 'frame')

    await expect(ipcRenderer.invoke('demo:who')).resolves.toBe('frame')
    window.webContents.mainFrame.ipc.removeHandler('demo:who')
    await expect(ipcRenderer.invoke('demo:who')).resolves.toBe('page')
    window.webContents.ipc.removeHandler('demo:who')
    await expect(ipcRenderer.invoke('demo:who')).resolves.toBe('process')
  })

  it('refuses a duplicate handler and honours removeHandler', async () => {
    ipcMain.handle('demo:once', () => 1)
    expect(() => ipcMain.handle('demo:once', () => 2)).toThrow(/second handler/)

    ipcMain.removeHandler('demo:once')
    ipcMain.handle('demo:once', () => 2)
    await expect(ipcRenderer.invoke('demo:once')).resolves.toBe(2)
  })

  it('delivers a copy of each webContents.send to ipcRenderer listeners', () => {
    const listener = vi.fn()
    ipcRenderer.on('state:changed', listener)
    const window = new BrowserWindow()
    const state = { ok: true }

    window.webContents.send('state:changed', state)
    state.ok = false

    expect(listener).toHaveBeenCalledWith(expect.anything(), { ok: true })
    expect(window.webContents.sent).toEqual([{ channel: 'state:changed', payload: { ok: true } }])
  })

  it('throws from send once the page is gone, rather than dropping the message', () => {
    const window = new BrowserWindow()
    window.close()

    expect(() => window.webContents.send('state:changed', {})).toThrow('Object has been destroyed')
  })

  it('tracks window visibility and focus', () => {
    const window = new BrowserWindow({ width: 100, height: 50 })
    const blurred = vi.fn()
    window.on('blur', blurred)
    expect(window.isVisible()).toBe(false)

    window.show()
    window.focus()
    expect(window.isVisible()).toBe(true)
    expect(window.isFocused()).toBe(true)

    window.blur()
    expect(window.isFocused()).toBe(false)
    expect(blurred).toHaveBeenCalledTimes(1)

    window.close()
    expect(window.isVisible()).toBe(false)
    expect(window.isDestroyed()).toBe(true)
  })

  it('records notifications and replays a click', () => {
    const onClick = vi.fn()
    const notification = new Notification({ title: 'Hi' })
    notification.on('click', onClick)
    notification.show()

    notification.click()

    expect(notifications).toEqual([notification])
    expect(notification.shown).toBe(true)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('answers every file dialog as cancelled until a test says otherwise', async () => {
    await expect(dialog.showOpenDialog({})).resolves.toEqual({ canceled: true, filePaths: [] })
    await expect(dialog.showSaveDialog({})).resolves.toEqual({ canceled: true, filePath: '' })
  })

  it('records every externally opened URL', async () => {
    await shell.openExternal('https://bsky.app')
    expect(openedExternally).toEqual(['https://bsky.app'])
  })

  it('resets every register', async () => {
    ipcMain.handle('demo:x', () => 1)
    void new Notification({})
    void new BrowserWindow()
    void new Tray(nativeImage.createFromPath('/tray.png'))
    await shell.openExternal('https://bsky.app')

    resetElectron()

    expect(ipcMain.handlers.size).toBe(0)
    expect(notifications).toHaveLength(0)
    expect(BrowserWindow.instances).toHaveLength(0)
    expect(trays).toHaveLength(0)
    expect(openedExternally).toHaveLength(0)
  })

  // `mockClear` forgets the calls and keeps the implementation, so a test that pointed a
  // dialog at its own file would otherwise leave every later test choosing that file.
  it('puts back the cancelled file dialogs a test replaced', async () => {
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/mine.json'] })
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' })

    resetElectron()

    await expect(dialog.showOpenDialog({})).resolves.toEqual({ canceled: true, filePaths: [] })
    await expect(dialog.showSaveDialog({})).resolves.toEqual({ canceled: true, filePath: '' })
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1)
  })
})

describe('the electron-store double', () => {
  it('falls back to defaults for keys that were never written', () => {
    const store = new FakeElectronStore({ name: 'a', defaults: { count: 1, list: [] } })
    expect(store.get('count')).toBe(1)
    expect(store.has('count')).toBe(true)
    expect(store.get('missing', 'fallback')).toBe('fallback')
  })

  it('copies on read and on write, like a JSON-backed store', () => {
    const store = new FakeElectronStore({ name: 'b', defaults: { list: [] as number[] } })
    const written = [1, 2]
    store.set('list', written)
    written.push(3)

    const read = store.get('list')
    read.push(4)

    expect(store.get('list')).toEqual([1, 2])
  })

  // The file is JSON, so a value comes back the way JSON leaves it, not the way it went in.
  it('reads back what JSON kept, not what was written', () => {
    const store = new FakeElectronStore({ name: 'json' })
    store.set('entry', { at: new Date('2026-01-01T00:00:00.000Z'), gone: undefined, n: NaN })

    expect(store.get('entry')).toEqual({ at: '2026-01-01T00:00:00.000Z', n: null })
    expect(store.get('entry')).not.toHaveProperty('gone')
  })

  it('refuses a value JSON cannot hold', () => {
    const store = new FakeElectronStore({ name: 'refuses' })
    expect(() => store.set('callback', () => 1)).toThrow(/type `function`/)
    expect(() => store.set({ fine: 1, missing: undefined })).toThrow(/type `undefined`/)
    expect(store.has('fine')).toBe(false)
  })

  it('records writes, and forgets a deleted key until the file is next opened', () => {
    const store = new FakeElectronStore({ name: 'c', defaults: { a: 1 } })
    store.set('a', 2)
    expect(store.writes).toEqual(['a'])

    // Defaults are merged into the file once, when it is opened, and not consulted again:
    // `conf` answers a deleted key with nothing, not with its default.
    store.delete('a')
    expect(store.get('a')).toBeUndefined()
    expect(store.get('a', 9)).toBe(9)
    expect(store.has('a')).toBe(false)
    expect(new FakeElectronStore({ name: 'c', defaults: { a: 1 } }).get('a')).toBe(1)

    store.set({ a: 5, b: 6 })
    expect(store.store).toEqual({ a: 5, b: 6 })

    store.clear()
    expect(store.store).toEqual({ a: 1 })
  })

  it('serves seeded contents to the next store of that name, over its defaults', () => {
    seedStore('seeded', { hello: 'world' })
    const store = new FakeElectronStore({
      name: 'seeded',
      defaults: { hello: 'default', added: 'since' }
    })
    expect(store.get('hello')).toBe('world')
    expect(store.data).toEqual({ hello: 'world', added: 'since' })
    expect(stores.at(-1)).toBe(store)
  })
})

describe('the fake AppView', () => {
  const actor = { did: 'did:plc:aaa', handle: 'status.test' }

  it('serves an author feed and records the request', async () => {
    const appview = new FakeAppView()
    appview.setFeed(actor, [{ text: 'Investigating' }])
    const restore = appview.install()
    try {
      const response = await fetch(
        'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:aaa&limit=5'
      )
      const body = (await response.json()) as { feed: { post: { record: { text: string } } }[] }

      expect(body.feed[0]?.post.record.text).toBe('Investigating')
      expect(appview.requestsFor('app.bsky.feed.getAuthorFeed')).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('filters replies out of a posts_no_replies feed', async () => {
    const appview = new FakeAppView()
    appview.setFeed(actor, [
      rawPost(actor, { text: 'Top level' }),
      rawPost(actor, { text: 'A reply', reply: { root: {} } })
    ])
    const restore = appview.install()
    try {
      const response = await fetch(
        'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:aaa&filter=posts_no_replies'
      )
      const body = (await response.json()) as { feed: unknown[] }
      expect(body.feed).toHaveLength(1)
    } finally {
      restore()
    }
  })

  // The AppView answers an unknown actor with a 400 `InvalidRequest`, not a 404.
  it('refuses an actor it has never heard of, as the AppView does', async () => {
    const appview = new FakeAppView()
    const restore = appview.install()
    try {
      const response = await fetch(
        'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=nobody.test'
      )
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: 'InvalidRequest' })
    } finally {
      restore()
    }
  })

  it('pages an author feed newest first, and refuses a limit the lexicon does not allow', async () => {
    const appview = new FakeAppView()
    appview.setFeed(actor, [
      { text: 'Older', createdAt: '2026-01-01T09:00:00.000Z' },
      { text: 'Newer', createdAt: '2026-01-01T10:00:00.000Z' }
    ])
    const restore = appview.install()
    const feed = (query: string) =>
      fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${actor.did}${query}`
      )
    try {
      const body = (await (await feed('&limit=1')).json()) as {
        feed: { post: { record: { text: string } } }[]
      }
      expect(body.feed.map((item) => item.post.record.text)).toEqual(['Newer'])

      expect((await feed('&limit=101')).status).toBe(400)
      expect((await feed('&limit=0')).status).toBe(400)
    } finally {
      restore()
    }
  })

  it('reproduces an HTTP failure, a transport failure and a hang', async () => {
    const appview = new FakeAppView()
    appview.setFeed(actor, [])
    const restore = appview.install()
    try {
      appview.fail(actor.did, { kind: 'http', status: 429, body: { message: 'Slow down' } })
      const rateLimited = await fetch(
        'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did:plc:aaa'
      )
      expect(rateLimited.status).toBe(429)

      appview.clearFailures().fail(actor.did, { kind: 'network', message: 'offline' })
      await expect(
        fetch('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did:plc:aaa')
      ).rejects.toThrow('offline')

      appview.clearFailures().fail(actor.did, { kind: 'hang' })
      const controller = new AbortController()
      const pending = fetch(
        'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did:plc:aaa',
        { signal: controller.signal }
      )
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      restore()
    }
  })

  it('enforces the 25-actor limit on getProfiles', async () => {
    const appview = new FakeAppView()
    const restore = appview.install()
    try {
      const actors = Array.from({ length: 26 }, (_, i) => `actors=did:plc:${i}`).join('&')
      const response = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?${actors}`
      )
      expect(response.status).toBe(400)
    } finally {
      restore()
    }
  })

  it('builds every embed shape the app knows how to render', () => {
    expect(embeds.external().$type).toBe('app.bsky.embed.external#view')
    expect(embeds.images(3).images).toHaveLength(3)
    expect(embeds.record().$type).toBe('app.bsky.embed.record#view')
    expect(embeds.recordWithMedia(embeds.images()).media).toMatchObject({
      $type: 'app.bsky.embed.images#view'
    })
    expect(embeds.unsupported().$type).toBe('app.bsky.embed.video#view')
  })
})

describe('the renderer bridge double', () => {
  // Interface by interface and method by method: a method the preload has and the double
  // lacks would leave a component test calling `undefined`.
  it('implements exactly the real preload surface', () => {
    const bridge = installBridge()
    try {
      expect(surface(bridge.api)).toEqual(surface(PRELOAD))
    } finally {
      bridge.restore()
    }
  })

  // What Electron does to everything that crosses: a component handing over a Svelte
  // state proxy fails here the way it fails in the app, and nothing the component gets
  // back is the double's own state.
  it('clones what crosses, in both directions', async () => {
    const bridge = installBridge({ accounts: [makeAccount({ did: 'did:plc:a' })] })
    try {
      await expect(
        bridge.api.Accounts.patch('did:plc:a', new Proxy({ muted: true }, {}))
      ).rejects.toThrow(/could not be cloned/)
      await expect(bridge.api.Feed.markRead(new Proxy([], {}))).rejects.toThrow(
        /could not be cloned/
      )

      const patched = await bridge.api.Accounts.patch('did:plc:a', { muted: true })
      patched.muted = false
      expect(bridge.state.accounts[0]?.muted).toBe(true)
    } finally {
      bridge.restore()
    }
  })

  it('answers the probe target file dialogs as if one was used', async () => {
    const file = { name: 'mine.json', text: '{}' }
    const bridge = installBridge({ openedFile: file })
    try {
      await expect(bridge.api.ProbeTargetsFile.save()).resolves.toBe('statusky-probe-targets.json')
      await expect(bridge.api.ProbeTargetsFile.open()).resolves.toEqual(file)
    } finally {
      bridge.restore()
    }

    const cancelled = installBridge()
    try {
      await expect(cancelled.api.ProbeTargetsFile.open()).resolves.toBeNull()
    } finally {
      cancelled.restore()
    }
  })

  /**
   * The one place the double reproduces main's logic rather than just its shape, so it is
   * held to main's answers: the same patches, through the real IPC boundary and through
   * the double, have to leave the same override behind — or be refused by both.
   */
  it.each<[string, ProbeTargets | null, 'stored' | 'none' | 'refused']>([
    [
      'a real override',
      { ...DEFAULT_PROBE_TARGETS, accounts: DEFAULT_PROBE_TARGETS.accounts.slice(0, 1) },
      'stored'
    ],
    ['an override identical to the defaults', structuredClone(DEFAULT_PROBE_TARGETS), 'none'],
    ['no override at all', null, 'none'],
    [
      'an invalid override',
      { ...DEFAULT_PROBE_TARGETS, accounts: [{ did: 'not a did', handle: 'x' }] },
      'refused'
    ]
  ])('handles %s the way main does', async (_name, probeTargets, expected) => {
    const harness = await createHarness({ tray: false })
    const bridge = installBridge()
    try {
      const outcomes = await Promise.all(
        [harness.api, bridge.api].map((api) =>
          api.Preferences.patch({ probeTargets }).then(
            (settings) => (settings.probeTargets === null ? 'none' : settings.probeTargets),
            () => 'refused'
          )
        )
      )
      const wanted = expected === 'stored' ? probeTargets : expected
      expect(outcomes).toEqual([wanted, wanted])
    } finally {
      bridge.restore()
      harness.dispose()
    }
  })

  it('pushes a new snapshot after every mutation', async () => {
    const bridge = installBridge({ accounts: [makeAccount({ did: 'did:plc:a' })] })
    const seen: unknown[] = []
    try {
      bridge.api.State.onChanged((state) => seen.push(state))

      await bridge.api.Accounts.patch('did:plc:a', { muted: true })
      await bridge.api.Preferences.patch({ theme: 'dark' })
      await bridge.api.Feed.markAllRead()

      expect(seen).toHaveLength(3)
      expect(bridge.state.accounts[0]?.muted).toBe(true)
      expect(bridge.state.settings.theme).toBe('dark')
    } finally {
      bridge.restore()
    }
  })

  // The real generated client rejects on failure, so the double has to as well.
  it('reports failures by rejecting, the way the generated client does', async () => {
    const bridge = installBridge({ resolveError: 'Profile not found' })
    try {
      await expect(bridge.api.Accounts.add('nobody')).rejects.toThrow('Profile not found')
      await expect(bridge.api.Accounts.remove('did:plc:nope')).rejects.toThrow(
        'That account is not being tracked.'
      )
    } finally {
      bridge.restore()
    }
  })

  it('restores whatever was on window.statusky before it', () => {
    const sentinel = { marker: true }
    ;(globalThis as Record<string, unknown>).statusky = sentinel

    const bridge = installBridge()
    expect((globalThis as Record<string, unknown>).statusky).toBe(bridge.api)

    bridge.restore()
    expect((globalThis as Record<string, unknown>).statusky).toBe(sentinel)
    delete (globalThis as Record<string, unknown>).statusky
  })

  it('unsubscribes cleanly', () => {
    const bridge = installBridge()
    const stop = bridge.api.State.onChanged(() => {})
    expect(bridge.listenerCount()).toBe(1)
    stop()
    expect(bridge.listenerCount()).toBe(0)
    bridge.restore()
  })
})

describe('the harness itself', () => {
  it('boots the whole main process against the doubles', async () => {
    const harness = await createHarness()
    try {
      expect(harness.state().accounts).toHaveLength(2)
      expect(harness.trayIcon()).not.toBeNull()
      expect(harness.browserWindow()).not.toBeNull()
      // And the preload's API reaches it, through the real IPC wiring.
      await expect(harness.api.State.get()).resolves.toEqual(harness.state())
    } finally {
      harness.dispose()
    }
  })

  it('can boot headless, with no tray or window', async () => {
    const harness = await createHarness({ tray: false, window: false })
    try {
      expect(harness.trayIcon()).toBeNull()
      expect(harness.browserWindow()).toBeNull()
    } finally {
      harness.dispose()
    }
  })

  it('records pushes and notification batches', async () => {
    const harness = await createHarness({
      tray: false,
      window: false,
      cursors: { [harnessDid]: '2026-01-01T00:00:00Z' }
    })
    try {
      harness.appview.setFeed({ did: harnessDid, handle: 'status.bsky.app' }, [
        rawPost(
          { did: harnessDid, handle: 'status.bsky.app' },
          {
            text: 'Investigating',
            createdAt: '2026-01-02T00:00:00Z'
          }
        )
      ])

      await harness.model.refresh()
      await flush()

      expect(harness.pushes.length).toBeGreaterThan(0)
      expect(harness.notified[0]).toHaveLength(1)
      expect(notifications).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  it('stops the network double when disposed', async () => {
    const before = globalThis.fetch
    const harness = await createHarness({ tray: false, window: false })
    expect(globalThis.fetch).not.toBe(before)
    harness.dispose()
    expect(globalThis.fetch).toBe(before)
  })
})

const harnessDid = 'did:plc:4dtbz2ivhp5app3sbntcccxc'

/**
 * The one double here that does not stand in for an Electron API. `update-electron-app`
 * is CommonJS in node_modules, so Vitest loads it through Node and its own
 * `require('electron')` escapes the alias that would hand it these doubles — it reads
 * `isPackaged` off a module that is a path string. Aliasing the package is the only seam,
 * which makes this file the boundary src/main/update.ts is actually tested against.
 */
describe('the update-electron-app double', () => {
  it('records the options it was handed, call by call', () => {
    updateElectronApp({ updateInterval: '6 hours' })

    expect(selfUpdaters).toHaveLength(1)
    expect(lastSelfUpdater().options.updateInterval).toBe('6 hours')
  })

  /**
   * The event the whole self-updating branch turns on, and the one a test could not
   * otherwise reach: in Electron it is minutes of background downloading.
   */
  it('delivers a finished download to the caller’s onNotifyUser', () => {
    const onNotifyUser = vi.fn()
    updateElectronApp({ onNotifyUser })

    lastSelfUpdater().finishDownload({ releaseName: '0.9.0' })

    expect(onNotifyUser).toHaveBeenCalledWith(expect.objectContaining({ releaseName: '0.9.0' }))
  })

  /** The macOS shape by default, so a test about Windows has to say it is about Windows. */
  it('defaults to the macOS arguments rather than Windows’', () => {
    const onNotifyUser = vi.fn()
    updateElectronApp({ onNotifyUser })

    lastSelfUpdater().finishDownload()

    expect(onNotifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ releaseName: '', releaseNotes: '' })
    )
  })

  it('can refuse to start, the way a bundle naming no repository does', () => {
    selfUpdateFailure.error = new Error('repo not found')

    expect(() => updateElectronApp()).toThrow('repo not found')
    expect(selfUpdaters).toHaveLength(0)
  })

  it('reports being stopped', () => {
    const updater = updateElectronApp()
    expect(updater.stopped).toBe(false)

    updater.stopUpdates()

    expect(updater.stopped).toBe(true)
  })

  it('refuses to hand back an updater that was never created', () => {
    expect(() => lastSelfUpdater()).toThrow(/has not been called/)
  })
})

describe('withPlatform', () => {
  it('pins and restores process.platform, even when the body throws', async () => {
    const original = process.platform

    await withPlatform('win32', () => {
      expect(process.platform).toBe('win32')
    })
    expect(process.platform).toBe(original)

    await expect(
      withPlatform('linux', () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(process.platform).toBe(original)
  })
})

describe('the factories', () => {
  it('produce self-consistent domain objects', () => {
    const post = makePost({ text: 'Investigating an outage' })
    expect(post.severity).toBe('investigating')
    expect(post.url).toContain(post.rkey)
    expect(post.rkey).toBe(post.uri.split('/').at(-1))
  })

  // Main validates every state it pushes against these schemas, so a builder that drifted
  // from them would have component tests rendering something the app can never send.
  it.each([
    ['makeAccount', accountSchema, makeAccount()],
    ['makePost', statusPostSchema, makePost()],
    [
      'makePost with an external embed',
      statusPostSchema,
      makePost({ embed: makeEmbed('external') })
    ],
    ['makePost with images', statusPostSchema, makePost({ embed: makeEmbed('images') })],
    ['makePost with a quoted record', statusPostSchema, makePost({ embed: makeEmbed('record') })],
    ['makeSettings', settingsSchema, makeSettings()],
    ['makeProfile', resolvedProfileSchema, makeProfile()],
    ['makeWebhookStatus', webhookStatusSchema, makeWebhookStatus()],
    ['makeNetworkSummary', networkSummarySchema, makeNetworkSummary()],
    ['makeCheck', probeCheckSchema, makeCheck()],
    ['makeService', serviceProbeSchema, makeService()],
    ['makeSnapshot', networkSnapshotSchema, makeSnapshot({ services: [makeService()] })],
    ['makeState', appStateSchema, makeState({ accounts: [makeAccount()], posts: [makePost()] })]
  ] as const)('%s passes the schema main validates it against', (_name, schema, value) => {
    expect(schema.safeParse(value).error?.issues).toBeUndefined()
  })

  it('generate unique identities', () => {
    expect(makeAccount().did).not.toBe(makeAccount().did)
    expect(makePost().uri).not.toBe(makePost().uri)
  })
})
