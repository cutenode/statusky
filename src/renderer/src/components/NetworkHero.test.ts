import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import type { ServiceProbe } from '@shared/types'
import {
  makeCheck,
  makeNetworkSummary,
  makeService,
  makeSettings,
  makeSnapshot
} from '../../../test/factories'
import type { BridgeOptions } from '../../../test/bridge'
import { pushNetwork, renderWith, settle } from '../test/render'
import NetworkHero from './NetworkHero.svelte'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const FINISHED = '2026-01-01T11:58:00Z'

const relay = (overrides: Partial<ServiceProbe> = {}): ServiceProbe =>
  makeService({ id: 'relay:bsky.network', latencyMs: 200, ...overrides })
const pds = (overrides: Partial<ServiceProbe> = {}): ServiceProbe =>
  makeService({ id: 'pds:eurosky.social', latencyMs: 400, ...overrides })
const control = makeService({ id: 'internet:aws', latencyMs: 5 })

async function hero(options: BridgeOptions) {
  const onjump = vi.fn()
  const rendered = await renderWith(NetworkHero, { now: NOW, onjump }, options)
  return { ...rendered, onjump }
}

const title = (container: HTMLElement): HTMLElement => container.querySelector('h2')!

/** The region a screen reader is told things from. */
const live = (container: HTMLElement): HTMLElement =>
  container.querySelector('[aria-live="polite"]')!

describe('the verdict', () => {
  it('says the Atmosphere is reachable, how many answered and how quickly', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay(), pds(), control] }),
      network: makeNetworkSummary({ health: 'operational', total: 2, reachable: 2 })
    })
    expect(title(container).textContent?.trim()).toBe('The Atmosphere is reachable')
    expect(container.textContent).toContain('2 of 2 answering · median 400 ms')
    expect(container.textContent).toContain('Checked 2 minutes ago')
    // The ring counts the Atmosphere only, not the control checks.
    expect(container.querySelectorAll('path.ring-segment')).toHaveLength(2)
  })

  it('leaves the latency out when nothing was timed', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay({ latencyMs: null })] }),
      network: makeNetworkSummary({ health: 'operational', total: 1, reachable: 1 })
    })
    expect(container.textContent).toContain('1 of 1 answering')
    expect(container.textContent).not.toContain('median')
  })

  it('names the one service that is down, in red', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay({ state: 'down' })] }),
      network: makeNetworkSummary({ health: 'down', down: ['bsky.network'] })
    })
    expect(title(container).textContent?.trim()).toBe('bsky.network is unreachable')
    expect(title(container).className).toContain('text-sev-outage')
  })

  it('counts several services down', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay(), pds()] }),
      network: makeNetworkSummary({ health: 'down', down: ['a', 'b'] })
    })
    expect(title(container).textContent?.trim()).toBe('2 services unreachable')
  })

  it('names or counts degraded services, in amber', async () => {
    const one = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [pds({ state: 'partial' })] }),
      network: makeNetworkSummary({ health: 'degraded', degraded: ['eurosky.social'] })
    })
    expect(title(one.container).textContent?.trim()).toBe('eurosky.social is degraded')
    expect(title(one.container).className).toContain('text-sev-investigating')

    const two = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [pds()] }),
      network: makeNetworkSummary({ health: 'degraded', degraded: ['a', 'b'] })
    })
    expect(title(two.container).textContent?.trim()).toBe('2 services degraded')
  })

  it('says it is re-checking a failure it has not believed yet', async () => {
    const one = await hero({
      snapshot: makeSnapshot({
        finishedAt: FINISHED,
        services: [relay({ state: 'down', rechecking: true }), pds()]
      })
    })
    expect(title(one.container).textContent?.trim()).toBe('Re-checking 1 service')

    const two = await hero({
      snapshot: makeSnapshot({
        finishedAt: FINISHED,
        services: [relay({ state: 'partial', rechecking: true }), pds({ rechecking: true })]
      })
    })
    expect(title(two.container).textContent?.trim()).toBe('Re-checking 2 services')
  })

  // Confirmed down in a panel the menu bar leaves out: red on its row, and before this
  // the hero said "Re-checking" about it for as long as the outage lasted.
  it('names a failure that does not count as one, not as a re-check', async () => {
    const one = await hero({
      snapshot: makeSnapshot({
        finishedAt: FINISHED,
        services: [relay(), makeService({ id: 'spindle:spindle.tangled.sh', state: 'down' })]
      }),
      network: makeNetworkSummary({
        health: 'operational',
        uncounted: ['spindle.tangled.sh']
      })
    })
    expect(title(one.container).textContent?.trim()).toBe(
      'spindle.tangled.sh is failing, not counted'
    )
    expect(title(one.container).className).not.toContain('text-sev')
    expect(one.container.textContent).not.toContain('Re-checking')

    const two = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay()] }),
      network: makeNetworkSummary({ health: 'operational', uncounted: ['a', 'b'] })
    })
    expect(title(two.container).textContent?.trim()).toBe('2 uncounted services failing')
  })

  it('puts a re-check ahead of a failure that does not count', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay({ rechecking: true })] }),
      network: makeNetworkSummary({ health: 'operational', uncounted: ['a'] })
    })
    expect(title(container).textContent?.trim()).toBe('Re-checking 1 service')
  })

  it('says it has not checked yet', async () => {
    const { container } = await hero({ snapshot: makeSnapshot({ services: [relay()] }) })
    expect(title(container).textContent?.trim()).toBe('Not checked yet')
    expect(container.textContent).toContain('Measures every service from this computer.')
    expect(container.textContent).not.toContain('Checked ')
    // Nothing measured means nothing answering, whatever the services last said.
    expect(container.textContent).toMatch(/\b0\s*of 1/)
  })
})

