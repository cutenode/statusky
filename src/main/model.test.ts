import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BskyError } from '../shared/bsky'
import { DEFAULT_SETTINGS } from '../shared/defaults'
import type { Account } from '../shared/types'
import { BUILTIN_PROFILES, createHarness, createModel, flush, seedFeed } from '../test/harness'
import { FakeAppView, rawPost } from '../test/appview'
import { makeAccount, makePost } from '../test/factories'
import type { Harness } from '../test/harness'

const BSKY = BUILTIN_PROFILES.bsky
const BLACKSKY = BUILTIN_PROFILES.blacksky

let harness: Harness

async function boot(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness({ tray: false, window: false, ...options })
  return harness
}

afterEach(() => {
  harness?.dispose()
})

describe('getState', () => {
  it('exposes accounts, visible posts, settings and version', async () => {
    const h = await boot()
    const state = h.state()

    expect(state.version).toBe('0.1.0-test')
    expect(state.accounts.map((a) => a.handle)).toEqual([BSKY.handle, BLACKSKY.handle])
    expect(state.settings).toEqual(DEFAULT_SETTINGS)
    expect(state.sync).toEqual({ status: 'idle', lastSyncedAt: null, error: null })
  })

  it('hides posts from muted accounts and prunes their unread entries', async () => {
    const post = makePost({ authorDid: BSKY.did })
    const h = await boot({ posts: [post], unread: [post.uri] })

    expect(h.state().posts).toHaveLength(1)
    expect(h.state().unread).toEqual([post.uri])

    h.model.patchAccount(BSKY.did, { muted: true })

    expect(h.state().posts).toHaveLength(0)
    expect(h.state().unread).toHaveLength(0)
  })

  it('drops unread entries whose posts are gone', async () => {
    const h = await boot({ unread: ['at://did:plc:gone/app.bsky.feed.post/x'] })
    expect(h.state().unread).toEqual([])
  })

  it('counts unread from visible accounts only', async () => {
    const visible = makePost({ authorDid: BSKY.did, rkey: 'a' })
    const hidden = makePost({ authorDid: BLACKSKY.did, rkey: 'b' })
    const h = await boot({
      posts: [visible, hidden],
      unread: [visible.uri, hidden.uri],
      accounts: [makeAccount({ did: BLACKSKY.did, handle: BLACKSKY.handle, muted: true })]
    })

    expect(h.model.unreadCount).toBe(1)
  })
})

describe('addAccount', () => {
  it('resolves, persists and starts tracking a new account', async () => {
    const h = await boot()
    h.appview.setFeed({ did: 'did:plc:new', handle: 'status.example.test' }, [])

    const account = await h.model.addAccount('@Status.Example.Test')

    expect(account.did).toBe('did:plc:new')
    expect(account.builtin).toBe(false)
    expect(account.notify).toBe(true)
    expect(h.store.get('accounts').map((a) => a.did)).toContain('did:plc:new')
  })

  it('accepts a bsky.app profile link', async () => {
    const h = await boot()
    h.appview.setFeed({ did: 'did:plc:new', handle: 'status.example.test' }, [])

    const account = await h.model.addAccount('https://bsky.app/profile/status.example.test')
    expect(account.handle).toBe('status.example.test')
  })

  it('rejects an account that is already tracked', async () => {
    const h = await boot()
    await expect(h.model.addAccount(BSKY.handle)).rejects.toThrow(/already being tracked/)
  })

  it('unmutes rather than rejecting when the account was hidden', async () => {
    const h = await boot({
      accounts: [makeAccount({ did: BSKY.did, handle: BSKY.handle, muted: true, builtin: true })]
    })

    const account = await h.model.addAccount(BSKY.handle)

    expect(account.muted).toBe(false)
    expect(h.state().accounts.find((a) => a.did === BSKY.did)?.muted).toBe(false)
  })

  it('surfaces a resolution failure', async () => {
    const h = await boot()
    await expect(h.model.addAccount('nobody.invalid')).rejects.toThrow(/Profile not found/)
    expect(h.state().accounts).toHaveLength(2)
  })

  it('rejects empty input before hitting the network', async () => {
    const h = await boot()
    await expect(h.model.addAccount('   ')).rejects.toBeInstanceOf(BskyError)
    expect(h.appview.requests).toHaveLength(0)
  })
})

