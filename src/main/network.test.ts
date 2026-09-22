import { afterEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_LENGTH, SERVICES, type ProbeEvent } from '../shared/network'
import type { NetworkSnapshot, ServiceProbe } from '../shared/types'
import { FakeNetwork } from '../test/network'
import { NetworkMonitor, type MonitorTimings } from './network'

const network = new FakeNetwork()
const running: NetworkMonitor[] = []

afterEach(() => {
  for (const monitor of running.splice(0)) monitor.stop()
  network.reset()
  vi.restoreAllMocks()
})

/** Everything quick, so a recheck or an offline retry is a matter of milliseconds. */
const FAST: Partial<MonitorTimings> = {
  requestTimeoutMs: 500,
  firehoseWindowMs: 40,
  recheckDelayMs: 5,
  offlineRetryMs: 5,
  throttleMs: 1
}

const RELAY = 'relay:bsky.network'
const PDS = 'pds:eurosky.social'
const APPVIEW = 'appview:api.bsky.app'
const CONTROLS = ['internet:github', 'internet:aws']

interface Built {
  monitor: NetworkMonitor
  snapshots: NetworkSnapshot[]
  events: ProbeEvent[][]
  summaries(): number
  service(id: string): ServiceProbe
}

function build({
  ids = [RELAY, PDS, APPVIEW, ...CONTROLS],
  timings = {},
  transport = network
}: {
  ids?: string[]
  timings?: Partial<MonitorTimings>
  transport?: FakeNetwork | null
} = {}): Built {
  const snapshots: NetworkSnapshot[] = []
  const events: ProbeEvent[][] = []
  let summaries = 0
  const monitor = new NetworkMonitor({
    transport,
    services: ids.map((id) => SERVICES.find((s) => s.id === id)!),
    timings: { ...FAST, ...timings },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onSummaryChange: () => {
      summaries++
    },
    onEvents: (batch) => events.push(batch)
  })
  running.push(monitor)
  return {
    monitor,
    snapshots,
    events,
    summaries: () => summaries,
    service: (id) => monitor.snapshot().services.find((s) => s.id === id)!
  }
}

/** Switch checks on and wait for the sweep that starts. */
async function start(built: Built): Promise<void> {
  built.monitor.configure({ enabled: true, intervalSec: 600 })
  await built.monitor.run()
}

/** Break a relay completely: HTTP and firehose both. */
function breakRelay(host = 'bsky.network'): void {
  network.fail(host, { kind: 'network', message: 'net::ERR_CONNECTION_REFUSED' })
  network.setFirehose(host, 'socket-error')
}

describe('before anything is measured', () => {
  it('knows every service and has judged none', () => {
    const { monitor } = build()
    const snapshot = monitor.snapshot()
    expect(snapshot).toMatchObject({ running: false, startedAt: null, finishedAt: null })
    expect(snapshot.services.map((s) => [s.id, s.state, s.condition])).toEqual([
      [RELAY, 'pending', 'unknown'],
      [PDS, 'pending', 'unknown'],
      [APPVIEW, 'pending', 'unknown'],
      ['internet:github', 'pending', 'unknown'],
      ['internet:aws', 'pending', 'unknown']
    ])
    expect(monitor.summary(true).health).toBe('unknown')
    expect(monitor.summary(false).health).toBe('off')
  })

  it('measures the whole catalogue unless told otherwise', () => {
    const monitor = new NetworkMonitor({
      transport: null,
      onSnapshot: () => {},
      onSummaryChange: () => {},
      onEvents: () => {}
    })
    expect(monitor.snapshot().services).toHaveLength(SERVICES.length)
  })

  it('never probes without a transport', async () => {
    const built = build({ transport: null })
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    await built.monitor.run()
    expect(built.snapshots).toHaveLength(0)
    expect(built.monitor.summary(true).health).toBe('unknown')
  })

  it('does nothing while switched off', async () => {
    const built = build()
    await built.monitor.run()
    expect(network.requests).toHaveLength(0)
  })
})

