// @vitest-environment jsdom
/**
 * The popover's Content-Security-Policy has no `'unsafe-eval'`, and Zod finds out whether
 * it may compile with `new Function` by trying — which Chromium reports as a violation
 * and a console error on every launch. Anywhere with a `document` is told up front not
 * to try. This file runs with one, as the renderer does.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROBE_TARGETS } from './probe-targets'
import { probeTargetsSchema } from './schemas'
import { z } from './zod'

describe('Zod in a page', () => {
  it('is told not to compile its fast path', () => {
    expect(z.config().jitless).toBe(true)
  })

  it('still tells a valid value from an invalid one without it', () => {
    expect(probeTargetsSchema.safeParse(DEFAULT_PROBE_TARGETS).success).toBe(true)
    expect(probeTargetsSchema.safeParse({ ...DEFAULT_PROBE_TARGETS, accounts: [] }).success).toBe(
      false
    )
  })
})
