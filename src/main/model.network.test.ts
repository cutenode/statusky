/**
 * What the model does with the network checks.
 *
 * The requests are covered in `probes.test.ts` and the debouncing in `network.test.ts`;
 * this is about the consequences, through the running app: what the popover is told,
 * what lands in the feed, what becomes unread, what raises a notification, and which
 * settings start and stop it all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROBE_SOURCE_DID, SERVICES, isControl, reportHeadline } from '../shared/network'
import { DEFAULT_SETTINGS } from '../shared/defaults'
import { DEFAULT_PROBE_TARGETS } from '../shared/probe-targets'
import type { ProbeTargets } from '../shared/types'
import { createHarness, flush, waitFor, type Harness } from '../test/harness'
import { FakeNetwork } from '../test/network'
import { NetworkMonitor, type MonitorTimings } from './network'

const network = new FakeNetwork()
let harness: Harness | null = null

const FAST: Partial<MonitorTimings> = {
  requestTimeoutMs: 500,
  firehoseWindowMs: 40,
  indexGraceMs: 0,
  recheckDelayMs: 5,
  offlineRetryMs: 5,
  throttleMs: 1
}

async function boot(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness({
    tray: false,
    network: { transport: network, timings: FAST },
    ...options
  })
  return harness
}

/** Start the app and wait for its first sweep. */
async function started(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = await boot(options)
  h.model.start()
  await h.model.runNetworkChecks()
  return h
}

/**
 * Take a relay down and wait until the checks believe it.
 *
 * `europe.firehose.network` on purpose: it carries exactly one service, so an outage there is one
 * feed entry, and a test about one entry should not be asserting on how many
 * capabilities happen to share a hostname.
 */
async function outage(h: Harness, host = 'europe.firehose.network'): Promise<void> {
  network.fail(host, { kind: 'network', message: 'net::ERR_CONNECTION_REFUSED' })
  network.setFirehose(host, 'socket-error')
  await h.model.runNetworkChecks()
  await waitFor(() => h.state().network.down.includes(host), `${host} to be confirmed down`)
}

/** Everything the summary counts: the Atmosphere, without the control group. */
const measured = SERVICES.filter((s) => !isControl(s)).length

afterEach(() => {
  harness?.dispose()
  harness = null
  network.reset()
  vi.restoreAllMocks()
})

