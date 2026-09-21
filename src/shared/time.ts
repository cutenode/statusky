const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' }
]

/** Nothing is larger, so anything outstripping the divisions above lands here. */
const LARGEST_UNIT: Intl.RelativeTimeFormatUnit = 'year'

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'long' })

/** "3 minutes ago" / "in 2 hours". Returns an empty string for unparseable input. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''

  let duration = (then - now) / 1000
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit)
    }
    duration /= division.amount
  }
  return rtf.format(Math.round(duration), LARGEST_UNIT)
}

/**
 * `relativeTime` for something that has already happened. The UI's clock only ticks
 * every thirty seconds, so a moment stamped since the last tick would otherwise read as
 * "in 3 seconds".
 */
export function sinceTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  return relativeTime(iso, Number.isNaN(then) ? now : Math.max(now, then))
}

/** Compact form for dense list rows: "3m", "2h", "5d", "12w". */
export function compactRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''

  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return 'now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d`
  if (seconds < 2629800) return `${Math.round(seconds / 604800)}w`
  if (seconds < 31557600) return `${Math.round(seconds / 2629800)}mo`
  return `${Math.round(seconds / 31557600)}y`
}

const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

export function absoluteTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  return absoluteFormatter.format(then)
}

/** Local midnight for the given instant, so day grouping matches the user's calendar. */
function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Group key used to break the feed into "Today" / "Yesterday" / date sections. */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'Unknown'

  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(then)
  return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(then)
}
