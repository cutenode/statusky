/**
 * What the OS is willing to say about this machine, and what the app does about it.
 *
 * This app polls forever: the feed on `pollIntervalSec`, and a network sweep on
 * `networkIntervalSec` that is around a hundred small requests and five brief firehose
 * connections. The README argues that the defaults lean towards being a good citizen,
 * and they do — but the argument is made entirely from constants, against a machine the
 * app never asks about. The OS knows when the lid is shut, when the battery is the only
 * thing left, when the fans have given up and when nobody has touched the keyboard since
 * lunch, and every one of those makes the argument stronger for free.
 *
 * Nothing in here decides what a measurement *means*. It only decides when to ask, and
 * whether there is anybody there to tell. `PowerDeps` is the whole of what it can do,
 * which keeps the sensing here and the consequences where they belong.
 *
 * It lives beside `src/main/index.ts` rather than in it because the startup sequence
 * reads top to bottom and this is nine listeners with a policy behind them; inlined, it
 * would be the longest thing in the file and the least to do with starting up.
 */
import { powerMonitor } from 'electron'
import type { SweepRestraint } from '../shared/types'

/**
 * No input for this long and nobody is at the machine.
 *
 * Five minutes is lunch rather than a sip of coffee. Too short and a banner is held back
 * from somebody who is reading the screen and not typing; too long and the thing this
 * exists to prevent — a stack of banners about an incident that has already resolved —
 * happens anyway.
 */
const IDLE_SECONDS = 300

/**
 * Thermal states at which a sweep is not worth taking, from macOS's own scale.
 *
 * `fair` is a warm laptop and nothing more. `serious` is the point at which macOS starts
 * cutting the CPU ceiling and spinning the fans up, and `critical` is the point at which
 * it stops pretending. There is a correctness argument here as well as a politeness one:
 * latency measured through a machine being thermally throttled reads as latency the
 * services do not have, and this app's whole claim is that it measures honestly.
 */
const THERMAL_TROUBLE: ReadonlySet<string> = new Set(['serious', 'critical'])

/**
 * A CPU ceiling below this, in percent, counts as the machine being held back hard.
 *
 * `speed-limit-change` is the same signal from the other end — Windows reports it too,
 * where there is no thermal state to read — and 100 is the only value that means nothing
 * is wrong. A machine at 90% is coping; one at 40% is not, and neither is anything
 * trying to time a request through it.
 */
const SPEED_LIMIT_FLOOR = 50

export interface PowerDeps {
  /** The machine is going to sleep. Put the schedules down; they do not sleep with it. */
  suspend(): void
  /**
   * It is back, or the screen unlocked, or the user switched back in. Put the schedules
   * up and catch up: whatever is on screen and whatever was last measured are stale.
   * Called for every return, so it has to be safe when nothing was ever suspended.
   */
  resume(): void
  /** What the machine's own condition is doing to the sweep schedule, or null. */
  restrain(restraint: SweepRestraint | null): void
  /** Somebody is back at the machine: say whatever was held back while they were not. */
  returned(): void
  /** The OS is logging out or shutting down. Persist, stop, and get out of its way. */
  shutdown(): void
}

export interface Presence {
  /**
   * Whether nobody is at the machine, as far as the OS will say — asked at the moment a
   * banner would go up rather than kept as a flag, because the idle clock only answers
   * about right now.
   */
  away(): boolean
}

/**
 * Wire the power and presence events up to `deps`, and hand back the presence question.
 *
 * The current battery and thermal states are read here rather than waited for: a laptop
 * that has been unplugged for an hour emits nothing at launch, and an app that only
 * learns about the battery from the transition would sweep at full rate until the user
 * happened to plug in and out again.
 */
export function watchPower(deps: PowerDeps): Presence {
  /**
   * Nobody is here, said outright rather than inferred.
   *
   * The screen is locked, the machine is asleep, or another user has been switched in.
   * The idle clock in `away()` covers the case none of these do: somebody who walked
   * off without locking anything, which is the usual way of going to lunch.
   */
  let absent = false
  let onBattery = powerMonitor.isOnBatteryPower()
  let hot = THERMAL_TROUBLE.has(powerMonitor.getCurrentThermalState())
  let throttled = false

  /** Thermal outranks battery: it stops sweeps rather than spacing them out. */
  const restrain = (): void => {
    if (hot || throttled) {
      deps.restrain('thermal')
      return
    }
    deps.restrain(onBattery ? 'battery' : null)
  }

  const departed = (): void => {
    absent = true
  }

  const arrived = (): void => {
    absent = false
    deps.resume()
    deps.returned()
  }

  restrain()

  // Sleep is the only departure that stops the schedules. A locked screen and a switched
  // -away session are both machines that are still awake and still on the network, and
  // an app that stopped measuring whenever the screen locked would have nothing to show
  // for the night — which is exactly when the interesting outages happen.
  powerMonitor.on('suspend', () => {
    departed()
    deps.suspend()
  })
  powerMonitor.on('lock-screen', departed)
  // macOS fast user switching: somebody else is in front of this machine, so any banner
  // raised now goes up on their screen and is gone before ours comes back.
  powerMonitor.on('user-did-resign-active', departed)

  powerMonitor.on('resume', arrived)
  powerMonitor.on('unlock-screen', arrived)
  powerMonitor.on('user-did-become-active', arrived)

  powerMonitor.on('on-battery', () => {
    onBattery = true
    restrain()
  })
  powerMonitor.on('on-ac', () => {
    onBattery = false
    restrain()
  })

  powerMonitor.on('thermal-state-change', (details) => {
    hot = THERMAL_TROUBLE.has(details.state)
    restrain()
  })
  powerMonitor.on('speed-limit-change', (details) => {
    throttled = details.limit < SPEED_LIMIT_FLOOR
    restrain()
  })

  // `before-quit` covers the tray menu and everything else that goes through the app.
  // A logout or a reboot does not always route through it; this is the OS asking first.
  //
  // Electron types this listener as taking nothing, which is true of no event it emits:
  // the event object is always the first argument, and the documented contract for this
  // one is to call `preventDefault()` on it and then exit as soon as possible. Taking
  // the delay and giving it straight back is the whole of what a listener is for here —
  // asking for it and then dawdling is how an app hangs somebody's logout.
  const onShutdown = (event: Electron.Event): void => {
    event.preventDefault()
    deps.shutdown()
  }
  powerMonitor.on('shutdown', onShutdown as () => void)

  return {
    away(): boolean {
      if (absent) return true
      const idle = powerMonitor.getSystemIdleState(IDLE_SECONDS)
      // `unknown` is a platform that cannot tell us, and holding a banner back on the
      // strength of not knowing is the wrong way round: the cost of a banner nobody
      // sees is smaller than the cost of one nobody gets.
      return idle === 'idle' || idle === 'locked'
    }
  }
}
