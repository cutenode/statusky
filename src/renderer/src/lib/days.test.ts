import { describe, expect, it } from 'vitest'
import { groupByDay } from './days'

// Local dates throughout: the grouping is by the user's calendar, not by UTC.
const NOW = new Date(2026, 8, 9, 12).getTime()
const at = (year: number, month: number, day: number, hour = 10): { createdAt: string } => ({
  createdAt: new Date(year, month - 1, day, hour).toISOString()
})

describe('groupByDay', () => {
  it('keeps one day’s entries together, in the order given', () => {
    const morning = at(2026, 9, 9, 9)
    const earlier = at(2026, 9, 9, 7)
    const yesterday = at(2026, 9, 8)

    const groups = groupByDay([morning, earlier, yesterday], NOW)

    expect(groups.map((group) => [group.key, group.label])).toEqual([
      ['2026-09-09', 'Today'],
      ['2026-09-08', 'Yesterday']
    ])
    expect(groups[0]!.items).toEqual([morning, earlier])
  })

  // The regression: a keyed `{#each}` throws on a repeated key, and "September 10" was
  // the key for both of these.
  it('gives the same date in two years two groups, and two headings', () => {
    const groups = groupByDay(
      [at(2025, 9, 10), at(2025, 3, 1), at(2024, 9, 10), at(2024, 1, 2)],
      NOW
    )

    const keys = groups.map((group) => group.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(groups[0]!.label).not.toBe(groups[2]!.label)
  })

  it('gathers a day that comes round twice into the group it opened', () => {
    const undated = { createdAt: 'not a date' }
    const alsoUndated = { createdAt: '' }
    const dated = at(2026, 9, 9)

    const groups = groupByDay([undated, dated, alsoUndated], NOW)

    expect(groups.map((group) => group.key)).toEqual(['unknown', '2026-09-09'])
    expect(groups[0]!.items).toEqual([undated, alsoUndated])
    expect(groups[0]!.label).toBe('Unknown')
  })

  it('has nothing to group in an empty list', () => {
    expect(groupByDay([], NOW)).toEqual([])
  })
})
