import { afterEach, describe, expect, it, vi } from 'vitest'
import { powerMonitor } from '../test/electron'
import type { SweepRestraint } from '../shared/types'
import { watchPower, type PowerDeps, type Presence } from './power'

/**
 * Every one of these events is next to impossible to raise honestly from a test run:
 * `suspend` needs a lid, `on-battery` needs a cable, and `thermal-state-change` needs a
 * laptop that has been rendering video for ten minutes. The `powerMonitor` double is an
 * event emitter with the three readable states beside it, so a test can put the machine
 * in a condition and then watch what the app does about it.
 */

interface Watched extends Presence {
  deps: { [K in keyof PowerDeps]: ReturnType<typeof vi.fn> }
  /** Every restraint handed over, in order, including the one read at startup. */
  restraints(): (SweepRestraint | null)[]
}

afterEach(() => {
  // `spyOn` hands back the spy already on a method rather than a fresh one, so a
  // leftover from the previous test would carry its calls into the next.
  vi.restoreAllMocks()
})

function watch(): Watched {
  const deps = {
    suspend: vi.fn(),
    resume: vi.fn(),
    restrain: vi.fn(),
    returned: vi.fn(),
    shutdown: vi.fn()
  }
  const presence = watchPower(deps)
  return {
    deps,
    away: () => presence.away(),
    restraints: () => deps.restrain.mock.calls.map(([restraint]) => restraint)
  }
}

/** The event object Electron hands a `shutdown` listener, which the typings omit. */
function shutdownEvent(): { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn() }
}

describe('what the machine is running on', () => {
  it('reads the battery at startup rather than waiting for a cable to move', () => {
    powerMonitor.onBattery = true
    const watched = watch()
    expect(watched.restraints()).toEqual(['battery'])
  })

  it('says nothing at all about a machine on mains and running cool', () => {
    const watched = watch()
    expect(watched.restraints()).toEqual([null])
  })

  it('widens the schedule when the cable comes out and restores it when it goes back', () => {
    const watched = watch()

    powerMonitor.emit('on-battery')
    powerMonitor.emit('on-ac')

    expect(watched.restraints()).toEqual([null, 'battery', null])
  })
})

describe('what the machine is coping with', () => {
  it('reads the thermal state at startup, like the battery', () => {
    powerMonitor.thermalState = 'critical'
    const watched = watch()
    expect(watched.restraints()).toEqual(['thermal'])
  })

  it.each([
    ['nominal', null],
    ['fair', null],
    ['serious', 'thermal'],
    ['critical', 'thermal'],
    ['unknown', null]
  ] as const)('reads %s as %s', (state, expected) => {
    const watched = watch()
    powerMonitor.emit('thermal-state-change', { state })
    expect(watched.restraints().at(-1)).toBe(expected)
  })

  it('treats a CPU ceiling cut well below full speed the same way', () => {
    const watched = watch()

    powerMonitor.emit('speed-limit-change', { limit: 30 })
    expect(watched.restraints().at(-1)).toBe('thermal')

    powerMonitor.emit('speed-limit-change', { limit: 100 })
    expect(watched.restraints().at(-1)).toBeNull()
  })

  it('leaves a machine merely coping alone', () => {
    const watched = watch()
    powerMonitor.emit('speed-limit-change', { limit: 90 })
    expect(watched.restraints().at(-1)).toBeNull()
  })

  it('outranks the battery, and hands it back when the machine cools', () => {
    const watched = watch()

    powerMonitor.emit('on-battery')
    powerMonitor.emit('thermal-state-change', { state: 'serious' })
    expect(watched.restraints().at(-1)).toBe('thermal')

    powerMonitor.emit('thermal-state-change', { state: 'nominal' })
    expect(watched.restraints().at(-1)).toBe('battery')
  })
})

describe('a machine going away and coming back', () => {
  it('puts the schedules down for a suspend and back up on resume', () => {
    const watched = watch()

    powerMonitor.emit('suspend')
    expect(watched.deps.suspend).toHaveBeenCalledTimes(1)
    expect(watched.deps.resume).not.toHaveBeenCalled()

    powerMonitor.emit('resume')
    expect(watched.deps.resume).toHaveBeenCalledTimes(1)
    expect(watched.deps.returned).toHaveBeenCalledTimes(1)
  })

  it('leaves the schedules alone for a locked screen, which is a machine still awake', () => {
    const watched = watch()

    powerMonitor.emit('lock-screen')

    expect(watched.deps.suspend).not.toHaveBeenCalled()
    expect(watched.away()).toBe(true)
  })

  it.each(['lock-screen', 'user-did-resign-active'])('is away after %s', (event) => {
    const watched = watch()
    expect(watched.away()).toBe(false)
    powerMonitor.emit(event)
    expect(watched.away()).toBe(true)
  })

  it.each(['resume', 'unlock-screen', 'user-did-become-active'])(
    'is back, and catching up, after %s',
    (event) => {
      const watched = watch()
      powerMonitor.emit('lock-screen')

      powerMonitor.emit(event)

      expect(watched.away()).toBe(false)
      expect(watched.deps.resume).toHaveBeenCalledTimes(1)
      expect(watched.deps.returned).toHaveBeenCalledTimes(1)
    }
  )
})

describe('whether anybody is there', () => {
  it.each([
    ['active', false],
    ['idle', true],
    ['locked', true],
    // A platform that cannot tell us is not a reason to hold a banner back: the cost of
    // one nobody sees is smaller than the cost of one nobody gets.
    ['unknown', false]
  ] as const)('reads an idle state of %s as away: %s', (idleState, expected) => {
    powerMonitor.idleState = idleState
    expect(watch().away()).toBe(expected)
  })

  it('asks about a real absence rather than a keystroke', () => {
    const idle = vi.spyOn(powerMonitor, 'getSystemIdleState')
    watch().away()
    expect(idle).toHaveBeenCalledWith(300)
  })

  it('does not bother asking once an event has said so outright', () => {
    const watched = watch()
    powerMonitor.emit('lock-screen')
    const idle = vi.spyOn(powerMonitor, 'getSystemIdleState')

    expect(watched.away()).toBe(true)
    expect(idle).not.toHaveBeenCalled()
  })
})

describe('a logout the user did not start from the tray', () => {
  it('takes the delay the OS offers and gives it straight back', () => {
    const watched = watch()
    const event = shutdownEvent()

    powerMonitor.emit('shutdown', event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(watched.deps.shutdown).toHaveBeenCalledTimes(1)
  })
})