describe('a sweep', () => {
  it('measures every service when checks are switched on', async () => {
    const built = build()
    await start(built)

    const snapshot = built.monitor.snapshot()
    expect(snapshot.running).toBe(false)
    expect(snapshot.finishedAt).toEqual(expect.any(String))
    expect(snapshot.offline).toBe(false)
    for (const service of snapshot.services) {
      expect(service.state).toBe('live')
      // Each service is stamped when it finished, which is its own moment.
      expect(Date.parse(service.checkedAt!)).toBeLessThanOrEqual(Date.parse(snapshot.finishedAt!))
      expect(service.history).toEqual([
        { at: service.checkedAt, state: 'live', latencyMs: service.latencyMs }
      ])
    }
    expect(built.service(RELAY).latencyMs).toEqual(expect.any(Number))
    expect(built.monitor.summary(true)).toMatchObject({
      health: 'operational',
      total: 3,
      reachable: 3
    })
  })

  it('reads a healthy first sighting as up, and says nothing about it', async () => {
    const built = build()
    await start(built)
    expect(built.service(RELAY)).toMatchObject({ condition: 'up', since: expect.any(String) })
    expect(built.events).toEqual([])
  })

  it('never judges the control checks, only uses them', async () => {
    network.fail('api.github.com', { kind: 'http', status: 403 })
    const built = build()
    await start(built)
    expect(built.service('internet:github')).toMatchObject({ state: 'down', condition: 'unknown' })
    expect(built.service('internet:github').rechecking).toBe(false)
    expect(built.events).toEqual([])
  })

  it('announces itself as it starts, and again once it is done', async () => {
    const built = build()
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    // The sweep switching checks on started, which this joins rather than repeats.
    await built.monitor.run()

    expect(built.snapshots[0]).toMatchObject({ running: true })
    expect(built.snapshots[0]!.services.every((s) => s.state === 'pending')).toBe(true)
    expect(built.snapshots.at(-1)).toMatchObject({ running: false })
    expect(built.summaries()).toBe(2)
  })

  it('shows the dashboard filling in while requests are outstanding', async () => {
    network.fail('eurosky.social', { kind: 'delay', ms: 40 })
    const built = build()
    await start(built)
    const partway = built.snapshots.find(
      (snapshot) =>
        snapshot.running &&
        snapshot.services.some((s) => s.checks.some((c) => c.ok !== null)) &&
        snapshot.services.some((s) => s.checks.some((c) => c.ok === null))
    )
    expect(partway).toBeDefined()
  })

  it('settles each service as its own checks come in, not when the sweep ends', async () => {
    // A PDS that takes its time must not hold the relay's verdict back.
    network.fail('eurosky.social', { kind: 'delay', ms: 150 })
    const built = build()
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    const sweep = built.monitor.run()

    await vi.waitFor(() => expect(built.service(RELAY).state).toBe('live'))
    const partway = built.monitor.snapshot()
    expect(partway.running).toBe(true)
    expect(partway.services.find((s) => s.id === RELAY)).toMatchObject({
      state: 'live',
      latencyMs: expect.any(Number),
      checkedAt: expect.any(String),
      history: [{ at: expect.any(String), state: 'live', latencyMs: expect.any(Number) }]
    })
    expect(partway.services.find((s) => s.id === PDS)!.state).toBe('pending')
    // And the dashboard has already been told.
    expect(
      built.snapshots.some((s) => s.services.some((x) => x.id === RELAY && x.state === 'live'))
    ).toBe(true)

    await sweep
    expect(built.service(PDS).state).toBe('live')
  })

  it('shares one sweep between everyone who asks while it runs', async () => {
    const built = build()
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    const first = built.monitor.run()
    expect(built.monitor.run()).toBe(first)
    await first
    expect(network.requestsTo('bsky.network')).toHaveLength(2)
  })

  it('survives a sweep that throws, and keeps sweeping', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let pushes = 0
    const monitor = new NetworkMonitor({
      transport: network,
      services: SERVICES.filter((s) => s.id === 'internet:aws'),
      timings: FAST,
      onSnapshot: () => {
        if (++pushes === 1) throw new Error('The window went away')
      },
      onSummaryChange: () => {},
      onEvents: () => {}
    })
    running.push(monitor)

    monitor.configure({ enabled: true, intervalSec: 600 })
    await expect(monitor.run()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith('A network sweep failed:', expect.any(Error))
    expect(monitor.snapshot().running).toBe(false)

    await monitor.run()
    expect(monitor.snapshot().services[0]!.state).toBe('live')
  })

  it('hands out copies, never its own state', async () => {
    const built = build()
    await start(built)
    const snapshot = built.monitor.snapshot()
    snapshot.services[0]!.checks[0]!.ok = false
    snapshot.services[0]!.history.length = 0
    expect(built.service(RELAY).checks[0]!.ok).toBe(true)
    expect(built.service(RELAY).history).toHaveLength(1)
  })

  it('keeps a bounded history', async () => {
    const built = build({ ids: ['internet:aws'] })
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    for (let i = 0; i <= HISTORY_LENGTH; i++) {
      // Each sweep has to see the history the one before it left.
      // oxlint-disable-next-line no-await-in-loop
      await built.monitor.run()
    }
    expect(built.service('internet:aws').history).toHaveLength(HISTORY_LENGTH)
  })

  it('remembers the freshest AppView post between sweeps', async () => {
    const newest = Date.now()
    network.setNewestPost('api.bsky.app', new Date(newest).toISOString())
    const built = build({ ids: [APPVIEW, ...CONTROLS] })
    await start(built)

    // The same AppView going backwards is judged against what it showed last time.
    network.setNewestPost('api.bsky.app', new Date(newest - 3_600_000).toISOString())
    await built.monitor.run()
    const freshness = built.service(APPVIEW).checks.find((c) => c.label === 'newest post')!
    expect(freshness.error).toBe('Newest post trails other AppViews by 1 hour')
  })
})

