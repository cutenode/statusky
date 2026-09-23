import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeAccount,
  makeNetworkSummary,
  makePost,
  makeService,
  makeSettings,
  makeSnapshot
} from '../../../test/factories'
import { installBridge, type TestBridge } from '../../../test/bridge'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { PROBE_SOURCE_DID, probeAccount } from '@shared/network'
import { DEFAULT_PROBE_TARGETS } from '@shared/probe-targets'
import { webhookAccount } from '@shared/webhook'
import { HEALTH_LABEL } from '@shared/status'
import { app } from './app-state.svelte'
import { nav } from './nav.svelte'

/**
 * The renderer store is a singleton, so each test re-points it at a fresh bridge
 * and re-runs `init()` — the same sequence the popover performs on load — and is
 * reset afterwards, since `init()` leaves what the last test did to `actionError` alone.
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
  app.reset()
  nav.reset()
})

/**
 * A clock the health tests share, and a stamp a few minutes before it.
 *
 * What the header says is a statement about a moment now, not just about a snapshot:
 * the same posts read differently a day later. Tests about the rollup pin both ends,
 * and the ones about ageing move the clock rather than the posts.
 */
const NOW = Date.parse('2026-01-02T12:00:00.000Z')
const justNow = (minutesAgo = 5): string => new Date(NOW - minutesAgo * 60_000).toISOString()
const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString()

