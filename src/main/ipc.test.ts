import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVICES } from '../shared/network'
import type { AppState, NetworkReveal, NetworkSnapshot } from '../shared/types'
import {
  clipboard,
  clipboardContents,
  FakeWebFrameMain,
  Notification,
  notifications,
  openedExternally,
  shell
} from '../test/electron'
import { BUILTIN_PROFILES, createHarness, seedFeed } from '../test/harness'
import type { Harness } from '../test/harness'
import { makePost } from '../test/factories'

const BSKY = BUILTIN_PROFILES.bsky
let harness: Harness

async function boot(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness({ tray: false, ...options })
  return harness
}

/** The frame the popover's calls appear to come from, which is what gets validated. */
function frame(h: Harness): FakeWebFrameMain {
  const window = h.browserWindow()
  if (!window) throw new Error('This harness has no window.')
  return window.webContents.mainFrame
}

afterEach(() => {
  harness?.dispose()
})

describe('origin validation', () => {
  it('accepts calls from the popover, served over app://statusky', async () => {
    const h = await boot()
    expect(frame(h).url).toBe('app://statusky/index.html')
    await expect(h.api.State.get()).resolves.toMatchObject({ version: h.state().version })
  })

  it('refuses a call from any other origin', async () => {
    const h = await boot()
    frame(h).url = 'https://status.example.test/'

    await expect(h.api.State.get()).rejects.toThrow(/did not pass origin validation/)
  })

  // file:// is one opaque origin shared by every local page, which is exactly why the
  // packaged renderer is served over app:// instead.
  it('refuses a call from a file:// page', async () => {
    const h = await boot()
    frame(h).url = 'file:///Applications/Statusky.app/Contents/index.html'

    await expect(h.api.State.get()).rejects.toThrow(/did not pass origin validation/)
  })

  it('refuses a sub-frame even on the right origin', async () => {
    const h = await boot()
    const popover = frame(h)
    popover.parent = new FakeWebFrameMain(popover.webContents, popover.url)

    await expect(h.api.State.get()).rejects.toThrow(/did not pass origin validation/)
  })

  it('refuses a frame with no URL at all', async () => {
    const h = await boot()
    frame(h).url = ''

    await expect(h.api.State.get()).rejects.toThrow(/did not pass origin validation/)
  })

  it('refuses a URL that cannot be parsed', async () => {
    const h = await boot()
    frame(h).url = ':://nonsense'

    await expect(h.api.State.get()).rejects.toThrow(/did not pass origin validation/)
  })

  // The production wiring is compiled with `is_packaged is true`, so a build running
  // from source cannot answer the packaged app's origin even if it claims it.
  it('refuses everything when the app is not packaged', async () => {
    const h = await boot({ packaged: false })
    await expect(h.api.State.get()).rejects.toThrow(/did not pass origin validation/)
  })

  it('applies to every interface, not just the first', async () => {
    const h = await boot()
    frame(h).url = 'https://status.example.test/'

    await expect(h.api.Feed.refresh()).rejects.toThrow(/did not pass origin validation/)
    await expect(h.api.Accounts.remove(BSKY.did)).rejects.toThrow(/did not pass origin/)
    await expect(h.api.Preferences.patch({ theme: 'dark' })).rejects.toThrow(/origin/)
    await expect(h.api.Actors.resolve(BSKY.handle)).rejects.toThrow(/origin/)
    await expect(h.api.Host.quit()).rejects.toThrow(/origin/)
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('re-attaches handlers when the popover is closed and reopened', async () => {
    const h = await boot()
    h.browserWindow()?.close()
    h.popover.show()

    await expect(h.api.State.get()).resolves.toMatchObject({ version: h.state().version })
  })
})

describe('argument validation', () => {
  it('refuses an argument of the wrong type', async () => {
    const h = await boot()
    await expect(h.api.Accounts.add(42 as never)).rejects.toThrow(/failed to pass validation/)
  })

  it('refuses a patch with a field the schema does not allow through', async () => {
    const h = await boot()
    await expect(h.api.Accounts.patch(BSKY.did, { muted: 'yes' } as never)).rejects.toThrow(
      /"patch" at position 1/
    )
    expect(h.state().accounts.find((a) => a.did === BSKY.did)?.muted).toBe(false)
  })

  it('refuses a settings patch whose values are the wrong shape', async () => {
    const h = await boot()
    await expect(h.api.Preferences.patch({ theme: 'neon' } as never)).rejects.toThrow(
      /failed to pass validation/
    )
  })

  it('refuses an array containing the wrong type', async () => {
    const h = await boot()
    await expect(h.api.Feed.markRead([1, 2] as never)).rejects.toThrow(/failed to pass validation/)
  })
})

describe('result validation', () => {
  it('refuses to hand the renderer a value that does not match the schema', async () => {
    const h = await boot()
    vi.spyOn(h.model, 'patchAccount').mockReturnValue({ did: 'did:plc:x' } as never)

    await expect(h.api.Accounts.patch(BSKY.did, { muted: true })).rejects.toThrow(
      /Result from method "patch" in interface "Accounts" failed to pass validation/
    )
  })
})

describe('state', () => {
  it('returns the current snapshot', async () => {
    const h = await boot()
    const state = await h.api.State.get()
    expect(state.accounts).toHaveLength(2)
    expect(state.version).toBe(h.state().version)
  })
})

describe('accounts', () => {
  it('adds an account', async () => {
    const h = await boot()
    h.appview.setFeed({ did: 'did:plc:new', handle: 'status.example.test' }, [])

    await expect(h.api.Accounts.add('status.example.test')).resolves.toMatchObject({
      did: 'did:plc:new'
    })
  })

  it('rejects with the reason when the handle cannot be resolved', async () => {
    const h = await boot()
    await expect(h.api.Accounts.add('nobody.invalid')).rejects.toThrow(/Profile not found/)
  })

  it('removes an account', async () => {
    const h = await boot()
    h.appview.setFeed({ did: 'did:plc:new', handle: 'status.example.test' }, [])
    await h.api.Accounts.add('status.example.test')

    await h.api.Accounts.remove('did:plc:new')

    expect(h.state().accounts.map((a) => a.did)).not.toContain('did:plc:new')
  })

  it('refuses to remove a builtin account', async () => {
    const h = await boot()
    await expect(h.api.Accounts.remove(BSKY.did)).rejects.toThrow(/muted but not removed/)
  })

  it('patches an account', async () => {
    const h = await boot()
    await expect(h.api.Accounts.patch(BSKY.did, { muted: true })).resolves.toMatchObject({
      muted: true
    })
  })
})

describe('settings', () => {
  it('patches and returns the sanitised settings', async () => {
    const h = await boot()
    await expect(h.api.Preferences.patch({ pollIntervalSec: 2 })).resolves.toMatchObject({
      pollIntervalSec: 15
    })
  })
})

describe('feed', () => {
  it('refreshes', async () => {
    const h = await boot()
    seedFeed(h.appview, BSKY, [{ text: 'All clear' }])

    await h.api.Feed.refresh()

    expect(h.state().posts).toHaveLength(1)
  })

  it('marks posts read', async () => {
    const post = makePost({ authorDid: BSKY.did })
    const h = await boot({ posts: [post], unread: [post.uri] })

    await h.api.Feed.markRead([post.uri])

    expect(h.state().unread).toEqual([])
  })

  it('marks a post and everything older than it read', async () => {
    const newer = makePost({ authorDid: BSKY.did, rkey: 'b', createdAt: '2026-09-06T00:00:00Z' })
    const older = makePost({ authorDid: BSKY.did, rkey: 'a', createdAt: '2026-09-02T00:00:00Z' })
    const h = await boot({ posts: [newer, older], unread: [newer.uri, older.uri] })

    await h.api.Feed.markReadThrough(older.uri)

    expect(h.state().unread).toEqual([newer.uri])
  })

  it('marks everything read', async () => {
    const post = makePost({ authorDid: BSKY.did })
    const h = await boot({ posts: [post], unread: [post.uri] })

    await h.api.Feed.markAllRead()

    expect(h.state().unread).toEqual([])
  })
})

describe('actors', () => {
  it('resolves a handle to a profile', async () => {
    const h = await boot()
    h.appview.addProfile({ ...BSKY, followersCount: 5, postsCount: 6 })

    await expect(h.api.Actors.resolve(BSKY.handle)).resolves.toMatchObject({
      did: BSKY.did,
      followersCount: 5
    })
  })

  it('rejects for an unknown handle', async () => {
    const h = await boot()
    await expect(h.api.Actors.resolve('nobody.invalid')).rejects.toThrow()
  })

  it('reports a rejection that is not an Error', async () => {
    const h = await boot()
    vi.spyOn(h.model, 'resolveActor').mockRejectedValue('a bare string')

    await expect(h.api.Actors.resolve('anything')).rejects.toThrow(/a bare string/)
  })
})

describe('opening links', () => {
  it('opens https links', async () => {
    const h = await boot()
    await h.api.Host.openExternal('https://bsky.app/profile/x')
    expect(openedExternally).toEqual(['https://bsky.app/profile/x'])
  })

  it('opens http links', async () => {
    const h = await boot()
    await h.api.Host.openExternal('http://example.test/')
    expect(shell.openExternal).toHaveBeenCalledWith('http://example.test/')
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'statusky://x', 'data:text/html,<b>'])(
    'refuses %s',
    async (url) => {
      const h = await boot()
      await expect(h.api.Host.openExternal(url)).rejects.toThrow(/http and https/)
      expect(openedExternally).toEqual([])
    }
  )

  it('rejects a value that is not a URL at all', async () => {
    const h = await boot()
    await expect(h.api.Host.openExternal('not a url')).rejects.toThrow()
    expect(openedExternally).toEqual([])
  })
})

describe('the clipboard', () => {
  it('copies through main, where the popover cannot lose focus mid-copy', async () => {
    const h = await boot()
    const url = 'http://127.0.0.1:7385/webhook/s3cr3t'

    await h.api.Host.copyText(url)

    expect(clipboard.writeText).toHaveBeenCalledWith(url)
    expect(clipboardContents.text).toBe(url)
  })
})

describe('test notification', () => {
  it('raises one', async () => {
    const h = await boot()
    await h.api.Host.sendTestNotification()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.options.title).toContain('Statusky')
  })

  it('honours the sound preference', async () => {
    const h = await boot({ settings: { notificationSound: false } })
    await h.api.Host.sendTestNotification()
    expect(notifications[0]?.options.silent).toBe(true)
  })

  // The whole point of the test button: a refused banner must not look like success.
  it('reports a refusal from the OS instead of claiming success', async () => {
    const h = await boot()
    Notification.failWith = "The operation couldn't be completed. (UNErrorDomain error 1.)"

    await expect(h.api.Host.sendTestNotification()).rejects.toThrow(/System Settings/)
  })
})

describe('window and app control', () => {
  it('hides the popover', async () => {
    const h = await boot()
    h.popover.show()
    expect(h.popover.isVisible()).toBe(true)

    await h.api.Host.hideWindow()

    expect(h.popover.isVisible()).toBe(false)
  })

  it('quits through the injected callback', async () => {
    const h = await boot()
    await h.api.Host.quit()
    expect(h.quit).toHaveBeenCalledTimes(1)
  })

  it('reports the host platform', async () => {
    const h = await boot()
    await expect(h.api.Host.getPlatform()).resolves.toBe(process.platform)
  })
})

describe('state pushes', () => {
  it('pushes a fresh snapshot to the renderer after every mutation', async () => {
    const h = await boot()
    const seen: AppState[] = []
    const stop = h.api.State.onChanged((state) => seen.push(state))

    await h.api.Accounts.patch(BSKY.did, { muted: true })
    await h.api.Feed.markAllRead()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.accounts.find((a) => a.did === BSKY.did)?.muted).toBe(true)
    stop()
  })

  it('stops delivering after the listener unsubscribes', async () => {
    const h = await boot()
    const listener = vi.fn()
    const stop = h.api.State.onChanged(listener)
    stop()

    await h.api.Accounts.patch(BSKY.did, { muted: true })

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not throw when there is no window to push to', async () => {
    const h = await boot({ window: false })
    expect(() => h.ipc.publish(h.state())).not.toThrow()
  })
})

