import { describe, expect, it } from 'vitest'
import type { ProbeState } from '@shared/types'
import { PROBE_STATE_STYLE } from '$lib/severity'
import { renderWith } from '../test/render'
import ProbeLed from './ProbeLed.svelte'

const light = (container: HTMLElement): Element =>
  container.querySelector('span > span:last-child')!

describe('ProbeLed', () => {
  it.each<ProbeState>(['pending', 'live', 'slow', 'partial', 'down'])(
    'lights in the %s colour',
    async (state) => {
      const { container } = await renderWith(ProbeLed, { state })
      expect(light(container).className).toContain(PROBE_STATE_STYLE[state].dot)
    }
  )

  it('breathes while a check is in flight', async () => {
    const { container } = await renderWith(ProbeLed, { state: 'pending' })
    expect(light(container).className).toContain('animate-pulse')
    expect(container.querySelector('[class*="animate-ping"]')).toBeNull()
  })

  it('pings while a service is down', async () => {
    const { container } = await renderWith(ProbeLed, { state: 'down' })
    expect(container.querySelector('[class*="animate-ping"]')?.className).toContain('bg-sev-outage')
  })

  it('pings amber while a failure is being re-checked', async () => {
    const { container } = await renderWith(ProbeLed, { state: 'live', rechecking: true })
    expect(container.querySelector('[class*="animate-ping"]')?.className).toContain(
      'bg-sev-investigating'
    )
  })

  it('holds still when told to, whatever the state', async () => {
    const { container } = await renderWith(ProbeLed, { state: 'pending', still: true })
    expect(light(container).className).not.toContain('animate-pulse')

    const down = await renderWith(ProbeLed, { state: 'down', still: true, rechecking: true })
    expect(down.container.querySelector('[class*="animate-ping"]')).toBeNull()
  })

  it('stays calm while live', async () => {
    const { container } = await renderWith(ProbeLed, { state: 'live', class: 'ml-2' })
    expect(container.querySelector('[class*="animate-ping"]')).toBeNull()
    expect(container.firstElementChild?.className).toContain('ml-2')
  })
})