describe('init', () => {
  it('pulls the initial state and reports ready', async () => {
    const account = makeAccount()
    await connect({ accounts: [account], version: '1.2.3' })

    expect(app.ready).toBe(true)
    expect(app.accounts).toHaveLength(1)
    expect(app.version).toBe('1.2.3')
  })

  /**
   * Asked once, from main, rather than guessed from the user agent — and used for the
   * things whose wording differs rather than whose behaviour does, like writing a
   * keyboard shortcut `⌘⇧S` or `Ctrl+Shift+S`.
   */
  it('learns which platform it is running on', async () => {
    await connect({ platform: 'win32' })
    expect(app.platform).toBe('win32')
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

  it('leaves pushed deliveries and measurements to the timeline', async () => {
    await connect(mixed)
    expect(app.feedPosts.map((p) => p.uri)).not.toContain(pushed.uri)
    expect(app.feedPosts.map((p) => p.uri)).not.toContain(measured.uri)
    expect(app.posts.map((p) => p.uri)).toEqual([posted.uri, pushed.uri, measured.uri])
  })

  it('offers chips for the status accounts only', async () => {
    await connect(mixed)
    expect(app.feedAccounts.map((a) => a.did)).toEqual([status.did])
  })

  it('counts unread on the feed, and keeps the whole list for the timeline', async () => {
    await connect({ ...mixed, unread: [posted.uri, measured.uri] })

    expect(app.unreadCount).toBe(2)
    expect(app.feedUnreadCount).toBe(1)
    expect(app.unreadUris).toEqual([posted.uri, measured.uri])
    expect(app.unreadPosts.map((p) => p.uri)).toEqual([posted.uri, measured.uri])
  })

  it('follows a push rather than caching the first split it saw', async () => {
    const local = await connect({ ...mixed, posts: [posted, pushed, measured] })
    expect(app.feedPosts.map((p) => p.uri)).toEqual([posted.uri])

    local.push({ posts: [pushed] })

    expect(app.feedPosts).toEqual([])
  })
})

describe('health rollups', () => {
  it('derives health per account from its newest post', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    const b = makeAccount({ did: 'did:plc:b' })
    await connect({
      accounts: [a, b],
      posts: [
        makePost({ authorDid: a.did, severity: 'outage', createdAt: justNow() }),
        makePost({ authorDid: b.did, severity: 'resolved', createdAt: justNow() })
      ]
    })

    expect(app.healthByAccount.get(a.did)).toBe('incident')
    expect(app.healthByAccount.get(b.did)).toBe('operational')
  })

  it('goes on saying what an account last said, however long ago it said it', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    await connect({
      accounts: [a],
      posts: [makePost({ authorDid: a.did, severity: 'outage', createdAt: hoursAgo(300) })]
    })

    // The account's own row is about the account, not about the world: it reports what
    // that account last posted. Only the headline asks how long ago.
    expect(app.healthByAccount.get(a.did)).toBe('incident')
    expect(app.overallAt(NOW)).toBe('unknown')
  })

  it('reports unknown for an account with no posts', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    await connect({ accounts: [a] })
    expect(app.healthByAccount.get(a.did)).toBe('unknown')
    expect(app.overallAt(NOW)).toBe('unknown')
  })

  it('rolls the worst visible state up into the headline', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    const b = makeAccount({ did: 'did:plc:b' })
    await connect({
      accounts: [a, b],
      posts: [
        makePost({ authorDid: a.did, severity: 'outage', createdAt: justNow() }),
        makePost({ authorDid: b.did, severity: 'resolved', createdAt: justNow() })
      ]
    })

    expect(app.overallAt(NOW)).toBe('incident')
  })

  it('ignores muted accounts in the rollup', async () => {
    const muted = makeAccount({ did: 'did:plc:a', muted: true })
    const fine = makeAccount({ did: 'did:plc:b' })
    await connect({
      accounts: [muted, fine],
      posts: [
        makePost({ authorDid: muted.did, severity: 'outage', createdAt: justNow() }),
        makePost({ authorDid: fine.did, severity: 'resolved', createdAt: justNow() })
      ]
    })

    expect(app.overallAt(NOW)).toBe('operational')
  })

  it('recomputes when a push arrives', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    const local = await connect({ accounts: [a] })
    expect(app.overallAt(NOW)).toBe('unknown')

    local.push({
      posts: [makePost({ authorDid: a.did, severity: 'degraded', createdAt: justNow() })]
    })

    expect(app.overallAt(NOW)).toBe('incident')
  })

  it('recomputes as the clock moves, with no new push', async () => {
    const a = makeAccount({ did: 'did:plc:a' })
    await connect({
      accounts: [a],
      posts: [makePost({ authorDid: a.did, severity: 'outage', createdAt: hoursAgo(11) })]
    })

    expect(app.overallAt(NOW)).toBe('incident')
    expect(app.overallAt(NOW + 2 * 3_600_000)).toBe('unknown')
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
    await app.markReadThrough('at://x')
    await app.testNotification()
    await app.regenerateWebhookSecret()
    await app.copyText('https://example.test/hook')
    await app.showPostMenu('at://x')
    app.openExternal('https://bsky.app')
    app.hide()

    expect(local.api.Feed.refresh).toHaveBeenCalled()
    expect(local.api.Accounts.patch).toHaveBeenCalledWith('did:plc:a', { muted: true })
    expect(local.api.Preferences.patch).toHaveBeenCalledWith({ theme: 'dark' })
    expect(local.api.Feed.markRead).toHaveBeenCalledWith(['at://x'])
    expect(local.api.Feed.markAllRead).toHaveBeenCalled()
    expect(local.api.Feed.markReadThrough).toHaveBeenCalledWith('at://x')
    expect(local.api.Host.sendTestNotification).toHaveBeenCalled()
    expect(local.api.Webhook.regenerateSecret).toHaveBeenCalled()
    expect(local.api.Host.copyText).toHaveBeenCalledWith('https://example.test/hook')
    expect(local.api.Popover.postMenu).toHaveBeenCalledWith('at://x')
    expect(local.api.Host.openExternal).toHaveBeenCalledWith('https://bsky.app')
    expect(local.api.Host.hideWindow).toHaveBeenCalled()
    expect(app.actionError).toBeNull()
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

/**
 * What a component mounted before the first state arrives reads, and what `reset()` puts
 * back — which is what keeps one test's state from being the next one's first tick.
 */
describe('before init', () => {
  it('holds an empty but valid state, and is not ready', async () => {
    await connect({
      accounts: [makeAccount()],
      posts: [makePost()],
      unread: [makePost().uri],
      settings: makeSettings({ theme: 'dark' }),
      snapshot: makeSnapshot({ services: [makeService()] }),
      platform: 'win32',
      version: '1.2.3',
      resolveError: 'Profile not found'
    })
    await app.addAccount('nobody.invalid')
    expect(app.actionError).not.toBeNull()
    stop?.()
    stop = null

    app.reset()

    expect(app.ready).toBe(false)
    expect(app.busy).toBe(false)
    expect(app.actionError).toBeNull()
    expect(app.posts).toEqual([])
    expect(app.accounts).toEqual([])
    expect(app.unreadCount).toBe(0)
    expect(app.settings).toEqual(DEFAULT_SETTINGS)
    expect(app.sync).toEqual({ status: 'idle', lastSyncedAt: null, error: null })
    expect(app.snapshot.services).toEqual([])
    expect(app.platform).toBe('darwin')
    expect(app.version).toBe('0.0.0')
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
    expect([local.listenerCount(), local.pushListenerCount()]).toEqual([1, 3])
    stop?.()
    stop = null
    expect([local.listenerCount(), local.pushListenerCount()]).toEqual([0, 0])
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

    // Both ways, so a clock stuck at either end of time could not pass for the real one.
    it('reads the clock itself when not handed one', async () => {
      const local = await connect({
        snapshot: makeSnapshot({ finishedAt: new Date().toISOString() })
      })
      app.runNetworkChecksIfStale(120_000)
      expect(local.api.Network.run).not.toHaveBeenCalled()

      local.pushNetwork({ finishedAt: new Date(Date.now() - 10 * 60_000).toISOString() })
      app.runNetworkChecksIfStale(120_000)
      expect(local.api.Network.run).toHaveBeenCalledTimes(1)
    })
  })
})

describe('what only the page is told', () => {
  it('passes a connection coming back on to main', async () => {
    const local = await connect()

    app.reportOnline(true)

    expect(local.api.Popover.online).toHaveBeenCalledWith(true)
  })

  it('passes a connection going away on as well, and lets main decide', async () => {
    const local = await connect()

    app.reportOnline(false)

    expect(local.api.Popover.online).toHaveBeenCalledWith(false)
  })

  // A hint main is free to ignore is not worth an error banner in the popover: the
  // checks work whether or not this call gets through.
  it('says nothing to the user when the hint itself fails', async () => {
    const local = await connect()
    vi.mocked(local.api.Popover.online).mockRejectedValueOnce(new Error('refused'))

    app.reportOnline(true)
    await Promise.resolve()

    expect(app.actionError).toBeNull()
  })

  /**
   * Nothing in the main process can read `prefers-reduced-motion`, and the thing that
   * has to honour it — the tray's heartbeat — lives there. So the page reads it.
   */
  it('passes the reduced-motion preference on to main', async () => {
    const local = await connect()

    app.reportReducedMotion(true)

    expect(local.api.Popover.reduceMotion).toHaveBeenCalledWith(true)
  })

  it('passes the ordinary case on too, since main assumes the other one', async () => {
    const local = await connect()

    app.reportReducedMotion(false)

    expect(local.api.Popover.reduceMotion).toHaveBeenCalledWith(false)
  })

  // Main has a safe default to fall back on, so a failed report leaves the tray quieter
  // than asked for rather than louder — which is not worth a banner.
  it('says nothing to the user when the report itself fails', async () => {
    const local = await connect()
    vi.mocked(local.api.Popover.reduceMotion).mockRejectedValueOnce(new Error('refused'))

    app.reportReducedMotion(true)
    await Promise.resolve()

    expect(app.actionError).toBeNull()
  })

  it('shows the Timeline when main asks to catch the user up', async () => {
    const local = await connect()
    nav.open('network')

    local.catchUp()

    expect(nav.view).toBe('timeline')
    expect(nav.tab).toBe('timeline')
  })
})

describe('the headline', () => {
  const account = makeAccount({ did: 'did:plc:a', displayName: 'Bluesky Status' })
  const calm = makePost({ authorDid: account.did, severity: 'resolved', createdAt: justNow() })

  it('names a service the checks found down', async () => {
    await connect({
      accounts: [account],
      posts: [calm],
      network: makeNetworkSummary({ health: 'down', down: ['europe.firehose.network'] })
    })
    expect(app.headlineAt(NOW)).toEqual({
      health: 'incident',
      label: 'europe.firehose.network is unreachable',
      attribution: null
    })
    expect(app.overallAt(NOW)).toBe('incident')
  })

  it('ignores the checks once their source is hidden', async () => {
    await connect({
      accounts: [account, { ...probeAccount('2026-01-01T00:00:00Z'), muted: true }],
      posts: [calm],
      network: makeNetworkSummary({ health: 'down', down: ['europe.firehose.network'] })
    })
    expect(app.headlineAt(NOW).label).toBe(HEALTH_LABEL.operational)
  })

  it('judges the checks’ source by the measurement, not by its last entry', async () => {
    const source = probeAccount('2026-01-01T00:00:00Z')
    await connect({
      accounts: [account, source],
      posts: [
        calm,
        makePost({ authorDid: PROBE_SOURCE_DID, severity: 'outage', createdAt: justNow() })
      ],
      network: makeNetworkSummary({ health: 'operational' })
    })
    expect(app.healthByAccount.get(PROBE_SOURCE_DID)).toBe('operational')
    expect(app.overallAt(NOW)).toBe('operational')
  })

  it('has no health for the checks’ source before anything is measured', async () => {
    await connect({ accounts: [probeAccount('2026-01-01T00:00:00Z')] })
    expect(app.healthByAccount.get(PROBE_SOURCE_DID)).toBe('unknown')
  })

  it('names who said it, and when', async () => {
    await connect({
      accounts: [account],
      posts: [makePost({ authorDid: account.did, severity: 'outage', createdAt: hoursAgo(2) })],
      network: makeNetworkSummary({ health: 'operational' })
    })
    expect(app.headlineAt(NOW)).toEqual({
      health: 'incident',
      label: HEALTH_LABEL.incident,
      attribution: {
        name: 'Bluesky Status',
        health: 'incident',
        at: hoursAgo(2),
        others: 0,
        stale: false
      }
    })
  })

  it('hands a claim that has gone quiet back to the measurement, and says so', async () => {
    await connect({
      accounts: [account],
      posts: [
        makePost({ authorDid: account.did, severity: 'maintenance', createdAt: hoursAgo(72) })
      ],
      network: makeNetworkSummary({ health: 'operational' })
    })

    const line = app.headlineAt(NOW)
    expect(line.health).toBe('operational')
    expect(line.label).toBe(HEALTH_LABEL.operational)
    expect(line.attribution).toEqual({
      name: 'Bluesky Status',
      health: 'maintenance',
      at: hoursAgo(72),
      others: 0,
      stale: true
    })
  })
})

// The check targets editor reports its own failures, beside the control that asked.
describe('check target actions', () => {
  it('looks an account up without tracking it', async () => {
    const local = await connect()

    const outcome = await app.lookUpActor('status.example.test')

    expect(outcome).toMatchObject({ ok: true, value: { handle: 'status.example.test' } })
    expect(local.api.Actors.resolve).toHaveBeenCalledWith('status.example.test')
    expect(local.api.Accounts.add).not.toHaveBeenCalled()
  })

  it('hands a failure back rather than putting it on actionError', async () => {
    await connect({ resolveError: 'Profile not found' })

    expect(await app.lookUpActor('nobody.invalid')).toEqual({
      ok: false,
      error: 'Profile not found'
    })
    expect(app.actionError).toBeNull()
  })

  it('replaces the targets, and goes back to the defaults with null', async () => {
    const local = await connect()
    const targets = structuredClone(DEFAULT_PROBE_TARGETS)
    targets.feeds = []

    const saved = await app.setProbeTargets(targets)
    expect(saved.ok && saved.value.probeTargets).toEqual(targets)
    expect(local.api.Preferences.patch).toHaveBeenLastCalledWith({ probeTargets: targets })

    await app.setProbeTargets(null)
    expect(local.api.Preferences.patch).toHaveBeenLastCalledWith({ probeTargets: null })
  })

  it('exports and opens through main, passing a cancelled dialog on as null', async () => {
    const local = await connect({ openedFile: { name: 'mine.json', text: '{}' } })

    expect(await app.exportProbeTargets()).toEqual({
      ok: true,
      value: 'statusky-probe-targets.json'
    })
    expect(await app.openProbeTargetsFile()).toEqual({
      ok: true,
      value: { name: 'mine.json', text: '{}' }
    })

    vi.mocked(local.api.ProbeTargetsFile.save).mockResolvedValueOnce(null)
    expect(await app.exportProbeTargets()).toEqual({ ok: true, value: null })

    vi.mocked(local.api.ProbeTargetsFile.open).mockRejectedValueOnce(
      new Error("Error invoking remote method 'x': Error: Could not read mine.json")
    )
    expect(await app.openProbeTargetsFile()).toEqual({
      ok: false,
      error: 'Could not read mine.json'
    })
  })
})