describe('the network dashboard', () => {
  it('hands the popover the dashboard, and runs a sweep on request', async () => {
    const h = await boot()
    const snapshot = await h.api.Network.get()
    expect(snapshot.services.map((s) => s.state)).toEqual(Array(SERVICES.length).fill('pending'))
    // No transport in this harness, so a sweep is a no-op — but a permitted one.
    await expect(h.api.Network.run()).resolves.toBeUndefined()
  })

  it('pushes the dashboard to the renderer on its own channel', async () => {
    const h = await boot()
    const seen: NetworkSnapshot[] = []
    const stop = h.api.Network.onChanged((snapshot) => seen.push(snapshot))

    h.ipc.publishNetwork(h.model.networkSnapshot())

    expect(seen).toHaveLength(1)
    expect(seen[0]!.services).toHaveLength(SERVICES.length)
    stop()
  })

  it('asks the renderer to reveal the dashboard, at one service or none', async () => {
    const h = await boot()
    const seen: NetworkReveal[] = []
    const stop = h.api.Network.onReveal((target) => seen.push(target))

    h.ipc.revealNetwork('relay:bsky.network')
    h.ipc.revealNetwork(null)

    expect(seen).toEqual([{ serviceId: 'relay:bsky.network' }, { serviceId: null }])
    stop()
  })

  it('does not throw when there is no window to push to', async () => {
    const h = await boot({ window: false })
    expect(() => h.ipc.publishNetwork(h.model.networkSnapshot())).not.toThrow()
    expect(() => h.ipc.revealNetwork(null)).not.toThrow()
  })

  it('refuses a dashboard request from any other origin', async () => {
    const h = await boot()
    frame(h).url = 'https://evil.example/'
    await expect(h.api.Network.run()).rejects.toThrow()
    await expect(h.api.Network.get()).rejects.toThrow()
  })
})
