import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeAccount,
  makeNetworkSummary,
  makePost,
  makeService,
  makeSettings,
  makeSnapshot,
  makeState
} from '../../../test/factories'
import { installBridge, type TestBridge } from '../../../test/bridge'
import { PROBE_SOURCE_DID, probeAccount } from '@shared/network'
import { webhookAccount } from '@shared/webhook'
import { HEALTH_LABEL } from '@shared/status'
import { app } from './app-state.svelte'
import { nav } from './nav.svelte'

/**
 * The renderer store is a singleton, so each test re-points it at a fresh bridge
 * and re-runs `init()` — the same sequence the popover performs on load.
 */

let bridge: TestBridge
let stop: (() => void) | null = null

async function connect(state: Parameters<typeof installBridge>[0] = {}): Promise<TestBridge> {
  bridge = installBridge(state)
  stop = await app.init()
  return bridge
}

afterEach(() => {
  stop?.()
  stop = null
  bridge?.restore()
  nav.reset()
})

describe('init', () => {
  it('pulls the initial state and reports ready', async () => {
    const account = makeAccount()
    await connect({ accounts: [account], version: '1.2.3' })

    expect(app.ready).toBe(true)
    expect(app.accounts).toHaveLength(1)
    expect(app.version).toBe('1.2.3')
  })

  it('subscribes to pushes and applies them', async () => {
    const local = await connect()
    const post = makePost()

    local.push({ posts: [post] })

    expect(app.posts).toHaveLength(1)
    expect(app.posts[0]?.uri).toBe(post.uri)
  })

  it('returns an unsubscribe that stops further updates', async () => {
    const local = await connect()
    stop?.()
    stop = null

    local.push({ posts: [makePost()] })

    expect(app.posts).toHaveLength(0)
  })
})

describe('unread tracking', () => {
  it('counts unread and answers per-post questions', async () => {
    const read = makePost({ rkey: 'read' })
    const unread = makePost({ rkey: 'unread' })
    await connect({ posts: [read, unread], unread: [unread.uri] })

    expect(app.unreadCount).toBe(1)
    expect(app.isUnread(unread.uri)).toBe(true)
    expect(app.isUnread(read.uri)).toBe(false)
  })

  it('groups unread counts by account', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    const b = makeAccount({ did: 'did:plc:b' })
    const posts = [
      makePost({ authorDid: a.did, rkey: '1' }),
      makePost({ authorDid: a.did, rkey: '2' }),
      makePost({ authorDid: b.did, rkey: '3' })
    ]
    await connect({ accounts: [a, b], posts, unread: [posts[0]!.uri, posts[2]!.uri] })

    expect(app.unreadByAccount.get(a.did)).toBe(1)
    expect(app.unreadByAccount.get(b.did)).toBe(1)
  })

  it('leaves an account out of the map when it has nothing unread', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    await connect({ accounts: [a], posts: [makePost({ authorDid: a.did })] })

    expect(app.unreadByAccount.get(a.did)).toBeUndefined()
  })
})

