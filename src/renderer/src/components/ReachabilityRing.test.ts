import { describe, expect, it } from 'vitest'
import type { ProbeState } from '@shared/types'
import { renderWith } from '../test/render'
import ReachabilityRing from './ReachabilityRing.svelte'

const segments = (container: HTMLElement): SVGPathElement[] => [
  ...container.querySelectorAll<SVGPathElement>('path.ring-segment')
]

describe('ReachabilityRing', () => {
  it('draws one segment per service, coloured by its state', async () => {
    const states: ProbeState[] = ['live', 'slow', 'partial', 'down', 'pending']
    const { container } = await renderWith(ReachabilityRing, { states, reachable: 2, total: 5 })

    const drawn = segments(container)
    expect(drawn).toHaveLength(5)
    expect(drawn.map((path) => path.getAttribute('class'))).toEqual([
      expect.stringContaining('stroke-sev-resolved'),
      expect.stringContaining('stroke-sev-degraded'),
      expect.stringContaining('stroke-sev-investigating'),
      expect.stringContaining('stroke-sev-outage'),
      expect.stringContaining('stroke-muted-foreground/25')
    ])
  })

  it('shimmers the segments still waiting, one after another', async () => {
    const { container } = await renderWith(ReachabilityRing, {
      states: ['pending', 'pending', 'live', 'pending'],
      reachable: 1,
      total: 4
    })
    const drawn = segments(container)
    expect(drawn.filter((path) => path.classList.contains('pending'))).toHaveLength(3)
    expect(drawn.map((path) => path.style.animationDelay)).toEqual([
      '0ms',
      '300ms',
      '600ms',
      '900ms'
    ])
  })

  it('shows how many answered, out of how many', async () => {
    const { getByText } = await renderWith(ReachabilityRing, {
      states: ['live', 'down', 'live'],
      reachable: 2,
      total: 3
    })
    expect(getByText('2').className).toContain('font-semibold')
    expect(getByText('of 3')).toBeTruthy()
  })

  it('draws a lone service as a near-complete ring rather than nothing', async () => {
    const { container } = await renderWith(ReachabilityRing, {
      states: ['live'],
      reachable: 1,
      total: 1
    })
    const d = segments(container)[0]!.getAttribute('d')!
    // A large arc, since the one segment is nearly the whole circle.
    expect(d).toMatch(/A 28 28 0 1 1/)
  })

  it('greys everything out when the numbers mean nothing', async () => {
    const { container } = await renderWith(ReachabilityRing, {
      states: ['down', 'pending'],
      reachable: 0,
      total: 2,
      dim: true,
      size: 40
    })
    const drawn = segments(container)
    expect(
      drawn.every((path) => path.getAttribute('class')!.includes('stroke-muted-foreground/35'))
    ).toBe(true)
    expect(drawn.some((path) => path.classList.contains('pending'))).toBe(false)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('opacity-45')
    expect(wrapper.style.width).toBe('40px')
  })
})
