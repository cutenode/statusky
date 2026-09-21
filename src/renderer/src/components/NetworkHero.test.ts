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
import { renderWith } from '../test/render'
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

describe('the verdict', () => {
  it('says the Atmosphere is reachable, how many answered and how quickly', async () => {
    const { container } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay(), pds(), control] }),
      network: makeNetworkSummary({ health: 'operational', total: 2, reachable: 2 })
    })
    expect(title(container).textContent?.trim()).toBe('The Atmosphere is reachable')
    expect(container.textContent).toContain('2 of 2 answering · median 400 ms')
    expect(container.textContent).toContain('Checked 2 minutes ago ·')
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
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay({ state: 'down' }), pds()] })
    })
    expect(title(one.container).textContent?.trim()).toBe('Re-checking 1 service')

    const two = await hero({
      snapshot: makeSnapshot({
        finishedAt: FINISHED,
        services: [relay({ state: 'partial' }), pds({ rechecking: true })]
      })
    })
    expect(title(two.container).textContent?.trim()).toBe('Re-checking 2 services')
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
    expect(container.textContent).not.toContain('Check now')
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
    expect(container.textContent).not.toContain('Check now')
    expect(container.querySelector('.opacity-45')).not.toBeNull()
    const chip = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Relays')
    )!
    expect(chip.querySelector('span')!.className).toContain('bg-muted-foreground/40')
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
})

describe('actions', () => {
  it('checks again on request', async () => {
    const { getByText, bridge } = await hero({
      snapshot: makeSnapshot({ finishedAt: FINISHED, services: [relay()] })
    })
    await fireEvent.click(getByText('Check now'))
    expect(bridge.api.Network.run).toHaveBeenCalledTimes(1)
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