describe('splitting the feed by source', () => {
  const status = makeAccount({ did: 'did:plc:a', handle: 'status.example.test' })
  const page = webhookAccount(
    { id: 'webhook:page', host: 'status.hosted.test', url: null, description: null },
    '2026-01-01T00:00:00Z'
  )
  const probe = probeAccount('2026-01-01T00:00:00Z')

  const posted = makePost({ authorDid: status.did, rkey: 'posted' })
  const pushed = makePost({ authorDid: page.did, rkey: 'pushed' })
  const measured = makePost({ authorDid: PROBE_SOURCE_DID, rkey: 'measured' })

  const mixed = {
    accounts: [status, page, probe],
    posts: [posted, pushed, measured]
  }

  it('keeps the status accounts to the feed', async () => {
    await connect(mixed)
    expect(app.feedPosts.map((p) => p.uri)).toEqual([posted.uri])
  })

  it('files pushed deliveries and measurements as alerts', async () => {
    await connect(mixed)
    expect(app.alertPosts.map((p) => p.uri)).toEqual([pushed.uri, measured.uri])
  })

  it('splits the sources the same way, for each tab’s chips', async () => {
    await connect(mixed)
    expect(app.feedAccounts.map((a) => a.did)).toEqual([status.did])
    expect(app.alertAccounts.map((a) => a.did)).toEqual([page.did, PROBE_SOURCE_DID])
  })

  it('counts unread per tab, and keeps the whole list for the unread tab', async () => {
    await connect({ ...mixed, unread: [posted.uri, measured.uri] })

    expect(app.unreadCount).toBe(2)
    expect(app.feedUnreadCount).toBe(1)
    expect(app.alertUnreadCount).toBe(1)
    expect(app.unreadUris).toEqual([posted.uri, measured.uri])
    expect(app.unreadPosts.map((p) => p.uri)).toEqual([posted.uri, measured.uri])
  })

  it('follows a push rather than caching the first split it saw', async () => {
    const local = await connect(mixed)

    local.push({ posts: [posted] })

    expect(app.alertPosts).toEqual([])
    expect(app.feedPosts.map((p) => p.uri)).toEqual([posted.uri])
  })
})

describe('health rollups', () => {
  it('derives health per account from its newest post', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    const b = makeAccount({ did: 'did:plc:b' })
    await connect({
      accounts: [a, b],
      posts: [
        makePost({ authorDid: a.did, severity: 'outage', createdAt: '2026-01-02T00:00:00Z' }),
        makePost({ authorDid: b.did, severity: 'resolved', createdAt: '2026-01-02T00:00:00Z' })
      ]
    })

    expect(app.healthByAccount.get(a.did)).toBe('incident')
    expect(app.healthByAccount.get(b.did)).toBe('operational')
  })

  it('reports unknown for an account with no posts', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    await connect({ accounts: [a] })
    expect(app.healthByAccount.get(a.did)).toBe('unknown')
    expect(app.overall).toBe('unknown')
  })

  it('rolls the worst visible state up into `overall`', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    const b = makeAccount({ did: 'did:plc:b' })
    await connect({
      accounts: [a, b],
      posts: [
        makePost({ authorDid: a.did, severity: 'outage' }),
        makePost({ authorDid: b.did, severity: 'resolved' })
      ]
    })

    expect(app.overall).toBe('incident')
  })

  it('ignores muted accounts in the rollup', async () => {
    const muted = makeAccount({ did: 'did:plc:a', muted: true })
    const fine = makeAccount({ did: 'did:plc:b' })
    await connect({
      accounts: [muted, fine],
      posts: [
        makePost({ authorDid: muted.did, severity: 'outage' }),
        makePost({ authorDid: fine.did, severity: 'resolved' })
      ]
    })

    expect(app.overall).toBe('operational')
  })

  it('recomputes when a push arrives', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    const local = await connect({ accounts: [a] })
    expect(app.overall).toBe('unknown')

    local.push({ posts: [makePost({ authorDid: a.did, severity: 'degraded' })] })

    expect(app.overall).toBe('incident')
  })
})

