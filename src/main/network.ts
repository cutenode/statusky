/**
 * Runs the network checks and decides what they mean.
 *
 * A sweep probes every service at once. What a sweep *observed* is shown on the
 * dashboard straight away; what it *means* — the condition that files feed entries,
 * sends notifications and colours the tray — is debounced:
 *
 * - A failure is not believed until it is seen twice in a row. The first sighting books
 *   a quick re-check of just that service, so a real outage is confirmed in seconds
 *   rather than at the next sweep, and one dropped request never pages anybody.
 * - A recovery is believed at once.
 * - Nothing waits for the sweep. Each service is settled, recorded and judged the moment
 *   its own checks are in, so a relay that answered in 200ms is not shown as still being
 *   checked because a PDS is going to spend 30 seconds timing out.
 * - Nothing is believed while this machine is offline. The Internet control group tells
 *   an outage of the Atmosphere apart from an outage of the user's Wi-Fi; when every
 *   control check fails, the sweep changes nothing, and a cheap control-only retry runs
 *   until the connection is back, followed by a full sweep.
 */
import {
  HISTORY_LENGTH,
  SERVICES,
  blankService,
  isControl,
  isReachable,
  medianLatency,
  observedCondition,
  probeState,
  summarizeNetwork,
  type ProbeEvent,
  type ServiceDefinition
} from '../shared/network'
import type { NetworkSnapshot, NetworkSummary, ServiceProbe } from '../shared/types'
import {
  DEFAULT_PROBE_TIMINGS,
  FreshnessPeers,
  probeService,
  type ProbeCounters,
  type ProbeTimings,
  type ProbeTransport
} from './probes'

export interface MonitorTimings extends ProbeTimings {
  /** Delay before re-checking a service that just failed. */
  recheckDelayMs: number
  /** How often to look for the connection coming back while offline. */
  offlineRetryMs: number
  /** Least time between two dashboard pushes while a sweep is filling in. */
  throttleMs: number
  /** Consecutive failing observations before a failure is believed. */
  confirmations: number
  /**
   * Services probed at once. The catalogue is around forty rows and each asks two to
   * nine questions, so without a ceiling a sweep opens a couple of hundred connections
   * in the same instant — hard on a laptop's network stack and rude to the small
   * operators on the receiving end, one of whom runs their index on a Raspberry Pi at
   * home. This trades peak sockets for wall clock, and only in the worst case: every
   * service is still settled and judged the moment its own checks are in.
   */
  concurrency: number
}

export const DEFAULT_MONITOR_TIMINGS: MonitorTimings = {
  ...DEFAULT_PROBE_TIMINGS,
  recheckDelayMs: 20_000,
  offlineRetryMs: 30_000,
  throttleMs: 150,
  confirmations: 2,
  concurrency: 16
}

/**
 * Run `work` over `items`, at most `limit` at a time, in order.
 *
 * Nothing here may be given work that waits on another item's result: two of the
 * rendezvous in a sweep — the control group's verdict on the connection, and the
 * AppViews comparing indexes — would deadlock if the pool filled with services waiting
 * on services that had not started. `sweep` keeps those out of the pool for that reason.
 */
async function pooled<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      // Sequential on purpose: one runner is one slot, and the queue is the ceiling.
      // oxlint-disable-next-line no-await-in-loop
      await work(items[next++]!)
    }
  })
  await Promise.all(runners)
}

export interface NetworkMonitorOptions {
  /** Null means nothing is ever probed: the dashboard stays empty. */
  transport: ProbeTransport | null
  services?: readonly ServiceDefinition[]
  timings?: Partial<MonitorTimings>
  now?: () => number
  /** The dashboard changed. Throttled while a sweep is filling in. */
  onSnapshot(snapshot: NetworkSnapshot): void
  /** Something the summary shows may have changed: a sweep started or finished. */
  onSummaryChange(): void
  /** Confirmed changes in condition, oldest service first. */
  onEvents(events: ProbeEvent[]): void
}

/** A failure seen but not yet believed. */
interface Pending {
  condition: 'partial' | 'down'
  streak: number
}

/**
 * Whether this machine can reach anything, settled as early as it can be.
 *
 * Nothing about the Atmosphere can be judged until the control checks have spoken, but
 * waiting for all of them would hold every other verdict back: the first control to
 * answer proves the connection, and only every one of them failing means offline. A
 * service that has finished waits on this and on nothing else.
 */
