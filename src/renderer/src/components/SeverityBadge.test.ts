import { describe, expect, it } from 'vitest'
import type { Severity } from '@shared/types'
import { SEVERITY_LABEL } from '@shared/status'
import { SEVERITY_STYLE } from '$lib/severity'
import { renderWith } from '../test/render'
import SeverityBadge from './SeverityBadge.svelte'

const SEVERITIES = Object.keys(SEVERITY_LABEL) as Severity[]

describe('SeverityBadge', () => {
  it.each(SEVERITIES)('labels and colours %s', async (severity) => {
    const { container, getByText } = await renderWith(SeverityBadge, { severity })

    expect(getByText(SEVERITY_LABEL[severity])).toBeTruthy()
    expect(container.firstElementChild?.className).toContain(SEVERITY_STYLE[severity].text)
    expect(container.firstElementChild?.className).toContain(SEVERITY_STYLE[severity].bg)
  })

  it('renders the severity’s own icon alongside the label', async () => {
    const { container } = await renderWith(SeverityBadge, { severity: 'outage' })
    expect(container.querySelector('svg.lucide-cloud-off')).not.toBeNull()
  })

  it('accepts an extra class', async () => {
    const { container } = await renderWith(SeverityBadge, { severity: 'update', class: 'w-full' })
    expect(container.firstElementChild?.className).toContain('w-full')
  })
})