describe('actions', () => {
  it('forwards each action to the bridge', async () => {
    const local = await connect({ accounts: [makeAccount({ did: 'did:plc:a' })] })

    await app.refresh()
    await app.patchAccount('did:plc:a', { muted: true })
    await app.patchSettings({ theme: 'dark' })
    await app.markRead(['at://x'])
    await app.markAllRead()
    await app.testNotification()
    app.openExternal('https://bsky.app')

    expect(local.api.Feed.refresh).toHaveBeenCalled()
    expect(local.api.Accounts.patch).toHaveBeenCalledWith('did:plc:a', { muted: true })
    expect(local.api.Preferences.patch).toHaveBeenCalledWith({ theme: 'dark' })
    expect(local.api.Feed.markRead).toHaveBeenCalledWith(['at://x'])
    expect(local.api.Feed.markAllRead).toHaveBeenCalled()
    expect(local.api.Host.sendTestNotification).toHaveBeenCalled()
    expect(local.api.Host.openExternal).toHaveBeenCalledWith('https://bsky.app')
  })

  it('returns the value on success', async () => {
    await connect()
    const account = await app.addAccount('status.example.test')
    expect(account?.handle).toBe('status.example.test')
    expect(app.actionError).toBeNull()
  })

  it('surfaces a failed action as an inline error instead of throwing', async () => {
    await connect({ resolveError: 'Profile not found' })

    const account = await app.addAccount('nobody.invalid')

    expect(account).toBeNull()
    expect(app.actionError).toBe('Profile not found')
  })

  it('catches a bridge that rejects outright', async () => {
    const local = await connect()
    vi.mocked(local.api.Feed.refresh).mockRejectedValueOnce(new Error('IPC exploded'))

    await app.refresh()

    expect(app.actionError).toBe('IPC exploded')
  })

  it('stringifies a non-Error rejection', async () => {
    const local = await connect()
    vi.mocked(local.api.Feed.markAllRead).mockRejectedValueOnce('just a string')

    await app.markAllRead()

    expect(app.actionError).toBe('just a string')
  })

  it('clears the error on the next action and on request', async () => {
    const local = await connect({ resolveError: 'Profile not found' })
    await app.addAccount('nobody.invalid')
    expect(app.actionError).not.toBeNull()

    app.clearError()
    expect(app.actionError).toBeNull()

    await app.addAccount('nobody.invalid')
    expect(app.actionError).not.toBeNull()

    vi.mocked(local.api.Feed.refresh).mockResolvedValueOnce(undefined)
    await app.refresh()
    expect(app.actionError).toBeNull()
  })

  it('marks itself busy for the duration of an action', async () => {
    const local = await connect()
    let busyDuringCall = false
    vi.mocked(local.api.Feed.refresh).mockImplementationOnce(async () => {
      busyDuringCall = app.busy
    })

    await app.refresh()

    expect(busyDuringCall).toBe(true)
    expect(app.busy).toBe(false)
  })

  it('clears busy even when the action fails', async () => {
    const local = await connect()
    vi.mocked(local.api.Feed.refresh).mockRejectedValueOnce(new Error('nope'))

    await app.refresh()

    expect(app.busy).toBe(false)
  })

  it('removing an account works through the bridge', async () => {
    const account = makeAccount({ did: 'did:plc:a' })
    const local = await connect({ accounts: [account] })

    await app.removeAccount(account.did)

    expect(local.api.Accounts.remove).toHaveBeenCalledWith(account.did)
    expect(app.accounts).toHaveLength(0)
  })
})

describe('before init', () => {
  it('exposes an empty but valid state', async () => {
    // Re-initialise onto a state that matches the module's own EMPTY default.
    await connect(makeState({ version: '0.0.0' }))
    expect(app.posts).toEqual([])
    expect(app.accounts).toEqual([])
    expect(app.unreadCount).toBe(0)
    expect(app.settings.pollIntervalSec).toBeGreaterThan(0)
    expect(app.sync).toMatchObject({ status: 'idle' })
  })
})