class ConnectionVerdict {
  private online: boolean | null = null
  private readonly waiting: ((online: boolean) => void)[] = []

  constructor(
    private remaining: number,
    signal: AbortSignal
  ) {
    // An abandoned sweep judges nothing, and must never leave a service waiting.
    signal.addEventListener('abort', () => this.settle(false), { once: true })
    if (remaining === 0) this.settle(true)
  }

  /** Record how one control check turned out. */
  report(reachable: boolean): void {
    if (this.online !== null) return
    this.remaining--
    if (reachable) this.settle(true)
    else if (this.remaining === 0) this.settle(false)
  }

  settled(): Promise<boolean> {
    if (this.online !== null) return Promise.resolve(this.online)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private settle(online: boolean): void {
    if (this.online !== null) return
    this.online = online
    for (const wake of this.waiting.splice(0)) wake(online)
  }
}

export class NetworkMonitor {
  private readonly transport: ProbeTransport | null
  private readonly catalogue: readonly ServiceDefinition[]
  private readonly controls: readonly ServiceDefinition[]
  private readonly timings: MonitorTimings
  private readonly now: () => number
  private readonly services = new Map<string, ServiceProbe>()
  private readonly pending = new Map<string, Pending>()

  private enabled = false
  private intervalMs = 0
  private running = false
  private offline = false
  private startedAt: string | null = null
  private finishedAt: string | null = null
  /** Freshest newest-post time any AppView has returned, for judging the laggards. */
  private freshest: number | null = null
  /** What one sweep leaves for the next: counters to compare, and slow checks' clocks. */
  private readonly tallies = new Map<string, number>()
  private readonly counters: ProbeCounters = {
    get: (key) => this.tallies.get(key) ?? null,
    set: (key, value) => {
      this.tallies.set(key, value)
    }
  }

  /** Confirmed changes waiting to be handed over, coalesced within a tick. */
  private events: ProbeEvent[] = []
  private eventsQueued = false

  private interval: ReturnType<typeof setInterval> | null = null
  private followUp: ReturnType<typeof setTimeout> | null = null
  private throttle: ReturnType<typeof setTimeout> | null = null
  /** Sweeps run one at a time, in order. */
  private queue: Promise<void> = Promise.resolve()
  private fullSweep: Promise<void> | null = null
  /** Bumped to disown sweeps still in flight when checks are reset or stopped. */
  private generation = 0
  private controller = new AbortController()

  constructor(private readonly options: NetworkMonitorOptions) {
    this.transport = options.transport
    this.catalogue = options.services ?? SERVICES
    this.controls = this.catalogue.filter(isControl)
    this.timings = { ...DEFAULT_MONITOR_TIMINGS, ...options.timings }
    this.now = options.now ?? Date.now
    this.resetServices()
  }

  // ------------------------------------------------------------ reading

  snapshot(): NetworkSnapshot {
    return {
      running: this.running,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      offline: this.offline,
      services: this.catalogue.map((definition) => {
        const service = this.services.get(definition.id)!
        return {
          ...service,
          checks: service.checks.map((check) => ({ ...check })),
          history: [...service.history]
        }
      })
    }
  }

  summary(enabled: boolean): NetworkSummary {
    return summarizeNetwork(this.snapshot(), enabled)
  }

  // ------------------------------------------------------------ control

  /**
   * Match the schedule to the settings. Turning checks on sweeps at once; changing only
   * the interval does not. Turning them off forgets everything measured so far.
   */
  configure({ enabled, intervalSec }: { enabled: boolean; intervalSec: number }): void {
    const intervalMs = Math.max(1, intervalSec) * 1000
    const scheduled = this.interval !== null || !this.transport
    if (enabled === this.enabled && intervalMs === this.intervalMs && (scheduled || !enabled)) {
      return
    }

    const wasEnabled = this.enabled
    this.enabled = enabled
    this.intervalMs = intervalMs
    this.clearInterval()

    if (!enabled) {
      this.reset()
      return
    }
    if (!this.transport) return

    this.interval = setInterval(() => void this.run(), intervalMs)
    // A schedule should never be the reason the process stays alive.
    this.interval.unref?.()
    if (!wasEnabled || this.finishedAt === null) void this.run()
  }