describe('the machine coming back', () => {
  it('catches up only once what was last measured has gone stale', async () => {
    let clock = Date.now()
    const h = await started({
      network: { transport: network, timings: FAST, now: () => clock }
    })
    const run = vi.spyOn(NetworkMonitor.prototype, 'run')

    h.model.catchUpNetwork()
    expect(run).not.toHaveBeenCalled()

    clock += 5 * 60_000
    h.model.catchUpNetwork()
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('what the popover is told', () => {
  it('reports nothing measured before the app starts', async () => {
    const h = await boot()
    expect(h.state().network).toMatchObject({ health: 'unknown', running: false, total: measured })
    expect(h.model.networkSnapshot().services.every((s) => s.state === 'pending')).toBe(true)
  })

  it('sweeps on start and summarises the result in the state', async () => {
    const h = await started()
    expect(h.state().network).toMatchObject({
      health: 'operational',
      total: measured,
      reachable: measured,
      running: false,
      lastSweepAt: expect.any(String)
    })
  })

  it('pushes the dashboard on its own channel as the sweep fills in', async () => {
    network.fail('eurosky.social', { kind: 'delay', ms: 30 })
    const h = await started()
    expect(h.networkPushes[0]!.running).toBe(true)
    expect(h.networkPushes.at(-1)).toMatchObject({ running: false })
    // Filling in shows on the dashboard's channel alone; the state only ever carries
    // the summary, so a sweep does not re-send every post with each answer.
    const partway = h.networkPushes.filter(
      (s) => s.running && s.services.some((service) => service.checks.some((c) => c.ok))
    )
    expect(partway.length).toBeGreaterThan(0)
    expect(h.pushes.at(-1)!.network).not.toHaveProperty('services')
  })

  it('reaches the renderer through the bridge', async () => {
    const h = await started()
    const snapshot = await h.api.Network.get()
    expect(snapshot.services).toHaveLength(SERVICES.length)
    expect(snapshot.finishedAt).toBe(h.state().network.lastSweepAt)

    network.requests.length = 0
    await h.api.Network.run()
    expect(network.requests.length).toBeGreaterThan(0)
  })

  it('does nothing without a transport', async () => {
    const h = await boot({ network: undefined })
    h.model.start()
    await h.model.runNetworkChecks()
    expect(h.state().network.health).toBe('unknown')
    expect(h.networkPushes).toHaveLength(0)
  })
})

describe('settings', () => {
  it('stops and forgets everything when checks are switched off', async () => {
    const h = await started()
    await h.api.Preferences.patch({ networkChecks: false })

    expect(h.state().network.health).toBe('off')
    expect(h.model.networkSnapshot().finishedAt).toBeNull()

    network.requests.length = 0
    await h.model.runNetworkChecks()
    expect(network.requests).toHaveLength(0)
  })

  it('sweeps at once when switched back on', async () => {
    const h = await started({ settings: { networkChecks: false } })
    expect(h.state().network.health).toBe('off')

    await h.api.Preferences.patch({ networkChecks: true })
    await waitFor(() => h.state().network.health === 'operational', 'a sweep')
  })

  it('reschedules without sweeping when only the interval changes', async () => {
    const h = await started()
    network.requests.length = 0
    await h.api.Preferences.patch({ networkIntervalSec: 1800 })
    await flush()
    expect(h.state().settings.networkIntervalSec).toBe(1800)
    expect(network.requests).toHaveLength(0)
  })

  it('never sweeps more often than once a minute', async () => {
    const h = await boot()
    await h.api.Preferences.patch({ networkIntervalSec: 5 })
    expect(h.state().settings.networkIntervalSec).toBe(60)
  })

  it('leaves the checks and the receiver running when the poll interval changes', async () => {
    const h = await started({ settings: { webhookEnabled: true, webhookPort: 0 } })
    await waitFor(() => h.state().webhook.state === 'listening', 'the receiver to bind')

    await h.api.Preferences.patch({ pollIntervalSec: 300 })
    await flush()

    // Changing the poll interval once stopped everything `stop()` stops.
    expect(h.state().webhook.state).toBe('listening')
    network.requests.length = 0
    await h.model.runNetworkChecks()
    expect(network.requests.length).toBeGreaterThan(0)
  })

  it('abandons the sweep in flight when the app stops', async () => {
    network.fail('eurosky.social', { kind: 'hang' })
    const h = await boot()
    h.model.start()
    await waitFor(() => h.model.networkSnapshot().running, 'the first sweep to start')

    h.model.stop()

    // Not when the hung request times out: now.
    expect(h.model.networkSnapshot().running).toBe(false)
    expect(h.model.networkSnapshot().finishedAt).toBeNull()
  })
})

describe('which panels count', () => {
  it('keeps a panel left out of the menu bar off its health, and still files it', async () => {
    const h = await started()
    network.fail('spindle.tangled.sh', { kind: 'network', message: 'net::ERR_CONNECTION_REFUSED' })
    await h.model.runNetworkChecks()
    await waitFor(
      () => h.state().network.uncounted.includes('spindle.tangled.sh'),
      'the spindle to be confirmed down'
    )
    expect(h.state().network).toMatchObject({ health: 'operational', down: [] })
    expect(
      h
        .state()
        .posts.some(
          (p) => p.authorDid === PROBE_SOURCE_DID && p.text.startsWith('spindle.tangled.sh')
        )
    ).toBe(true)

    await h.api.Preferences.patch({
      countedProbeGroups: [...DEFAULT_SETTINGS.countedProbeGroups, 'tangled']
    })
    expect(h.state().network).toMatchObject({ health: 'down', down: ['spindle.tangled.sh'] })
  })

  it('never counts the control group, whatever it is told', async () => {
    const h = await started()
    await h.api.Preferences.patch({ countedProbeGroups: ['relays', 'internet'] })
    expect(h.state().settings.countedProbeGroups).toEqual(['relays'])
  })
})

describe('an account the checks read that has gone', () => {
  it('is named for Settings, and no AppView is marked down for it', async () => {
    const [gone] = DEFAULT_PROBE_TARGETS.accounts
    for (const service of SERVICES.filter((s) => s.kind === 'appview')) {
      network.unindex(service.host, gone!.did)
    }
    const h = await started()
    expect(h.state().network).toMatchObject({
      health: 'operational',
      degraded: [],
      vanished: [
        { part: 'account', did: gone!.did },
        { part: 'handle', did: gone!.did }
      ]
    })
  })
})

describe('what lands in the feed', () => {
  it('files a confirmed outage under the checks’ own source, which registers itself', async () => {
    const h = await started()
    expect(h.state().accounts.some((a) => a.did === PROBE_SOURCE_DID)).toBe(false)

    await outage(h)

    const source = h.state().accounts.find((a) => a.did === PROBE_SOURCE_DID)
    expect(source).toMatchObject({
      kind: 'probe',
      builtin: true,
      notify: 'default',
      muted: false,
      displayName: 'Network checks'
    })

    const entry = h.state().posts.find((p) => p.authorDid === PROBE_SOURCE_DID)
    expect(entry).toMatchObject({
      severity: 'outage',
      url: '',
      text: expect.stringMatching(
        /^europe\.firehose\.network is not responding from this computer\./
      )
    })
    expect(h.state().unread).toContain(entry!.uri)
  })

  it('notifies about the first outage it files', async () => {
    const h = await started()
    await outage(h)
    await waitFor(() => h.notified.length > 0, 'a notification')
    expect(h.notified[0]!.map((p) => p.severity)).toEqual(['outage'])
  })

  it('files the recovery under the same source', async () => {
    const h = await started()
    await outage(h)
    const accounts = h.state().accounts.length

    network.heal()
    await h.model.runNetworkChecks()

    const entries = h.state().posts.filter((p) => p.authorDid === PROBE_SOURCE_DID)
    expect(entries.map((p) => p.severity)).toEqual(['resolved', 'outage'])
    expect(entries[0]!.text).toMatch(/^europe\.firehose\.network is responding again after/)
    expect(h.state().accounts).toHaveLength(accounts)
    await waitFor(() => h.notified.length === 2, 'the recovery notification')
  })

  it('stays quiet about outages once its source is silenced, but keeps them unread', async () => {
    const h = await started()
    await outage(h)
    await h.api.Accounts.patch(PROBE_SOURCE_DID, { notify: 'off' })
    const notified = h.notified.length

    network.heal()
    await h.model.runNetworkChecks()

    expect(h.notified).toHaveLength(notified)
    const recovery = h.state().posts.find((p) => p.severity === 'resolved')!
    expect(h.state().unread).toContain(recovery.uri)
  })

  it('stops counting the checks towards health once their source is hidden', async () => {
    const h = await started()
    await outage(h)
    const headline = (): string => {
      const { accounts, posts, network: summary } = h.state()
      return reportHeadline(accounts, posts, summary, Date.now()).label
    }
    expect(headline()).toBe('europe.firehose.network is unreachable')

    await h.api.Accounts.patch(PROBE_SOURCE_DID, { muted: true })

    expect(h.state().posts.some((p) => p.authorDid === PROBE_SOURCE_DID)).toBe(false)
    expect(headline()).not.toMatch(/unreachable/)
  })

  it('will not remove its source, which would only come back', async () => {
    const h = await started()
    await outage(h)
    await expect(h.api.Accounts.remove(PROBE_SOURCE_DID)).rejects.toThrow(/muted but not removed/)
  })

  it('never polls its source', async () => {
    const h = await started()
    await outage(h)
    h.appview.requests.length = 0
    await h.model.refresh()
    expect(h.appview.requests.some((r) => r.actor === PROBE_SOURCE_DID)).toBe(false)
    expect(h.appview.requests.some((r) => r.actors.includes(PROBE_SOURCE_DID))).toBe(false)
  })
})

/** Which actors one AppView's author feeds were last asked for. */
function feedActors(h: Harness): (string | null)[] {
  return h.model
    .networkSnapshot()
    .services.find((s) => s.id === 'appview:api.bsky.app')!
    .checks.filter((c) => c.label === 'getAuthorFeed')
    .map((c) => new URL(c.target!).searchParams.get('actor'))
}

describe('probe targets', () => {
  /** The checked-in targets with the accounts replaced, as a user's override would be. */
  const override: ProbeTargets = {
    ...structuredClone(DEFAULT_PROBE_TARGETS),
    accounts: [{ did: 'did:plc:alice', handle: 'alice.test' }]
  }

  it('are the checked-in ones until somebody says otherwise', async () => {
    const h = await started()
    expect(h.state().settings.probeTargets).toBeNull()
    expect(feedActors(h)).toEqual(DEFAULT_PROBE_TARGETS.accounts.map((a) => a.did))
  })

  it('are changed through the ordinary settings patch, and measured at once', async () => {
    const h = await started()
    network.useTargets(override)
    network.requests.length = 0

    const settings = await h.api.Preferences.patch({ probeTargets: override })
    expect(settings.probeTargets).toEqual(override)
    expect(h.store.get('settings').probeTargets).toEqual(override)

    // Nobody asked for a sweep: the change itself is what starts one.
    await waitFor(
      () => h.model.networkSnapshot().finishedAt !== null && feedActors(h).length === 1,
      'a sweep of the new accounts'
    )
    expect(feedActors(h)).toEqual(['did:plc:alice'])
    await waitFor(() => h.state().network.health === 'operational', 'the new sweep to settle')
  })

  it('go back to the defaults when set to none', async () => {
    network.useTargets(override)
    const h = await started({ settings: { probeTargets: override } })
    expect(feedActors(h)).toEqual(['did:plc:alice'])

    network.reset()
    await h.api.Preferences.patch({ probeTargets: null })
    await h.model.runNetworkChecks()
    expect(h.state().settings.probeTargets).toBeNull()
    expect(feedActors(h)).toEqual(DEFAULT_PROBE_TARGETS.accounts.map((a) => a.did))
  })

  it('are refused at the boundary when invalid, and nothing changes', async () => {
    const h = await started()
    network.requests.length = 0
    await expect(
      h.api.Preferences.patch({ probeTargets: { ...override, accounts: [] } })
    ).rejects.toThrow(/failed to pass validation/)
    await flush()
    expect(h.state().settings.probeTargets).toBeNull()
    expect(network.requests).toHaveLength(0)
  })

  it('are stored as none when they say exactly what the defaults say', async () => {
    const h = await started()
    const settings = await h.api.Preferences.patch({
      probeTargets: structuredClone(DEFAULT_PROBE_TARGETS)
    })
    expect(settings.probeTargets).toBeNull()
  })

  it('do not start a sweep when a patch leaves them as they were', async () => {
    // Answering for these accounts matters: a handle that failed to resolve would book a
    // re-check, whose requests would land in the middle of this.
    network.useTargets(override)
    const h = await started({ settings: { probeTargets: override } })
    network.requests.length = 0
    await h.api.Preferences.patch({ probeTargets: structuredClone(override), theme: 'dark' })
    await flush()
    expect(network.requests).toHaveLength(0)
  })

  it('take the pin off a feed they no longer list, and leave the other pins be', async () => {
    const [discover] = DEFAULT_PROBE_TARGETS.feeds
    const kept = SERVICES.find((s) => s.kind === 'relay')!.id
    const h = await started({
      settings: { notifyProbeScope: 'pinned', pinnedServices: [`feed:${discover!.host}`, kept] }
    })
    network.useTargets({ ...override, feeds: [] })

    const settings = await h.api.Preferences.patch({ probeTargets: { ...override, feeds: [] } })

    expect(settings.pinnedServices).toEqual([kept])
    expect(h.store.get('settings').pinnedServices).toEqual([kept])
  })

  it('fall back to the defaults, not a crash, when the stored ones are broken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { ...override, accounts: 'nope' } as unknown as ProbeTargets
    const h = await started({ settings: { probeTargets: broken } })
    expect(h.state().settings.probeTargets).toBeNull()
    expect(feedActors(h)).toEqual(DEFAULT_PROBE_TARGETS.accounts.map((a) => a.did))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/checked-in defaults[\s\S]*accounts/))
  })
})