describe('believing a failure', () => {
  it('re-checks a failure before believing it, then files it', async () => {
    const built = build()
    await start(built)

    breakRelay()
    network.requests.length = 0
    await built.monitor.run()
    expect(built.service(RELAY)).toMatchObject({ state: 'down', condition: 'up', rechecking: true })
    expect(built.events).toEqual([])

    await vi.waitFor(() => expect(built.events).toHaveLength(1))
    const [event] = built.events[0]!
    expect(event).toMatchObject({
      service: { id: RELAY },
      from: 'up',
      to: 'down',
      at: expect.any(String),
      since: expect.any(String)
    })
    expect(event!.checks.every((c) => c.ok === false)).toBe(true)
    expect(built.service(RELAY)).toMatchObject({
      condition: 'down',
      since: event!.at,
      rechecking: false
    })
    expect(built.monitor.summary(true)).toMatchObject({ health: 'down', down: ['bsky.network'] })
  })

  it('re-checks only the failing service, with the controls alongside', async () => {
    const built = build()
    await start(built)
    breakRelay()
    await built.monitor.run()
    network.requests.length = 0

    await vi.waitFor(() => expect(built.events).toHaveLength(1))
    const hosts = new Set(network.requests.map((r) => r.host))
    expect(hosts).toEqual(new Set(['bsky.network', 'api.github.com', 'checkip.amazonaws.com']))
  })

  it('lets a failure that does not repeat pass without a word', async () => {
    const built = build({ timings: { recheckDelayMs: 30 } })
    await start(built)
    breakRelay()
    await built.monitor.run()
    expect(built.service(RELAY).rechecking).toBe(true)

    network.heal()
    await vi.waitFor(() => expect(built.service(RELAY).history).toHaveLength(3))
    expect(built.service(RELAY)).toMatchObject({
      state: 'live',
      condition: 'up',
      rechecking: false
    })
    expect(built.events).toEqual([])
  })

  it('files a partial failure as such', async () => {
    const built = build()
    await start(built)
    network.fail('eurosky.social', { kind: 'http', status: 500 }, '/xrpc/_health')
    await built.monitor.run()
    await vi.waitFor(() => expect(built.events).toHaveLength(1))
    expect(built.events[0]![0]).toMatchObject({ from: 'up', to: 'partial' })
    expect(built.monitor.summary(true).degraded).toEqual(['eurosky.social'])
  })

  it('starts counting again when a failure changes shape', async () => {
    const built = build({ timings: { recheckDelayMs: 40 } })
    await start(built)

    network.fail('bsky.network', { kind: 'http', status: 500 }, '/xrpc/_health')
    await built.monitor.run()
    expect(built.service(RELAY).state).toBe('partial')

    // Worse before the re-check: a new failure, so it needs seeing twice itself.
    breakRelay()
    await vi.waitFor(() => expect(built.service(RELAY).history).toHaveLength(3))
    expect(built.service(RELAY)).toMatchObject({ state: 'down', condition: 'up', rechecking: true })
    expect(built.events).toEqual([])

    await vi.waitFor(() => expect(built.events).toHaveLength(1))
    expect(built.events[0]![0]).toMatchObject({ from: 'up', to: 'down' })
  })

  it('files a service that has been down since before the first sweep', async () => {
    breakRelay()
    const built = build()
    await start(built)
    await vi.waitFor(() => expect(built.events).toHaveLength(1))
    expect(built.events[0]![0]).toMatchObject({ from: 'unknown', to: 'down', since: null })
  })

  it('believes a recovery at once, and says how long the outage lasted', async () => {
    const built = build()
    await start(built)
    breakRelay()
    await built.monitor.run()
    await vi.waitFor(() => expect(built.events).toHaveLength(1))
    const downAt = built.events[0]![0]!.at

    network.heal()
    await built.monitor.run()
    expect(built.events).toHaveLength(2)
    expect(built.events[1]![0]).toMatchObject({ from: 'down', to: 'up', since: downAt })
    expect(built.service(RELAY)).toMatchObject({ condition: 'up', rechecking: false })
  })
})