  /** Sweep everything now. Calls made while a sweep is queued or running share it. */
  run(): Promise<void> {
    if (!this.enabled || !this.transport) return Promise.resolve()
    this.fullSweep ??= this.enqueue(async () => {
      await this.sweep(this.catalogue, true)
    }).finally(() => {
      this.fullSweep = null
    })
    return this.fullSweep
  }

  /** Stop every timer and abandon the sweep in flight. The measurements are kept. */
  stop(): void {
    this.clearInterval()
    this.clearFollowUp()
    if (this.throttle) clearTimeout(this.throttle)
    this.throttle = null
    this.abandon()
    this.running = false
    for (const service of this.services.values()) service.rechecking = false
  }

  // ------------------------------------------------------------ sweeping

  private enqueue(task: () => Promise<void>): Promise<void> {
    // A sweep that throws — a listener failing mid-push, say — is a bug, but it must not
    // take the schedule down with it, or leave the dashboard claiming to be mid-sweep.
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.running = false
      console.error('A network sweep failed:', error)
    })
    return this.queue
  }

  private async sweep(definitions: readonly ServiceDefinition[], full: boolean): Promise<void> {
    if (!this.enabled || !this.transport) return
    const generation = this.generation
    const started = new Date(this.now()).toISOString()

    if (full) {
      this.running = true
      this.startedAt = started
    }
    for (const definition of definitions) {
      const service = this.services.get(definition.id)!
      service.checks = []
      service.state = 'pending'
      service.startedAt = started
      service.checkedAt = null
      service.latencyMs = null
    }
    this.flushSnapshot()
    if (full) this.options.onSummaryChange()

    const peers = new FreshnessPeers(
      definitions.filter((definition) => definition.kind === 'appview').length,
      this.freshest
    )
    const connection = new ConnectionVerdict(
      definitions.filter(isControl).length,
      this.controller.signal
    )
    const context = {
      transport: this.transport,
      signal: this.controller.signal,
      timings: this.timings,
      now: this.now,
      // A disowned sweep winding down must not keep pushing its cancellations.
      changed: () => {
        if (generation === this.generation) this.scheduleSnapshot()
      },
      peers,
      counters: this.counters
    }
    const recheck: ServiceDefinition[] = []

    // Being offline is news in its own right, and it is known as soon as the controls
    // are, rather than when the services they excuse have finished failing.
    void connection.settled().then((online) => {
      if (generation !== this.generation || this.offline === !online) return
      this.offline = !online
      this.flushSnapshot()
      this.options.onSummaryChange()
    })

    const one = async (definition: ServiceDefinition): Promise<void> => {
      {
        const service = this.services.get(definition.id)!
        await probeService(definition, service.checks, context)
        // Checks were switched off, or the app is quitting: this result is moot.
        if (generation !== this.generation) return

        const at = new Date(this.now()).toISOString()
        service.state = probeState(service.checks)
        service.latencyMs = medianLatency(service.checks)
        service.checkedAt = at
        service.rechecking = false
        this.scheduleSnapshot()

        if (isControl(definition)) {
          service.history = this.remember(service, at)
          connection.report(isReachable(service.state))
          return
        }

        const online = await connection.settled()
        if (generation !== this.generation) return
        // Offline, a red bar would record the user's connection, not the service.
        if (!online) return

        service.history = this.remember(service, at)
        const verdict = this.judge(definition, service, at)
        if (verdict === 'recheck') {
          service.rechecking = true
          recheck.push(definition)
        } else if (verdict) {
          this.file(verdict)
        }
        this.scheduleSnapshot()
      }
    }

    // Two rendezvous happen mid-sweep: every service waits on the control group's
    // verdict about the connection, and the AppViews wait on each other to compare
    // indexes. Anything that waits like that has to be already running, or the pool
    // fills with services waiting on services that never started — so the controls and
    // the AppViews are never queued, and everything else is.
    await Promise.all([
      ...definitions.filter((d) => isControl(d) || d.kind === 'appview').map(one),
      pooled(
        definitions.filter((d) => !isControl(d) && d.kind !== 'appview'),
        this.timings.concurrency,
        one
      )
    ])
    if (generation !== this.generation) return

    if (peers.best !== null) this.freshest = Math.max(this.freshest ?? 0, peers.best)
    if (full) {
      this.running = false
      this.finishedAt = new Date(this.now()).toISOString()
    }
    this.flushSnapshot()
    this.flushEvents()
    this.options.onSummaryChange()
    this.scheduleFollowUp(recheck)
  }

  /** Add one observation to a service's recent history, oldest first. */
  private remember(service: ServiceProbe, at: string): ServiceProbe['history'] {
    return [...service.history, { at, state: service.state, latencyMs: service.latencyMs }].slice(
      -HISTORY_LENGTH
    )
  }

  /**
   * Hand over a confirmed change. Services that fall over together — as they do when a
   * whole region goes — finish within a tick of each other, so their changes are
   * gathered into one handover rather than filed one by one.
   */
  private file(event: ProbeEvent): void {
    this.events.push(event)
    if (this.eventsQueued) return
    this.eventsQueued = true
    queueMicrotask(() => this.flushEvents())
  }

  private flushEvents(): void {
    this.eventsQueued = false
    const events = this.events.splice(0)
    if (!events.length) return
    this.flushSnapshot()
    this.options.onSummaryChange()
    this.options.onEvents(events)
  }

  /**
   * Move one service's condition on from a finished observation. Returns the event
   * worth filing, `'recheck'` when a failure needs seeing again first, or null.
   */
  private judge(
    definition: ServiceDefinition,
    service: ServiceProbe,
    at: string
  ): ProbeEvent | 'recheck' | null {
    const observed = observedCondition(service.state)
    const from = service.condition
    if (observed === null || observed === from) {
      this.pending.delete(definition.id)
      return null
    }

    if (observed !== 'up') {
      const previous = this.pending.get(definition.id)
      const streak = previous?.condition === observed ? previous.streak + 1 : 1
      if (streak < this.timings.confirmations) {
        this.pending.set(definition.id, { condition: observed, streak })
        return 'recheck'
      }
    }

    this.pending.delete(definition.id)
    const since = service.since
    service.condition = observed
    service.since = at
    // The first reading of a healthy service is not news.
    if (from === 'unknown' && observed === 'up') return null
    return {
      service: definition,
      from,
      to: observed,
      at,
      since,
      checks: service.checks.map((check) => ({ ...check }))
    }
  }

  /** Book the next look: a control-only retry while offline, or a failure's re-check. */
  private scheduleFollowUp(recheck: ServiceDefinition[]): void {
    this.clearFollowUp()
    if (this.offline) {
      this.followUp = setTimeout(() => {
        this.followUp = null
        void this.enqueue(() => this.sweep(this.controls, false)).then(() => {
          // Back online: everything else is stale, so measure it all again now.
          if (!this.offline) void this.run()
        })
      }, this.timings.offlineRetryMs)
    } else if (recheck.length) {
      this.followUp = setTimeout(() => {
        this.followUp = null
        // The controls ride along, so a connection that dropped in between is noticed
        // rather than blamed on the services being re-checked.
        void this.enqueue(() => this.sweep([...recheck, ...this.controls], false))
      }, this.timings.recheckDelayMs)
    } else {
      return
    }
    this.followUp.unref?.()
  }

  // ------------------------------------------------------------ plumbing

  private scheduleSnapshot(): void {
    if (this.throttle) return
    this.throttle = setTimeout(() => {
      this.throttle = null
      this.options.onSnapshot(this.snapshot())
    }, this.timings.throttleMs)
    this.throttle.unref?.()
  }

  private flushSnapshot(): void {
    if (this.throttle) clearTimeout(this.throttle)
    this.throttle = null
    this.options.onSnapshot(this.snapshot())
  }

  /** Forget everything measured and tell whoever is listening. */
  private reset(): void {
    this.clearFollowUp()
    this.abandon()
    this.resetServices()
    this.pending.clear()
    this.tallies.clear()
    this.running = false
    this.offline = false
    this.startedAt = null
    this.finishedAt = null
    this.freshest = null
    this.flushSnapshot()
    this.options.onSummaryChange()
  }

  private resetServices(): void {
    this.services.clear()
    for (const definition of this.catalogue) {
      this.services.set(definition.id, blankService(definition))
    }
  }

  /** Disown and cancel the sweep in flight, so its sockets and requests close now. */
  private abandon(): void {
    this.generation++
    this.events = []
    this.controller.abort()
    this.controller = new AbortController()
    this.fullSweep = null
  }

  private clearInterval(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
  }

  private clearFollowUp(): void {
    if (this.followUp) clearTimeout(this.followUp)
    this.followUp = null
  }
}
