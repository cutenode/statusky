import { describe, expect, it } from 'vitest'
import { HISTORY_LENGTH } from '@shared/network'
import type { ProbeSample, ProbeState } from '@shared/types'
import { renderWith } from '../test/render'
import UptimeStrip from './UptimeStrip.svelte'

const sample = (
  state: ProbeState,
  latencyMs: number | null,
  at = '2026-01-01T12:00:00Z'
): ProbeSample => ({
  at,
  state,
  latencyMs
})

const bars = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[role="img"] > span')
]

describe('UptimeStrip', () => {
  it('keeps a slot for every observation it can remember, newest on the right', async () => {
    const { container } = await renderWith(UptimeStrip, {
      history: [sample('live', 100), sample('down', null)]
    })
    const slots = bars(container)
    expect(slots).toHaveLength(HISTORY_LENGTH)
    expect(slots.slice(0, -2).every((slot) => slot.className.includes('bg-muted'))).toBe(true)
    expect(slots.at(-2)!.className).toContain('bg-sev-resolved')
    expect(slots.at(-1)!.className).toContain('bg-sev-outage')
  })

  it('draws slower answers taller, and failures full height', async () => {
    const { container } = await renderWith(UptimeStrip, {
      history: [sample('live', 100), sample('live', 400), sample('partial', 50)]
    })
    const [quick, slow, failed] = bars(container).slice(-3)
    expect(quick!.style.height).toBe('48%')
    expect(slow!.style.height).toBe('100%')
    expect(failed!.style.height).toBe('100%')
  })

  it('titles each bar with when, what and how long', async () => {
    const { container } = await renderWith(UptimeStrip, {
      history: [sample('slow', 16_400), sample('pending', null, 'garbage')]
    })
    const [slow, pending] = bars(container).slice(-2)
    expect(slow!.title).toMatch(/ · Slow · 16 s$/)
    expect(pending!.title).toBe('Checking')
  })

  it('shows only the most recent observations when handed more', async () => {
    const history = Array.from({ length: HISTORY_LENGTH + 5 }, () => sample('live', 10))
    const { container } = await renderWith(UptimeStrip, { history })
    expect(bars(container).every((bar) => bar.className.includes('bg-sev-resolved'))).toBe(true)
    expect(container.textContent).toContain(`Last ${HISTORY_LENGTH} checks`)
  })

  it('says how often the service answered', async () => {
    const { container } = await renderWith(UptimeStrip, {
      history: [sample('live', 10), sample('live', 10), sample('live', 10), sample('down', null)]
    })
    expect(container.textContent).toContain('Last 4 checks')
    expect(container.textContent).toContain('75% answered')
  })

  it('counts a single check in the singular', async () => {
    const { container } = await renderWith(UptimeStrip, { history: [sample('live', 10)] })
    expect(container.textContent).toContain('Last 1 check')
    expect(container.textContent).not.toContain('Last 1 checks')
  })

  it('admits to having no history yet', async () => {
    const { container } = await renderWith(UptimeStrip, { history: [] })
    expect(container.textContent).toContain('No history yet')
    expect(container.textContent).not.toContain('answered')
  })
})