describe('judging without waiting for the sweep', () => {
  it('files a confirmed change while the slow services are still being measured', async () => {
    network.fail('eurosky.social', { kind: 'delay', ms: 200 })
    const built = build({ timings: { confirmations: 1 } })
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    await built.monitor.run()

    breakRelay()
    network.fail('eurosky.social', { kind: 'delay', ms: 200 })
    const sweep = built.monitor.run()

    await vi.waitFor(() => expect(built.events).toHaveLength(1))
    expect(built.monitor.snapshot().running).toBe(true)
    expect(built.events[0]![0]).toMatchObject({ service: { id: RELAY }, to: 'down' })
    expect(built.service(PDS).state).toBe('pending')
    await sweep
  })

  it('waits for the control checks, which are what excuse a failure', async () => {
    const built = build({ timings: { confirmations: 1 } })
    await start(built)

    breakRelay()
    network.fail('api.github.com', { kind: 'delay', ms: 150 })
    network.fail('checkip.amazonaws.com', { kind: 'delay', ms: 150 })
    const sweep = built.monitor.run()

    // The relay's own verdict is in long before the controls have answered.
    await vi.waitFor(() => expect(built.service(RELAY).state).toBe('down'))
    expect(built.events).toEqual([])
    expect(built.service(RELAY).history).toHaveLength(1)

    await sweep
    expect(built.events).toHaveLength(1)
    expect(built.service(RELAY).history).toHaveLength(2)
  })

  it('takes a measurement at face value when there is no control group to judge by', async () => {
    const built = build({ ids: [RELAY], timings: { confirmations: 1 } })
    breakRelay()
    await start(built)

    expect(built.monitor.snapshot().offline).toBe(false)
    expect(built.service(RELAY).history).toHaveLength(1)
    expect(built.events[0]![0]).toMatchObject({ to: 'down' })
  })

  it('judges nothing from a sweep abandoned while the controls were still out', async () => {
    const built = build({ timings: { confirmations: 1 } })
    await start(built)

    breakRelay()
    network.fail('api.github.com', { kind: 'delay', ms: 100 })
    network.fail('checkip.amazonaws.com', { kind: 'delay', ms: 100 })
    const sweep = built.monitor.run()
    await vi.waitFor(() => expect(built.service(RELAY).state).toBe('down'))

    built.monitor.stop()
    await sweep

    expect(built.events).toEqual([])
    expect(built.service(RELAY)).toMatchObject({ condition: 'up', history: [{ state: 'live' }] })
  })

  it('gathers changes that land together into one handover', async () => {
    const built = build({
      ids: [RELAY, 'relay:europe.firehose.network', ...CONTROLS],
      timings: { confirmations: 1 }
    })
    await start(built)

    breakRelay()
    breakRelay('europe.firehose.network')
    await built.monitor.run()

    expect(built.events).toHaveLength(1)
    expect(built.events[0]!.map((event) => event.service.id)).toEqual([
      RELAY,
      'relay:europe.firehose.network'
    ])
  })
})