describe('removeAccount', () => {
  it('forgets the account, its posts and its cursor', async () => {
    const custom = makeAccount({ did: 'did:plc:custom', handle: 'custom.test' })
    const post = makePost({ authorDid: custom.did })
    const h = await boot({
      accounts: [custom],
      posts: [post],
      cursors: { [custom.did]: post.createdAt }
    })

    h.model.removeAccount(custom.did)

    expect(h.state().accounts.map((a) => a.did)).not.toContain(custom.did)
    expect(h.store.get('posts')).toHaveLength(0)
    expect(h.store.get('cursors')).toEqual({})
  })

  it('refuses to remove a builtin account', async () => {
    const h = await boot()
    expect(() => h.model.removeAccount(BSKY.did)).toThrow(/can be muted but not removed/)
  })

  it('refuses an unknown account', async () => {
    const h = await boot()
    expect(() => h.model.removeAccount('did:plc:nope')).toThrow(/not being tracked/)
  })
})

describe('patchAccount', () => {
  it('applies the patch and returns the updated account', async () => {
    const h = await boot()
    const updated = h.model.patchAccount(BSKY.did, { notify: false })
    expect(updated.notify).toBe(false)
    expect(h.store.get('accounts').find((a) => a.did === BSKY.did)?.notify).toBe(false)
  })

  it('rejects an unknown account', async () => {
    const h = await boot()
    expect(() => h.model.patchAccount('did:plc:nope', { muted: true })).toThrow(/not being tracked/)
  })
})

