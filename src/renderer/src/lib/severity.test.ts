import { describe, expect, it } from 'vitest'
import type { ProbeState, Severity } from '@shared/types'
import type { Health } from '@shared/status'
import { HEALTH_LABEL, SEVERITY_LABEL } from '@shared/status'
import { HEALTH_STYLE, PROBE_STATE_STYLE, SEVERITY_STYLE } from './severity'
// The file as text, through Vite; the linter cannot see the export Vite makes for it.
// oxlint-disable-next-line import/default
import source from './severity.ts?raw'

const SEVERITIES = Object.keys(SEVERITY_LABEL) as Severity[]
const HEALTHS = Object.keys(HEALTH_LABEL) as Health[]

describe('SEVERITY_STYLE', () => {
  it('styles every severity the classifier can produce', () => {
    expect(Object.keys(SEVERITY_STYLE).toSorted()).toEqual([...SEVERITIES].toSorted())
  })

  it('gives each severity a text, background, rail, ring and icon', () => {
    for (const severity of SEVERITIES) {
      const style = SEVERITY_STYLE[severity]
      expect(style.text).toMatch(/^text-sev-/)
      expect(style.bg).toMatch(/^bg-sev-/)
      expect(style.rail).toMatch(/^bg-sev-/)
      expect(style.ring).toMatch(/^ring-sev-/)
      expect(style.icon).toBeTypeOf('function')
    }
  })

  /**
   * Tailwind reads the source, not the running code: a class built with a template
   * literal is complete at runtime and never generated. So the check is on the file —
   * every class string these tables hand out has to appear in it, quoted, as written.
   */
  it('writes class names out in full, so Tailwind can see them', () => {
    const tables = [SEVERITY_STYLE, HEALTH_STYLE, PROBE_STATE_STYLE]
    const classes = tables
      .flatMap((table) => Object.values(table))
      .flatMap((style) => Object.values(style))
      .filter((value): value is string => typeof value === 'string' && value !== '')
      // `label` is a word for people, not a class.
      .filter((value) => !Object.values(PROBE_STATE_STYLE).some((s) => s.label === value))

    expect(classes.length).toBeGreaterThan(50)
    for (const value of classes) expect(source).toContain(`'${value}'`)
  })

  it('uses a distinct colour token per severity', () => {
    const rails = SEVERITIES.map((s) => SEVERITY_STYLE[s].rail)
    expect(new Set(rails).size).toBe(rails.length)
  })

  it('gives each severity its own icon', () => {
    const icons = SEVERITIES.map((s) => SEVERITY_STYLE[s].icon)
    expect(new Set(icons).size).toBe(icons.length)
  })
})

describe('HEALTH_STYLE', () => {
  it('styles every health state', () => {
    expect(Object.keys(HEALTH_STYLE).toSorted()).toEqual([...HEALTHS].toSorted())
  })

  it('gives every state a dot and a text colour', () => {
    for (const health of HEALTHS) {
      expect(HEALTH_STYLE[health].dot.length).toBeGreaterThan(0)
      expect(HEALTH_STYLE[health].text.length).toBeGreaterThan(0)
    }
  })

  it('glows for real states but stays flat for unknown', () => {
    expect(HEALTH_STYLE.unknown.glow).toBe('')
    for (const health of HEALTHS.filter((h) => h !== 'unknown')) {
      expect(HEALTH_STYLE[health].glow).toContain('shadow-')
    }
  })

  it('reuses the incident colour for the outage severity, so they read as one thing', () => {
    expect(HEALTH_STYLE.incident.dot).toBe(SEVERITY_STYLE.outage.rail)
    expect(HEALTH_STYLE.operational.dot).toBe(SEVERITY_STYLE.resolved.rail)
  })
})

describe('PROBE_STATE_STYLE', () => {
  const STATES: ProbeState[] = ['pending', 'live', 'slow', 'partial', 'down']

  it('styles every state a service can be observed in', () => {
    expect(Object.keys(PROBE_STATE_STYLE).toSorted()).toEqual([...STATES].toSorted())
  })

  it('gives every state a label, a light, a colour and a bar', () => {
    for (const state of STATES) {
      const style = PROBE_STATE_STYLE[state]
      expect(style.label.length).toBeGreaterThan(0)
      expect(style.dot).toMatch(/^bg-/)
      expect(style.text).toMatch(/^text-/)
      expect(style.bar).toMatch(/^bg-/)
    }
  })

  it('lights up every state but pending', () => {
    expect(PROBE_STATE_STYLE.pending.glow).toBe('')
    for (const state of STATES.filter((s) => s !== 'pending')) {
      expect(PROBE_STATE_STYLE[state].glow).toContain('shadow-')
    }
  })

  it('shares its colours with the severities, so an outage reads the same everywhere', () => {
    expect(PROBE_STATE_STYLE.live.dot).toBe(SEVERITY_STYLE.resolved.rail)
    expect(PROBE_STATE_STYLE.down.dot).toBe(SEVERITY_STYLE.outage.rail)
  })
})