describe('offline', () => {
  it('judges nothing while every control check fails', async () => {
    const built = build()
    await start(built)
    network.goOffline()
    await built.monitor.run()

    const snapshot = built.monitor.snapshot()
    expect(snapshot.offline).toBe(true)
    expect(built.service(RELAY)).toMatchObject({
      state: 'down',
      condition: 'up',
      rechecking: false
    })
    expect(built.events).toEqual([])
    expect(built.monitor.summary(true).health).toBe('offline')
  })

  it('says so as soon as the controls have failed, not when the sweep gives up', async () => {
    network.fail('eurosky.social', { kind: 'delay', ms: 200 })
    const built = build()
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    await built.monitor.run()

    for (const host of ['api.github.com', 'checkip.amazonaws.com']) {
      network.fail(host, { kind: 'network', message: 'net::ERR_INTERNET_DISCONNECTED' })
    }
    network.fail('eurosky.social', { kind: 'delay', ms: 200 })
    const sweep = built.monitor.run()

    await vi.waitFor(() => expect(built.monitor.snapshot().offline).toBe(true))
    expect(built.monitor.snapshot().running).toBe(true)
    expect(built.monitor.summary(true).health).toBe('offline')
    await sweep
  })

  it('keeps the outage out of every service’s history but the controls’', async () => {
    const built = build()
    await start(built)
    network.goOffline()
    await built.monitor.run()
    expect(built.service(RELAY).history).toHaveLength(1)
    expect(built.service('internet:aws').history.map((s) => s.state)).toEqual(['live', 'down'])
  })

  it('retries only the controls until the connection is back, then sweeps it all', async () => {
    const built = build({ timings: { offlineRetryMs: 20 } })
    await start(built)
    network.goOffline()
    await built.monitor.run()
    network.requests.length = 0

    await vi.waitFor(() =>
      expect(built.service('internet:aws').history.length).toBeGreaterThanOrEqual(3)
    )
    expect(new Set(network.requests.map((r) => r.host))).toEqual(
      new Set(['api.github.com', 'checkip.amazonaws.com'])
    )
    expect(built.monitor.snapshot().offline).toBe(true)

    network.goOnline()
    await vi.waitFor(() => expect(built.service(RELAY).history).toHaveLength(2))
    expect(built.monitor.snapshot().offline).toBe(false)
    expect(built.service(RELAY).state).toBe('live')
  })
})

