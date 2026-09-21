import { describe, expect, it, vi } from 'vitest'
import {
  BrowserWindow,
  Notification,
  exposed,
  ipcMain,
  ipcRenderer,
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
import { makeAccount, makePost, makeState } from './factories'

/**
 * The doubles are load-bearing: if one of them drifts from the API it stands in
 * for, every test above it becomes a lie. These tests pin their behaviour.
 */

// Captured before any `resetElectron` can clear it. The preload only exposes anything
// to a page on the popover's own origin, so that has to be in place before it loads.
const { resetPage } = await import('./page')
resetPage()
await import('../preload/index')
const PRELOAD_KEYS = Object.keys(exposed.get('statusky') as object).toSorted()

describe('the Electron double', () => {
  it('routes ipcRenderer.invoke to the matching ipcMain handler', async () => {
    ipcMain.handle('demo:echo', (_event, value) => `echo:${String(value)}`)
    await expect(ipcRenderer.invoke('demo:echo', 'hi')).resolves.toBe('echo:hi')
  })

  it('rejects an invoke with no handler, the way Electron does', async () => {
    await expect(ipcRenderer.invoke('demo:missing')).rejects.toThrow(/no handler registered/)
  })

  it('refuses a duplicate handler and honours removeHandler', async () => {
    ipcMain.handle('demo:once', () => 1)
    expect(() => ipcMain.handle('demo:once', () => 2)).toThrow(/second handler/)

    ipcMain.removeHandler('demo:once')
    ipcMain.handle('demo:once', () => 2)
    await expect(ipcRenderer.invoke('demo:once')).resolves.toBe(2)
  })

  it('delivers webContents.send to ipcRenderer listeners', () => {
    const listener = vi.fn()
    ipcRenderer.on('state:changed', listener)
    const window = new BrowserWindow()

    window.webContents.send('state:changed', { ok: true })

    expect(listener).toHaveBeenCalledWith(expect.anything(), { ok: true })
    expect(window.webContents.sent).toEqual([{ channel: 'state:changed', payload: { ok: true } }])
  })

  it('tracks window visibility and focus', () => {
    const window = new BrowserWindow({ width: 100, height: 50 })
    expect(window.isVisible()).toBe(false)

    window.show()
    expect(window.isVisible()).toBe(true)

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
    expect(onClick).toHaveBeenCalled()
  })

  it('records every externally opened URL', async () => {
    await shell.openExternal('https://bsky.app')
    expect(openedExternally).toEqual(['https://bsky.app'])
  })

  it('resets every register', () => {
    ipcMain.handle('demo:x', () => 1)
    void new Notification({})
    void new BrowserWindow()

    resetElectron()

    expect(ipcMain.handlers.size).toBe(0)
    expect(notifications).toHaveLength(0)
    expect(BrowserWindow.instances).toHaveLength(0)
    expect(trays).toHaveLength(0)
    expect(openedExternally).toHaveLength(0)
  })
})

describe('the electron-store double', () => {
  it('falls back to defaults for keys that were never written', () => {
    const store = new FakeElectronStore({ name: 'a', defaults: { count: 1, list: [] } })
    expect(store.get('count')).toBe(1)
    expect(store.has('count')).toBe(true)
    expect(store.get('missing' as never, 'fallback' as never)).toBe('fallback')
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

  it('records writes, deletes and clears', () => {
    const store = new FakeElectronStore({ name: 'c', defaults: { a: 1 } })
    store.set('a', 2)
    expect(store.writes).toEqual(['a'])

    store.delete('a')
    expect(store.get('a')).toBe(1)

    store.set({ a: 5, b: 6 } as never)
    expect(store.store).toMatchObject({ a: 5, b: 6 })

    store.clear()
    expect(store.get('a')).toBe(1)
  })

  it('serves seeded contents to the next store of that name', () => {
    seedStore('seeded', { hello: 'world' })
    const store = new FakeElectronStore({ name: 'seeded', defaults: { hello: 'default' } })
    expect(store.get('hello')).toBe('world')
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

  it('404s an actor it has never heard of', async () => {
    const appview = new FakeAppView()
    const restore = appview.install()
    try {
      const response = await fetch(
        'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=nobody.test'
      )
      expect(response.status).toBe(400)
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
    expect(embeds.recordWithMedia(embeds.images()).media).toBeDefined()
    expect(embeds.unsupported().$type).toBe('app.bsky.embed.video#view')
  })
})

describe('the renderer bridge double', () => {
  it('implements exactly the real preload surface', () => {
    const bridge = installBridge()
    try {
      expect(Object.keys(bridge.api).toSorted()).toEqual(PRELOAD_KEYS)
    } finally {
      bridge.restore()
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
      expect(harness.api).toBeDefined()
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
  it('produce valid, self-consistent domain objects', () => {
    const account = makeAccount()
    expect(account.did).toMatch(/^did:plc:/)

    const post = makePost({ text: 'Investigating an outage' })
    expect(post.severity).toBe('investigating')
    expect(post.url).toContain(post.rkey)
    expect(post.rkey).toBe(post.uri.split('/').at(-1))

    const state = makeState()
    expect(state).toMatchObject({ accounts: [], posts: [], unread: [] })
  })

  it('generate unique identities', () => {
    expect(makeAccount().did).not.toBe(makeAccount().did)
    expect(makePost().uri).not.toBe(makePost().uri)
  })
})
