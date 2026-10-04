/**
 * Breaking a chronology into days, the way the Feed and the Timeline both draw it.
 */
import { dayKey, dayLabel } from '@shared/time'

export interface DayGroup<T> {
  /** The local calendar day, `2026-09-09`, which no two groups share. */
  key: string
  /** What the heading says: "Today", a weekday, a date. */
  label: string
  items: T[]
}

/**
 * Group a list by the local day each entry was posted, in the order the list is in.
 *
 * Keyed by the day rather than by what its heading says, and gathered by key rather
 * than by neighbour: a keyed `{#each}` throws on a repeated key, and a list that is not
 * strictly in date order — an undated post the sort could not place — would otherwise
 * open the same day twice and take the whole panel down with it.
 */
export function groupByDay<T extends { createdAt: string }>(
  items: readonly T[],
  now: number
): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>()
  for (const item of items) {
    const key = dayKey(item.createdAt, now)
    const group = groups.get(key)
    if (group) group.items.push(item)
    else groups.set(key, { key, label: dayLabel(item.createdAt, now), items: [item] })
  }
  return [...groups.values()]
}
