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
 *
 * The schedule itself answers to the machine as well as to the settings. `pause` puts it
 * down for a suspend and `resume` picks it back up; `restrain` widens it on battery and
 * stops it altogether under thermal pressure. All three leave everything measured so far
 * alone — they are about when to ask again, never about what the answers meant.
 *
 * What the services are asked about — the probe targets — can change under a running
 * monitor too, when the user edits them. `retarget` takes the new ones, rebuilds the rows
 * that depend on them, and measures again at once.
 */
import { DEFAULT_PROBE_TARGETS } from '../shared/probe-targets'
import {
  HISTORY_LENGTH,
  blankService,
  isControl,
  isReachable,
  medianLatency,
  observedCondition,
  probeState,
  servicesFor,
  summarizeNetwork,
  type ProbeEvent,
  type ServiceDefinition
} from '../shared/network'
import type {
  NetworkSnapshot,
  NetworkSummary,
  ProbeTargets,
  ServiceProbe,
  SweepRestraint
} from '../shared/types'
import {
  DEFAULT_PROBE_TIMINGS,
  FreshnessPeers,
  probeService,
  type NewestPosts,
  type ProbeCounters,
  type ProbeTimings,
  type ProbeTransport
} from './probes'

export interface MonitorTimings extends ProbeTimings {
  /** Delay before re-checking a service that just failed. */
  recheckDelayMs: number
  /**
   * How often to look for the connection coming back while offline.
   *
   * The popover's renderer normally beats this to it: Chromium raises `online` the
   * instant the interface is back and `connectionRestored()` retries there and then, so
   * this is the fallback for the times there is no renderer to hear from — before the
   * first window exists, and while one whose renderer died waits to be rebuilt. It is
   * deliberately slower than the thirty seconds it used to be, because polling a
   * connection that is down is the one thing in here with nothing at all to show for it.
   */
  offlineRetryMs: number
  /**
   * Least time between scheduled sweeps while the machine is on battery.
   *
   * A floor rather than a multiplier, and deliberately: the user's `networkIntervalSec`
   * is a preference about how current they want the dashboard, not a promise about how
   * much of their battery the app may spend. Multiplying would punish the considerate —
   * somebody who already asked for hourly sweeps would get three-hourly ones — where a
   * floor only ever touches the settings that are more eager than this, and leaves
   * anybody already gentler than it exactly where they put themselves.
   */
  batteryIntervalMs: number
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
  offlineRetryMs: 120_000,
  batteryIntervalMs: 30 * 60_000,
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
  /**
   * A fixed set of rows, for a test that wants only a few. Without it the rows are the
   * whole catalogue under the targets in force, and follow them through `retarget`.
   */
  services?: readonly ServiceDefinition[]
  /** What the services are asked about. Default: the checked-in `probeTargets.json`. */
  targets?: ProbeTargets
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
  private catalogue: readonly ServiceDefinition[]
  private controls: readonly ServiceDefinition[]
  private targets: ProbeTargets
  private readonly timings: MonitorTimings
  private readonly now: () => number
  private readonly services = new Map<string, ServiceProbe>()
  private readonly pending = new Map<string, Pending>()

  private enabled = false
  private intervalMs = 0
  private running = false
  private offline = false
  /** The machine is asleep or locked away; the schedule is down until it is back. */
  private paused = false
  /** What the machine's own condition is doing to the schedule. See `SweepRestraint`. */
  private restraint: SweepRestraint | null = null
  private startedAt: string | null = null
  private finishedAt: string | null = null
  /** Freshest newest-post time any AppView has returned per account, for the laggards. */
  private freshest: NewestPosts = new Map()
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
    this.targets = options.targets ?? DEFAULT_PROBE_TARGETS
    this.catalogue = options.services ?? servicesFor(this.targets)
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
      restraint: this.restraint,
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
    // A paused monitor counts as scheduled: it has a schedule, it is just not running
    // it, and re-arming the interval here would quietly undo the pause.
    const scheduled = this.interval !== null || this.paused || !this.transport
    if (enabled === this.enabled && intervalMs === this.intervalMs && (scheduled || !enabled)) {
      return
    }

    const wasEnabled = this.enabled
    this.enabled = enabled
    this.intervalMs = intervalMs

    if (!enabled) {
      this.clearInterval()
      this.reset()
      return
    }