describe('patchSettings', () => {
  it('merges and persists', async () => {
    const h = await boot()
    const next = h.model.patchSettings({ notificationsEnabled: false })
    expect(next.notificationsEnabled).toBe(false)
    expect(h.store.get('settings').notificationsEnabled).toBe(false)
  })

  it('clamps out-of-range values', async () => {
    const h = await boot()
    expect(h.model.patchSettings({ pollIntervalSec: 1 }).pollIntervalSec).toBe(15)
    expect(h.model.patchSettings({ pollIntervalSec: 99_999 }).pollIntervalSec).toBe(3600)
    expect(h.model.patchSettings({ postsPerAccount: 0 }).postsPerAccount).toBe(5)
    expect(h.model.patchSettings({ postsPerAccount: 5000 }).postsPerAccount).toBe(100)
  })

  it('restarts the poll timer only when the interval changes', async () => {
    vi.useFakeTimers()
    try {
      const h = await boot()
      const refresh = vi.spyOn(h.model, 'refresh').mockResolvedValue()

      h.model.patchSettings({ pollIntervalSec: 30 })
      vi.advanceTimersByTime(30_000)
      expect(refresh).toHaveBeenCalledTimes(1)

      h.model.patchSettings({ notificationSound: false })
      vi.advanceTimersByTime(30_000)
      expect(refresh).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('unread bookkeeping', () => {
  it('marks specific posts read', async () => {
    const a = makePost({ authorDid: BSKY.did, rkey: 'a' })
    const b = makePost({ authorDid: BSKY.did, rkey: 'b' })
    const h = await boot({ posts: [a, b], unread: [a.uri, b.uri] })

    h.model.markRead([a.uri])
    expect(h.state().unread).toEqual([b.uri])
  })

  it('ignores an empty mark-read and does not push a state change', async () => {
    const h = await boot()
    const before = h.pushes.length
    h.model.markRead([])
    expect(h.pushes).toHaveLength(before)
  })

  it('marks one post and everything older than it read, across sources', async () => {
    const newest = makePost({ authorDid: BSKY.did, rkey: 'c', createdAt: '2026-09-06T00:00:00Z' })
    const middle = makePost({
      authorDid: BLACKSKY.did,
      rkey: 'b',
      createdAt: '2026-09-04T00:00:00Z'
    })
    const oldest = makePost({ authorDid: BSKY.did, rkey: 'a', createdAt: '2026-09-02T00:00:00Z' })
    const h = await boot({
      posts: [newest, middle, oldest],
      unread: [newest.uri, middle.uri, oldest.uri]
    })

    h.model.markReadThrough(middle.uri)

    expect(h.state().unread).toEqual([newest.uri])
  })

  it('ignores a mark-read-through for a post it does not have', async () => {
    const post = makePost({ authorDid: BSKY.did })
    const h = await boot({ posts: [post], unread: [post.uri] })

    h.model.markReadThrough('at://did:plc:gone/app.bsky.feed.post/x')

    expect(h.state().unread).toEqual([post.uri])
  })

  it("forgets a removed account's read cursor", async () => {
    const account = makeAccount({ did: 'did:plc:temporary', handle: 'temp.test' })
    const post = makePost({ authorDid: account.did })
    const h = await boot({ accounts: [account], posts: [post], unread: [post.uri] })

    h.model.removeAccount(account.did)

    expect(h.store.get('read').cursors).not.toHaveProperty(account.did)
    expect(h.store.get('read').above).toEqual([])
  })

  it('marks everything read, and no-ops when already empty', async () => {
    const post = makePost({ authorDid: BSKY.did })
    const h = await boot({ posts: [post], unread: [post.uri] })

    h.model.markAllRead()
    expect(h.state().unread).toEqual([])

    const before = h.pushes.length
    h.model.markAllRead()
    expect(h.pushes).toHaveLength(before)
  })
})

describe('refresh', () => {
  it('fetches every account and merges the results', async () => {
    const h = await boot()
    seedFeed(h.appview, BSKY, [{ text: 'Investigating', createdAt: '2026-01-02T10:00:00Z' }])
    seedFeed(h.appview, BLACKSKY, [{ text: 'Resolved', createdAt: '2026-01-02T11:00:00Z' }])

    await h.model.refresh()

    const posts = h.state().posts
    expect(posts).toHaveLength(2)
    // Newest first.
    expect(posts[0]?.severity).toBe('resolved')
    expect(h.state().sync.status).toBe('idle')
    expect(h.state().sync.lastSyncedAt).not.toBeNull()
  })

  it('asks for the configured number of posts, without replies', async () => {
    const h = await boot({ settings: { postsPerAccount: 7 } })
    await h.model.refresh()

    const request = h.appview.requestsFor('app.bsky.feed.getAuthorFeed')[0]
    expect(request?.params.get('limit')).toBe('7')
    expect(request?.params.get('filter')).toBe('posts_no_replies')
  })

  it('shares one in-flight run between concurrent callers', async () => {
    const h = await boot()
    h.appview.latencyMs = 5

    await Promise.all([h.model.refresh(), h.model.refresh(), h.model.refresh()])

    expect(h.appview.requestsFor('app.bsky.feed.getAuthorFeed')).toHaveLength(2)
  })

  it('publishes a syncing state before the results land', async () => {
    const h = await boot()
    h.appview.latencyMs = 5
    const pending = h.model.refresh()
    expect(h.state().sync.status).toBe('syncing')
    await pending
    expect(h.state().sync.status).toBe('idle')
  })

  it('keeps working when one account fails', async () => {
    const h = await boot()
    seedFeed(h.appview, BSKY, [{ text: 'All clear' }])
    h.appview.fail(BLACKSKY.did, { kind: 'http', status: 502, body: { message: 'Bad gateway' } })

    await h.model.refresh()

    expect(h.state().posts).toHaveLength(1)
    expect(h.state().sync.status).toBe('idle')
    expect(h.state().sync.error).toContain(`@${BLACKSKY.handle}: Bad gateway`)
  })

  it('reports an error state when every account fails', async () => {
    const h = await boot()
    h.appview.fail(BSKY.did, { kind: 'network', message: 'offline' })
    h.appview.fail(BLACKSKY.did, { kind: 'network', message: 'offline' })

    await h.model.refresh()

    expect(h.state().sync.status).toBe('error')
    expect(h.state().sync.error).toContain('offline')
    expect(h.state().sync.lastSyncedAt).toBeNull()
  })

  it('times a hung account out rather than hanging the sync', async () => {
    vi.useFakeTimers()
    try {
      const h = await boot()
      h.appview.fail(BSKY.did, { kind: 'hang' })
      h.appview.fail(BLACKSKY.did, { kind: 'hang' })

      const pending = h.model.refresh()
      await vi.advanceTimersByTimeAsync(15_000)
      await pending

      expect(h.state().sync.status).toBe('error')
      expect(h.state().sync.error).toContain('Timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing but stamp the clock when no accounts are tracked', async () => {
    const { model, store } = createModel()
    await model.refresh()
    expect(model.getState().sync.lastSyncedAt).not.toBeNull()
    expect(store.get('posts')).toEqual([])
  })

  it('drops reposts and replies', async () => {
    const h = await boot()
    seedFeed(h.appview, BSKY, [{ text: 'Own post' }])
    h.appview.addRepost(BSKY, rawPost(BLACKSKY, { text: 'Somebody else' }))

    await h.model.refresh()

    expect(h.state().posts.map((p) => p.text)).toEqual(['Own post'])
  })

  it('caps the stored posts', async () => {
    const h = await boot()
    const many = Array.from({ length: 520 }, (_, i) => ({
      text: `Update ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    }))
    seedFeed(h.appview, BSKY, many)

    await h.model.refresh()

    expect(h.store.get('posts').length).toBeLessThanOrEqual(500)
  })
})

describe('notifications and unread on sync', () => {
  it('seeds cursors silently on the very first sync', async () => {
    const h = await boot()
    seedFeed(h.appview, BSKY, [{ text: 'Investigating', createdAt: '2026-01-02T10:00:00Z' }])

    await h.model.refresh()

    expect(h.notified).toHaveLength(0)
    expect(h.state().unread).toHaveLength(0)
    expect(h.store.get('cursors')[BSKY.did]).toBe('2026-01-02T10:00:00Z')
  })

  it('notifies and marks unread for posts newer than the cursor', async () => {
    const h = await boot({ cursors: { [BSKY.did]: '2026-01-02T09:00:00.000Z' } })
    seedFeed(h.appview, BSKY, [
      { text: 'Investigating login failures', createdAt: '2026-01-02T10:00:00Z' }
    ])

    await h.model.refresh()

    expect(h.notified[0]?.map((p) => p.text)).toEqual(['Investigating login failures'])
    expect(h.state().unread).toHaveLength(1)
  })

  it('respects the master notification switch but still marks unread', async () => {
    const h = await boot({
      cursors: { [BSKY.did]: '2026-01-02T09:00:00.000Z' },
      settings: { notificationsEnabled: false }
    })
    seedFeed(h.appview, BSKY, [{ text: 'Outage', createdAt: '2026-01-02T10:00:00Z' }])

    await h.model.refresh()

    expect(h.notified).toHaveLength(0)
    expect(h.state().unread).toHaveLength(1)
  })

  it('does not notify for an account with notifications off', async () => {
    const h = await boot({
      accounts: [
        makeAccount({ did: BSKY.did, handle: BSKY.handle, builtin: true, notify: false }),
        makeAccount({ did: BLACKSKY.did, handle: BLACKSKY.handle, builtin: true })
      ],
      cursors: { [BSKY.did]: '2026-01-02T09:00:00.000Z' }
    })
    seedFeed(h.appview, BSKY, [{ text: 'Outage', createdAt: '2026-01-02T10:00:00Z' }])

    await h.model.refresh()

    expect(h.notified).toHaveLength(0)
    expect(h.state().unread).toHaveLength(1)
  })

  it('hands posts to the notifier oldest first', async () => {
    const h = await boot({ cursors: { [BSKY.did]: '2026-01-02T00:00:00.000Z' } })
    seedFeed(h.appview, BSKY, [
      { text: 'Second outage', createdAt: '2026-01-02T11:00:00Z' },
      { text: 'First outage', createdAt: '2026-01-02T10:00:00Z' }
    ])

    await h.model.refresh()

    expect(h.notified[0]?.map((p) => p.text)).toEqual(['First outage', 'Second outage'])
  })
})

describe('profile refresh', () => {
  it('adopts a renamed handle and a new avatar', async () => {
    const h = await boot()
    h.appview.addProfile({
      ...BSKY,
      handle: 'status.bsky.social',
      displayName: 'Bluesky Status (new)',
      avatar: 'https://cdn.bsky.app/avatar.jpg'
    })

    await h.model.refresh()
    await flush()

    const account = h.state().accounts.find((a) => a.did === BSKY.did)
    expect(account?.handle).toBe('status.bsky.social')
    expect(account?.avatar).toBe('https://cdn.bsky.app/avatar.jpg')
  })

  it('leaves accounts alone when nothing changed', async () => {
    const h = await boot()
    await h.model.refresh()
    await flush()
    const pushes = h.pushes.length

    await h.model.refresh()
    await flush()

    // One push for `syncing`, one for the results — no third for identical profiles.
    expect(h.pushes.length - pushes).toBe(2)
  })

  it('never turns a profile failure into a sync error', async () => {
    const h = await boot()
    seedFeed(h.appview, BSKY, [{ text: 'All clear' }])
    h.appview.fail(BSKY.did, { kind: 'http', status: 500 })
    h.appview.fail(BLACKSKY.did, { kind: 'http', status: 500 })

    // Feeds succeed, profiles fail: only `getProfiles` is broken here.
    h.appview.clearFailures()
    const original = h.appview.fetch
    vi.spyOn(h.appview, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('getProfiles')) throw new TypeError('offline')
      return original(input, init)
    })

    await h.model.refresh()
    await flush()

    expect(h.state().sync.error).toBeNull()
  })

  it('chunks profile lookups at the AppView limit of 25', async () => {
    const accounts: Account[] = Array.from({ length: 30 }, (_, i) =>
      makeAccount({ did: `did:plc:bulk${i}`, handle: `bulk${i}.test` })
    )
    const { model } = createModel({ accounts })
    const appview = new FakeAppView()
    for (const account of accounts) {
      appview.setFeed({ did: account.did, handle: account.handle }, [])
    }
    const restore = appview.install()
    try {
      await model.refresh()
      await flush()
      const calls = appview.requestsFor('app.bsky.actor.getProfiles')
      expect(calls).toHaveLength(2)
      expect(calls[0]?.actors).toHaveLength(25)
      expect(calls[1]?.actors).toHaveLength(5)
    } finally {
      restore()
      model.stop()
    }
  })
})

describe('the poll timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes immediately and then on the interval', async () => {
    const h = await boot({ settings: { pollIntervalSec: 60 } })
    const refresh = vi.spyOn(h.model, 'refresh').mockResolvedValue()

    h.model.start()
    expect(refresh).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(180_000)
    expect(refresh).toHaveBeenCalledTimes(4)
  })

  it('stops cleanly and stays stopped', async () => {
    const h = await boot({ settings: { pollIntervalSec: 30 } })
    const refresh = vi.spyOn(h.model, 'refresh').mockResolvedValue()

    h.model.start()
    h.model.stop()
    h.model.stop()
    vi.advanceTimersByTime(300_000)

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('exposes the current sync status', async () => {
    const h = await boot()
    expect(h.model.syncStatus).toBe('idle')
  })
})

describe('edge cases in the sync pipeline', () => {
  it('still reports a sync error when the transport rejects with a non-Error', async () => {
    const h = await boot()
    h.appview.fail(BSKY.did, { kind: 'raw', value: 'something odd happened' })
    h.appview.fail(BLACKSKY.did, { kind: 'raw', value: 'something odd happened' })

    await h.model.refresh()

    expect(h.state().sync.status).toBe('error')
    // `xrpc` stringifies a cause that is not an `Error` rather than reaching for a
    // `.message` it does not have.
    expect(h.state().sync.error).toContain('Network request failed: something odd happened')
  })

  it('ignores incoming posts from accounts it no longer tracks', async () => {
    const { model, store } = createModel({
      accounts: [makeAccount({ did: DID_TRACKED, handle: 'tracked.test' })],
      posts: [
        makePost({ authorDid: DID_TRACKED, rkey: 'keep' }),
        makePost({ authorDid: 'did:plc:stale', rkey: 'drop' })
      ]
    })
    const appview = new FakeAppView()
    appview.setFeed({ did: DID_TRACKED, handle: 'tracked.test' }, [])
    const restore = appview.install()
    try {
      await model.refresh()
      expect(store.get('posts').map((p) => p.rkey)).toEqual(['keep'])
    } finally {
      restore()
      model.stop()
    }
  })

  it('does not move a cursor for a post with an unparseable timestamp', async () => {
    const h = await boot()
    seedFeed(h.appview, BSKY, [{ text: 'Broken clock', createdAt: 'not-a-date' }])

    await h.model.refresh()

    expect(h.store.get('cursors')[BSKY.did]).toBeUndefined()
  })
})

const DID_TRACKED = 'did:plc:tracked'
