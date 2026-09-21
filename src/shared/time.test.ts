import { describe, expect, it } from 'vitest'
import { absoluteTime, compactRelativeTime, dayLabel, relativeTime, sinceTime } from './time'

const NOW = Date.parse('2026-09-09T12:00:00Z')

describe('compactRelativeTime', () => {
  it.each([
    ['2026-09-09T11:59:40Z', 'now'],
    ['2026-09-09T11:57:00Z', '3m'],
    ['2026-09-09T09:00:00Z', '3h'],
    ['2026-09-06T12:00:00Z', '3d'],
    ['2026-08-19T12:00:00Z', '3w'],
    ['2026-06-09T12:00:00Z', '3mo'],
    ['2023-09-09T12:00:00Z', '3y']
  ])('renders %s as %s', (iso, expected) => {
    expect(compactRelativeTime(iso, NOW)).toBe(expected)
  })

  it('clamps future timestamps to "now" rather than showing a negative age', () => {
    expect(compactRelativeTime('2026-09-09T12:05:00Z', NOW)).toBe('now')
  })

  it('returns an empty string for unparseable input', () => {
    expect(compactRelativeTime('not a date', NOW)).toBe('')
  })
})

describe('relativeTime', () => {
  it('describes the past', () => {
    expect(relativeTime('2026-09-09T11:57:00Z', NOW)).toContain('3 minutes')
  })

  it('falls through to years once every smaller unit is exhausted', () => {
    expect(relativeTime('1976-09-09T12:00:00Z', NOW)).toContain('50 years')
  })

  it('returns an empty string for unparseable input', () => {
    expect(relativeTime('nope', NOW)).toBe('')
  })
})

// Compare against locally-constructed dates: the grouping is deliberately in
// the user's timezone, so hard-coded UTC strings would be flaky in CI.
const localNow = new Date(2026, 8, 9, 12, 0, 0).getTime()
const atLocal = (dayOffset: number, hour = 10): string =>
  new Date(2026, 8, 9 - dayOffset, hour).toISOString()

describe('sinceTime', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')

  it('reads like relativeTime for the past', () => {
    expect(sinceTime('2026-01-01T11:58:00Z', now)).toBe(relativeTime('2026-01-01T11:58:00Z', now))
  })

  it('never puts something that already happened in the future', () => {
    // Stamped after the UI's clock last ticked.
    expect(sinceTime('2026-01-01T12:00:03Z', now)).toBe(
      relativeTime(new Date(now).toISOString(), now)
    )
  })

  it('returns an empty string for unparseable input', () => {
    expect(sinceTime('whenever', now)).toBe('')
  })
})

describe('dayLabel', () => {
  it('labels the current day', () => {
    expect(dayLabel(atLocal(0), localNow)).toBe('Today')
  })

  it('labels the previous day', () => {
    expect(dayLabel(atLocal(1), localNow)).toBe('Yesterday')
  })

  it('uses a weekday name within the last week', () => {
    expect(dayLabel(atLocal(3), localNow)).toMatch(/day$/)
  })

  it('uses a calendar date beyond a week', () => {
    expect(dayLabel(atLocal(30), localNow)).toMatch(/\d/)
  })

  it('handles unparseable input', () => {
    expect(dayLabel('nope', localNow)).toBe('Unknown')
  })
})

describe('absoluteTime', () => {
  it('formats a real timestamp', () => {
    expect(absoluteTime('2026-09-09T12:00:00Z')).not.toBe('')
  })

  it('returns an empty string for unparseable input', () => {
    expect(absoluteTime('nope')).toBe('')
  })
})