describe('the schedule', () => {
  it('sweeps on the interval it is given', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const built = build()
    built.monitor.configure({ enabled: true, intervalSec: 300 })
    await built.monitor.run()
    const [tick, ms] = interval.mock.calls.at(-1)!
    expect(ms).toBe(300_000)

    network.requests.length = 0
    ;(tick as () => void)()
    await built.monitor.run()
    expect(network.requestsTo('bsky.network').length).toBeGreaterThan(0)
  })

  it('does not sweep again just because the interval changed', async () => {
    const built = build()
    await start(built)
    network.requests.length = 0

    built.monitor.configure({ enabled: true, intervalSec: 1200 })
    await built.monitor.run().catch(() => {})
    expect(network.requests.length).toBeGreaterThan(0)
    network.requests.length = 0
    built.monitor.configure({ enabled: true, intervalSec: 900 })
    expect(network.requests).toHaveLength(0)
  })

  it('ignores being told what it already knows', async () => {
    const built = build()
    await start(built)
    const before = built.snapshots.length
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    built.monitor.configure({ enabled: false, intervalSec: 600 })
    const off = built.snapshots.length
    built.monitor.configure({ enabled: false, intervalSec: 600 })
    expect(off).toBe(before + 1)
    expect(built.snapshots).toHaveLength(off)
  })

  it('forgets everything when switched off, including a sweep in flight', async () => {
    network.fail('eurosky.social', { kind: 'hang' })
    const built = build()
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    const sweep = built.monitor.run()

    built.monitor.configure({ enabled: false, intervalSec: 600 })
    await sweep
    const snapshot = built.monitor.snapshot()
    expect(snapshot).toMatchObject({ running: false, finishedAt: null, offline: false })
    expect(snapshot.services.every((s) => s.state === 'pending' && !s.history.length)).toBe(true)
    expect(built.monitor.summary(false).health).toBe('off')
  })

  it('sweeps at once when switched back on', async () => {
    const built = build()
    await start(built)
    built.monitor.configure({ enabled: false, intervalSec: 600 })
    network.requests.length = 0
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    await built.monitor.run()
    expect(built.service(RELAY).state).toBe('live')
  })

  it('abandons its work when stopped, and stays quiet about it', async () => {
    network.fail('eurosky.social', { kind: 'hang' })
    network.setFirehose('bsky.network', 'silent')
    const built = build({ timings: { firehoseWindowMs: 5_000 } })
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    const sweep = built.monitor.run()
    await vi.waitFor(() => expect(network.sockets).toHaveLength(1))

    built.monitor.stop()
    const pushed = built.snapshots.length
    await sweep
    expect(network.sockets[0]!.closed).toBe(true)
    expect(built.snapshots).toHaveLength(pushed)
    expect(built.monitor.snapshot().running).toBe(false)
  })

  it('drops a dashboard push that was waiting when it stopped', async () => {
    network.fail('eurosky.social', { kind: 'hang' })
    // Long enough that the push for the requests already answered is certainly waiting.
    const built = build({ timings: { throttleMs: 60_000 } })
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    await vi.waitFor(() => expect(built.service(RELAY).checks.some((c) => c.ok)).toBe(true))
    const pushed = built.snapshots.length

    built.monitor.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(built.snapshots).toHaveLength(pushed)
  })

  it('stops a pending re-check along with everything else', async () => {
    const built = build({ timings: { recheckDelayMs: 30 } })
    await start(built)
    breakRelay()
    await built.monitor.run()
    expect(built.service(RELAY).rechecking).toBe(true)

    built.monitor.stop()
    expect(built.service(RELAY).rechecking).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(built.service(RELAY).history).toHaveLength(2)
  })

  it('picks the schedule back up after a stop', async () => {
    const built = build()
    await start(built)
    built.monitor.stop()
    const interval = vi.spyOn(globalThis, 'setInterval')
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    expect(interval).toHaveBeenCalledTimes(1)
  })
})