/**
 * The progress line changes with every answer, several times a second through a sweep.
 * Announced as it went, it was all a screen reader said for the length of the sweep.
 */
describe('what a screen reader is told', () => {
  it('says once that a sweep is under way, however far it has got', async () => {
    const { bridge, container } = await hero({
      snapshot: makeSnapshot({
        running: true,
        services: [relay({ state: 'pending', checks: [makeCheck({ ok: null })] })]
      })
    })
    expect(live(container).textContent?.trim()).toBe('Checking the Atmosphere…')

    await pushNetwork(bridge, {
      services: [relay({ state: 'pending', checks: [makeCheck()] })]
    })

    expect(live(container).textContent?.trim()).toBe('Checking the Atmosphere…')
    expect(container.textContent).toContain('1 of 1 requests answered')
  })

  it('says the verdict once it is in', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay()] }),
      network: makeNetworkSummary({ health: 'operational', total: 1, reachable: 1 })
    })
    const said = live(container).textContent!.trim()
    expect(said).toMatch(/^The Atmosphere is reachable\. 1 of 1 answering · median 200/)
  })
})

describe('a sweep in progress', () => {
  it('says it is checking, counts the answers, and shows its progress', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({
        running: true,
        services: [
          relay({ state: 'pending', checks: [makeCheck(), makeCheck({ ok: null })] }),
          pds({ state: 'pending', checks: [makeCheck({ ok: null }), makeCheck({ ok: null })] })
        ]
      })
    })
    expect(title(container).textContent?.trim()).toBe('Checking the Atmosphere…')
    expect(container.textContent).toContain('Checking… 1 of 4 requests answered')
    expect((container.querySelector('.progress') as HTMLElement).style.width).toBe('25%')
    // Nothing about when it last ran while it is running.
    expect(container.textContent).not.toContain('Checked ')
  })

  it('counts each service into the ring as it answers, not at the end', async () => {
    // The rollup still says nothing is answering: it is only recomputed when the sweep
    // starts and finishes, and the ring must not wait for it.
    const { container } = await hero({
      snapshot: makeSnapshot({
        running: true,
        services: [relay(), pds({ state: 'pending' }), control]
      }),
      network: makeNetworkSummary({ health: 'unknown', running: true, total: 2, reachable: 0 })
    })
    expect(container.textContent).toMatch(/\b1\s*of 2/)
  })

  it('says it is starting before the first request goes out', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({ running: true, services: [relay({ state: 'pending', checks: [] })] })
    })
    expect(container.textContent).toContain('Starting…')
    expect(container.querySelector('.progress')).toBeNull()
  })
})