    this.schedule()
    // Turning the checks on is the user asking for an answer now — unless the machine is
    // asleep, or too hot to be asked, in which case the schedule will get to it.
    if (
      this.interval &&
      (!wasEnabled || this.finishedAt === null) &&
      this.restraint !== 'thermal'
    ) {
      void this.run()
    }
  }

  /**
   * Put the schedule down while the machine is away, keeping everything else up.
   *
   * This is not `stop()` with a nicer name, even though it does the same work: `stop()`
   * is teardown and the model's own `stop()` takes the webhook receiver down with it,
   * which is exactly wrong for a lid closing. What has to go is the *schedule*, because
   * `setInterval` does not sleep with the machine — a lid shut for eight hours wakes to
   * a queue of missed fires landing at once, on a laptop whose Wi-Fi has not come back,
   * which is a burst of failures followed by a burst of recoveries on the Timeline,
   * none of which describe anything that happened to the Atmosphere.
   */
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.stop()
  }

  /**
   * Put the schedule back. Catching up on what was missed is the caller's to ask for:
   * a machine that has just woken wants a sweep now, and `src/main/index.ts` runs one.
   */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.schedule()
  }

  /**
   * Tell the schedule what the machine's own condition is; see `SweepRestraint`.
   *
   * Nothing is swept the moment a restraint lifts. The next scheduled sweep is soon
   * enough, and a machine that has just come out of thermal trouble is the last one to
   * hand a hundred fresh connections to.
   */
  restrain(restraint: SweepRestraint | null): void {
    if (restraint === this.restraint) return
    this.restraint = restraint
    // The interval's length depends on it, and `setInterval` cannot be re-timed.
    this.schedule()
    this.flushSnapshot()
    this.options.onSummaryChange()
  }

  /**
   * Somebody claims the connection is back. Look now rather than at the retry.
   *
   * Only meaningful while the control checks say we are offline: at any other time there
   * is nothing to confirm and the ordinary schedule is already doing the right thing. It
   * runs the same control-only sweep the offline retry would have, which is the cheap
   * question — five requests, not a hundred — and a full sweep follows it if the answer
   * is yes.
   */
  connectionRestored(): void {
    if (!this.enabled || !this.transport || this.paused || !this.offline) return
    this.clearFollowUp()
    this.retryControls()
  }

  /**
   * Ask the services about something else from now on: the user changed the targets.
   *
   * Everything measured is kept — a row's history is about the service, not about which
   * accounts it was asked about — except what was measured *of the old targets* and not
   * yet settled. A sweep in flight, and a re-check waiting to confirm a failure, would
   * both finish by judging the old accounts and documents under the new settings, so
   * they are dropped and the new targets are measured at once instead, whenever the
   * schedule would allow a sweep at all. The rows that follow the targets — one per feed
   * — are rebuilt; a row that stays keeps its history, one that goes is forgotten.
   *
   * The freshest AppView posts are forgotten too, so the new accounts are judged on what
   * the AppViews say about them now rather than on anything remembered of the old ones.
   */
  retarget(targets: ProbeTargets): void {
    this.targets = targets
    if (!this.options.services) this.recatalogue(servicesFor(targets))
    this.freshest = new Map()

    this.clearFollowUp()
    this.abandon()
    this.running = false
    for (const service of this.services.values()) service.rechecking = false
    this.flushSnapshot()
    this.options.onSummaryChange()

    // Exactly the conditions under which the schedule itself would sweep.
    if (this.enabled && this.transport && !this.paused && this.restraint !== 'thermal') {
      void this.run()
    }
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

  private async sweep(requested: readonly ServiceDefinition[], full: boolean): Promise<void> {
    if (!this.enabled || !this.transport) return
    const generation = this.generation
    const started = new Date(this.now()).toISOString()
    // Only rows that still exist. `retarget` cancels any re-check that could name a feed
    // since taken off the list, but a sweep is the wrong place to find out it missed one.
    const definitions = requested.filter((definition) => this.services.has(definition.id))

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
      counters: this.counters,
      // Read here, once, rather than at import: a sweep measures whatever was in force
      // when it started, and the next one picks up any change.
      targets: this.targets
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
        // A disowned sweep starts nothing new. The pool keeps handing out what was queued
        // behind it, and after a `retarget` some of those rows no longer exist.
        const service = this.services.get(definition.id)
        if (!service || generation !== this.generation) return
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

    // The peers started from what was remembered and only ever moved forward.
    this.freshest = peers.best
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

  /**
   * (Re)arm the interval to match the settings, the restraint and whether we are paused.
   *
   * One place decides, because three things can change the answer independently and an
   * interval cannot be re-timed once it is running.
   */
  private schedule(): void {
    this.clearInterval()
    if (!this.enabled || !this.transport || this.paused) return

    this.interval = setInterval(() => this.tick(), this.scheduledIntervalMs())
    // A schedule should never be the reason the process stays alive.
    this.interval.unref?.()
  }

  /** How long the schedule actually waits, which is not always what the settings say. */
  private scheduledIntervalMs(): number {
    return this.restraint === 'battery'
      ? Math.max(this.intervalMs, this.timings.batteryIntervalMs)
      : this.intervalMs
  }

  /**
   * The schedule came round. Under thermal pressure it goes away again without sweeping:
   * whatever it measured would be this machine's throttling read as the services' own
   * latency, and measuring honestly is the whole of this app's claim.
   */
  private tick(): void {
    if (this.restraint === 'thermal') return
    void this.run()
  }

  /** The cheap question — is anything reachable at all — and a full sweep if it is. */
  private retryControls(): void {
    void this.enqueue(() => this.sweep(this.controls, false)).then(() => {
      // Back online: everything else is stale, so measure it all again now.
      if (!this.offline) void this.run()
    })
  }

  /** Book the next look: a control-only retry while offline, or a failure's re-check. */
  private scheduleFollowUp(recheck: ServiceDefinition[]): void {
    this.clearFollowUp()
    if (this.offline) {
      this.followUp = setTimeout(() => {
        this.followUp = null
        this.retryControls()
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
    this.freshest = new Map()
    this.flushSnapshot()
    this.options.onSummaryChange()
  }

  private resetServices(): void {
    this.services.clear()
    for (const definition of this.catalogue) {
      this.services.set(definition.id, blankService(definition))
    }
  }

  /**
   * Swap in a new set of rows, keeping everything known about the ones that stay.
   *
   * A row that stays may still have changed how it is described — a feed relabelled, on
   * the same host — so it takes the new definition over its old measurements. A row that
   * is gone takes its unconfirmed failure with it.
   */
  private recatalogue(catalogue: readonly ServiceDefinition[]): void {
    const ids = new Set(catalogue.map((definition) => definition.id))
    // Deleting from a Map while iterating it is well defined: nothing is skipped.
    for (const id of this.services.keys()) {
      if (ids.has(id)) continue
      this.services.delete(id)
      this.pending.delete(id)
    }
    for (const definition of catalogue) {
      const service = this.services.get(definition.id)
      if (service) Object.assign(service, definition)
      else this.services.set(definition.id, blankService(definition))
    }
    this.catalogue = catalogue
    this.controls = catalogue.filter(isControl)
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
