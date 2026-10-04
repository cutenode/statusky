import { describe, expect, it } from 'vitest'
import type { Health } from '@shared/status'
import { HEALTH_STYLE } from '$lib/severity'
import { renderWith } from '../test/render'
import HealthDot from './HealthDot.svelte'

const HEALTHS: Health[] = [
  'operational',
  'monitoring',
  'degraded',
  'incident',
  'maintenance',
  'offline',
  'unknown'
]

describe('HealthDot', () => {
  it.each(HEALTHS)('paints the %s colour', async (health) => {
    const { container } = await renderWith(HealthDot, { health })
    const dot = container.querySelector('span > span:last-child')
    expect(dot?.className).toContain(HEALTH_STYLE[health].dot)
  })

  it.each(['incident', 'monitoring'] as const)('pulses while %s', async (health) => {
    const { container } = await renderWith(HealthDot, { health, pulse: true })
    expect(container.querySelector('[class*="animate-ping"]')).not.toBeNull()
  })

  it.each(['operational', 'maintenance', 'unknown'] as const)(
    'stays still while %s, because nothing is changing',
    async (health) => {
      const { container } = await renderWith(HealthDot, { health, pulse: true })
      expect(container.querySelector('[class*="animate-ping"]')).toBeNull()
    }
  )

  it('never pulses unless asked to', async () => {
    const { container } = await renderWith(HealthDot, { health: 'incident' })
    expect(container.querySelector('[class*="animate-ping"]')).toBeNull()
  })

  it('merges an extra class onto the wrapper', async () => {
    const { container } = await renderWith(HealthDot, { health: 'operational', class: 'ml-4' })
    expect(container.firstElementChild?.className).toContain('ml-4')
  })
})