describe('offline', () => {
  it('explains that nothing can be judged, and greys the ring', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({
        offline: true,
        finishedAt: FINISHED,
        services: [relay({ state: 'down' }), control]
      }),
      network: makeNetworkSummary({ health: 'offline' })
    })
    expect(title(container).textContent?.trim()).toBe('You’re offline')
    expect(container.textContent).toContain('None of the control checks got through')
    expect(container.textContent).toContain('as soon as the connection is back')
    expect(container.querySelector('.opacity-45')).not.toBeNull()
    const chip = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Relays')
    )!
    expect(chip.querySelector('span')!.className).toContain('bg-muted-foreground/40')
  })
})

describe('a machine the schedule is staying out of the way of', () => {
  // Without this, a dashboard last measured forty minutes ago under a ten-minute
  // setting reads as the app having quietly stopped working.
  it.each([
    ['battery', 'Checking less often on battery'],
    ['thermal', 'Paused while this machine is under load']
  ] as const)('says so for %s', async (restraint, wording) => {
    const { container } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay()], restraint }),
      network: makeNetworkSummary({ health: 'operational', total: 1, reachable: 1, restraint })
    })

    expect(container.textContent).toContain(`Checked 2 minutes ago · ${wording}`)
  })

  it('says nothing when the schedule is doing exactly what it was told', async () => {
    const { getByText } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay()] })
    })
    // The whole line, so neither a reason nor a dangling separator can be hiding in it.
    expect(getByText('Checked 2 minutes ago')).toBeTruthy()
  })
})

describe('switched off', () => {
  it('offers to turn the checks on', async () => {
    const { container, getByText, bridge } = await hero({
      settings: makeSettings({ networkChecks: false }),
      snapshot: makeSnapshot({ services: [relay({ state: 'pending' })] })
    })
    expect(title(container).textContent?.trim()).toBe('Network checks are off')
    expect(container.textContent).toContain('Turn them on')
    expect(container.textContent).not.toContain('Relays')

    await fireEvent.click(getByText('Turn on'))
    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ networkChecks: true })
  })

  it('says why, under the button, when main will not turn them on', async () => {
    const { getByText, getByRole, bridge } = await hero({
      settings: makeSettings({ networkChecks: false })
    })
    vi.mocked(bridge.api.Preferences.patch).mockRejectedValueOnce(new Error('Not on battery'))

    await fireEvent.click(getByText('Turn on'))
    await settle()

    expect(getByRole('alert').textContent).toContain('Not on battery')
  })
})

describe('actions', () => {
  // Measuring again lives in the header, which means exactly that on this tab.
  it('leaves the sweep to the header', async () => {
    const { getAllByRole } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay()] })
    })
    // The group chips are the only controls: nothing here measures again.
    expect(getAllByRole('button').map((b) => b.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Relays 1/1'
    ])
  })

  it('tallies each Atmosphere group, and jumps to it', async () => {
    const { container, onjump } = await hero({
      snapshot: makeSnapshot({
        finishedAt: FINISHED,
        services: [
          relay(),
          relay({ id: 'relay:europe.firehose.network', state: 'down' }),
          pds({ state: 'pending' }),
          makeService({ id: 'cdn:cdn.bsky.app' }),
          control
        ]
      })
    })
    const chips = [...container.querySelectorAll('button')].filter((b) =>
      /\d\/\d/.test(b.textContent!)
    )
    expect(chips.map((chip) => chip.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Relays 1/2',
      'PDSes 0/1',
      'Infra 1/1'
    ])
    const [relays, pdses, infra] = chips.map((chip) => chip.querySelector('span')!.className)
    expect(relays).toContain('bg-sev-outage')
    expect(pdses).toContain('bg-muted-foreground/40')
    expect(infra).toContain('bg-sev-resolved')

    await fireEvent.click(chips[0]!)
    expect(onjump).toHaveBeenCalledWith('relays')
  })
})