describe('the network dashboard', () => {
  it('pulls the dashboard alongside the state', async () => {
    const snapshot = makeSnapshot({ services: [makeService()] })
    await connect({ snapshot })
    expect(app.snapshot).toEqual(snapshot)
  })

  it('follows pushes on its own channel', async () => {
    const local = await connect()
    local.pushNetwork({ running: true })
    expect(app.snapshot.running).toBe(true)
  })

  it('unsubscribes from every channel on the way out', async () => {
    const local = await connect()
    expect(local.networkListenerCount()).toBe(2)
    stop?.()
    stop = null
    expect(local.networkListenerCount()).toBe(0)
  })

  it('shows the dashboard when main asks', async () => {
    const local = await connect()
    local.reveal('relay:bsky.network')
    expect(nav.view).toBe('network')
    expect(nav.pending).toEqual({ serviceId: 'relay:bsky.network' })
  })

  it('runs the checks through the bridge', async () => {
    const local = await connect()
    app.runNetworkChecks()
    expect(local.api.Network.run).toHaveBeenCalledTimes(1)
  })

  it('surfaces a refused sweep as an inline error', async () => {
    const local = await connect()
    vi.mocked(local.api.Network.run).mockRejectedValueOnce(new Error('Not allowed'))
    app.runNetworkChecks()
    await vi.waitFor(() => expect(app.actionError).toBe('Not allowed'))
  })

  describe('re-checking when the popover opens', () => {
    const now = Date.parse('2026-01-01T12:00:00Z')

    it('checks when nothing has been measured yet', async () => {
      const local = await connect()
      app.runNetworkChecksIfStale(120_000, now)
      expect(local.api.Network.run).toHaveBeenCalledTimes(1)
    })

    it('checks when the last sweep is old enough', async () => {
      const local = await connect({
        snapshot: makeSnapshot({ finishedAt: '2026-01-01T11:57:00Z' })
      })
      app.runNetworkChecksIfStale(120_000, now)
      expect(local.api.Network.run).toHaveBeenCalledTimes(1)
    })

    it('leaves a recent sweep alone', async () => {
      const local = await connect({
        snapshot: makeSnapshot({ finishedAt: '2026-01-01T11:59:00Z' })
      })
      app.runNetworkChecksIfStale(120_000, now)
      expect(local.api.Network.run).not.toHaveBeenCalled()
    })

    it('never starts a second sweep over one running', async () => {
      const local = await connect({ snapshot: makeSnapshot({ running: true }) })
      app.runNetworkChecksIfStale(120_000, now)
      expect(local.api.Network.run).not.toHaveBeenCalled()
    })

    it('does nothing while checks are switched off', async () => {
      const local = await connect({ settings: makeSettings({ networkChecks: false }) })
      app.runNetworkChecksIfStale(120_000, now)
      expect(local.api.Network.run).not.toHaveBeenCalled()
    })

    it('reads the clock itself when not handed one', async () => {
      const local = await connect({
        snapshot: makeSnapshot({ finishedAt: new Date().toISOString() })
      })
      app.runNetworkChecksIfStale(120_000)
      expect(local.api.Network.run).not.toHaveBeenCalled()
    })
  })
})

describe('the headline', () => {
  const account = makeAccount({ did: 'did:plc:a' })
  const calm = makePost({ authorDid: account.did, severity: 'resolved' })

  it('names a service the checks found down', async () => {
    await connect({
      accounts: [account],
      posts: [calm],
      network: makeNetworkSummary({ health: 'down', down: ['europe.firehose.network'] })
    })
    expect(app.headline).toEqual({
      health: 'incident',
      label: 'europe.firehose.network is unreachable'
    })
    expect(app.overall).toBe('incident')
  })

  it('ignores the checks once their source is hidden', async () => {
    await connect({
      accounts: [account, { ...probeAccount('2026-01-01T00:00:00Z'), muted: true }],
      posts: [calm],
      network: makeNetworkSummary({ health: 'down', down: ['europe.firehose.network'] })
    })
    expect(app.headline.label).toBe(HEALTH_LABEL.operational)
  })

  it('judges the checks’ source by the measurement, not by its last entry', async () => {
    const source = probeAccount('2026-01-01T00:00:00Z')
    await connect({
      accounts: [account, source],
      posts: [calm, makePost({ authorDid: PROBE_SOURCE_DID, severity: 'outage' })],
      network: makeNetworkSummary({ health: 'operational' })
    })
    expect(app.healthByAccount.get(PROBE_SOURCE_DID)).toBe('operational')
    expect(app.overall).toBe('operational')
  })

  it('has no health for the checks’ source before anything is measured', async () => {
    await connect({ accounts: [probeAccount('2026-01-01T00:00:00Z')] })
    expect(app.healthByAccount.get(PROBE_SOURCE_DID)).toBe('unknown')
  })
})