describe('a machine that is asleep', () => {
  it('puts the schedule down without forgetting what it measured', async () => {
    const built = build()
    await start(built)

    built.monitor.pause()

    expect(built.service(RELAY).state).toBe('live')
    expect(built.service(RELAY).history).toHaveLength(1)
    expect(built.monitor.summary(true).health).toBe('operational')
  })

  it('does not re-arm the schedule for a settings change made while it sleeps', async () => {
    const built = build()
    await start(built)
    built.monitor.pause()

    const interval = vi.spyOn(globalThis, 'setInterval')
    built.monitor.configure({ enabled: true, intervalSec: 900 })

    expect(interval).not.toHaveBeenCalled()
  })

  it('ignores being paused twice, and resumed when it never slept', async () => {
    const built = build()
    await start(built)
    built.monitor.pause()
    built.monitor.pause()

    const interval = vi.spyOn(globalThis, 'setInterval')
    built.monitor.resume()
    built.monitor.resume()

    expect(interval).toHaveBeenCalledTimes(1)
  })

  it('picks the settings changed while it slept up when it wakes', async () => {
    const built = build()
    await start(built)
    built.monitor.pause()
    built.monitor.configure({ enabled: true, intervalSec: 900 })

    const interval = vi.spyOn(globalThis, 'setInterval')
    built.monitor.resume()

    expect(interval.mock.calls.at(-1)?.[1]).toBe(900_000)
  })

  it('still forgets everything if the checks are switched off while it sleeps', async () => {
    const built = build()
    await start(built)
    built.monitor.pause()

    built.monitor.configure({ enabled: false, intervalSec: 600 })

    expect(built.service(RELAY).state).toBe('pending')
    expect(built.monitor.summary(false).health).toBe('off')
  })

  it('abandons the sweep it was in the middle of, as a lid closing would', async () => {
    network.fail('eurosky.social', { kind: 'hang' })
    network.setFirehose('bsky.network', 'silent')
    const built = build({ timings: { firehoseWindowMs: 5_000 } })
    built.monitor.configure({ enabled: true, intervalSec: 600 })
    const sweep = built.monitor.run()
    await vi.waitFor(() => expect(network.sockets).toHaveLength(1))

    built.monitor.pause()
    await sweep

    expect(network.sockets[0]!.closed).toBe(true)
    expect(built.monitor.snapshot().running).toBe(false)
  })
})

describe('a machine on battery', () => {
  it('waits out the battery floor rather than the setting', async () => {
    const built = build({ timings: { batteryIntervalMs: 1_800_000 } })
    await start(built)

    const interval = vi.spyOn(globalThis, 'setInterval')
    built.monitor.restrain('battery')

    expect(interval.mock.calls.at(-1)?.[1]).toBe(1_800_000)
  })

  it('leaves a setting already gentler than the floor exactly where it was put', async () => {
    const built = build({ timings: { batteryIntervalMs: 1_800_000 } })
    built.monitor.configure({ enabled: true, intervalSec: 7200 })
    await built.monitor.run()

    const interval = vi.spyOn(globalThis, 'setInterval')
    built.monitor.restrain('battery')

    expect(interval.mock.calls.at(-1)?.[1]).toBe(7_200_000)
  })

  it('goes back to the setting on mains', async () => {
    const built = build({ timings: { batteryIntervalMs: 1_800_000 } })
    await start(built)
    built.monitor.restrain('battery')

    const interval = vi.spyOn(globalThis, 'setInterval')
    built.monitor.restrain(null)

    expect(interval.mock.calls.at(-1)?.[1]).toBe(600_000)
  })

  it('keeps sweeping, just less often', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const built = build({ timings: { batteryIntervalMs: 1_800_000 } })
    await start(built)
    built.monitor.restrain('battery')
    network.requests.length = 0

    const tick = interval.mock.calls.at(-1)![0] as () => void
    tick()
    await built.monitor.run()

    expect(network.requestsTo('bsky.network').length).toBeGreaterThan(0)
  })

  it('says so on the dashboard and in the summary', async () => {
    const built = build()
    await start(built)

    built.monitor.restrain('battery')

    expect(built.monitor.snapshot().restraint).toBe('battery')
    expect(built.monitor.summary(true).restraint).toBe('battery')
    expect(built.snapshots.at(-1)?.restraint).toBe('battery')
  })

  it('ignores being told what it already knows', async () => {
    const built = build()
    await start(built)
    built.monitor.restrain('battery')
    const pushed = built.snapshots.length

    built.monitor.restrain('battery')

    expect(built.snapshots).toHaveLength(pushed)
  })
})

