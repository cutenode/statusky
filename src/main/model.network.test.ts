/**
 * What the model does with the network checks.
 *
 * The requests are covered in `probes.test.ts` and the debouncing in `network.test.ts`;
 * this is about the consequences, through the running app: what the popover is told,
 * what lands in the feed, what becomes unread, what raises a notification, and which
 * settings start and stop it all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { PROBE_SOURCE_DID, SERVICES, isControl } from '../shared/network'
import { createHarness, flush, waitFor, type Harness } from '../test/harness'
import { FakeNetwork } from '../test/network'
import type { MonitorTimings } from './network'

const network = new FakeNetwork()
let harness: Harness | null = null

const FAST: Partial<MonitorTimings> = {
  requestTimeoutMs: 500,
  firehoseWindowMs: 40,
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

  it('stops sweeping when the app stops', async () => {
    const h = await started()
    h.model.stop()
    expect(h.model.networkSnapshot().running).toBe(false)
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
      notify: true,
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
    await h.api.Accounts.patch(PROBE_SOURCE_DID, { notify: false })
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
    await h.api.Accounts.patch(PROBE_SOURCE_DID, { muted: true })

    expect(h.state().posts.some((p) => p.authorDid === PROBE_SOURCE_DID)).toBe(false)
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