describe('a machine that is struggling', () => {
  it('lets the schedule come round and go away again without sweeping', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const built = build()
    await start(built)
    built.monitor.restrain('thermal')
    network.requests.length = 0

    const tick = interval.mock.calls.at(-1)![0] as () => void
    tick()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(network.requests).toHaveLength(0)
    expect(built.service(RELAY).history).toHaveLength(1)
  })

  it('still sweeps when the user asks for it themselves', async () => {
    const built = build()
    await start(built)
    built.monitor.restrain('thermal')
    network.requests.length = 0

    await built.monitor.run()

    expect(network.requestsTo('bsky.network').length).toBeGreaterThan(0)
  })

  it('does not sweep at once when the checks are switched on under load', async () => {
    const built = build()
    built.monitor.restrain('thermal')
    built.monitor.configure({ enabled: true, intervalSec: 600 })

    expect(network.requests).toHaveLength(0)
  })

  it('outranks the battery it is almost certainly also on', async () => {
    const built = build()
    await start(built)

    built.monitor.restrain('thermal')

    expect(built.monitor.snapshot().restraint).toBe('thermal')
  })
})

describe('being told the connection is back', () => {
  it('asks the controls now instead of waiting out the retry', async () => {
    const built = build({ timings: { offlineRetryMs: 600_000 } })
    await start(built)
    network.goOffline()
    await built.monitor.run()
    network.goOnline()
    network.requests.length = 0

    built.monitor.connectionRestored()

    await vi.waitFor(() => expect(built.monitor.snapshot().offline).toBe(false))
    // The controls answer first and the full sweep follows on their verdict.
    await vi.waitFor(() => expect(built.service(RELAY).history).toHaveLength(2))
  })

  it('does nothing when the checks never thought we were offline', async () => {
    const built = build({ timings: { offlineRetryMs: 600_000 } })
    await start(built)
    network.requests.length = 0

    built.monitor.connectionRestored()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(network.requests).toHaveLength(0)
  })

  it('does nothing while the machine is asleep, or the checks are off', async () => {
    const built = build({ timings: { offlineRetryMs: 600_000 } })
    await start(built)
    network.goOffline()
    await built.monitor.run()
    built.monitor.pause()
    network.goOnline()
    network.requests.length = 0

    built.monitor.connectionRestored()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(network.requests).toHaveLength(0)

    const off = build()
    off.monitor.connectionRestored()
    expect(network.requests).toHaveLength(0)
  })
})

describe('the concurrency cap', () => {
  it('never has more services in flight than it is allowed', async () => {
    let inFlight = 0
    let peak = 0
    const slow = {
      ...network,
      fetch: async (url: string, init: RequestInit): Promise<Response> => {
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          return await network.fetch(url, init)
        } finally {
          inFlight--
        }
      },
      openSocket: network.openSocket
    }
    const ids = SERVICES.filter((s) => s.kind === 'pds').map((s) => s.id)
    const built = build({
      ids: [...ids, ...CONTROLS],
      transport: slow as unknown as FakeNetwork,
      timings: { concurrency: 2 }
    })
    await start(built)

    // A PDS opens three requests at once, so two at a time is six, plus the controls,
    // which are never queued because everything else waits on their verdict. Uncapped
    // it would be all twelve PDSes at once.
    const perService = 3
    expect(peak).toBeLessThanOrEqual(2 * perService + CONTROLS.length)
    expect(peak).toBeLessThan(ids.length * perService)
    expect(ids.every((id) => built.service(id).state === 'live')).toBe(true)
  })

  it('still finishes when the cap is smaller than the number of AppViews', async () => {
    // The AppViews wait on each other to compare indexes. Queue them behind a cap and
    // the pool fills with services waiting on services that never started, so they are
    // deliberately kept out of it. This is the test that would hang if they were not.
    const ids = SERVICES.filter((s) => s.kind === 'appview').map((s) => s.id)
    const built = build({ ids: [...ids, ...CONTROLS], timings: { concurrency: 1 } })
    await start(built)
    expect(ids.every((id) => built.service(id).state === 'live')).toBe(true)
  })
})
