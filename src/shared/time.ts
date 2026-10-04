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
    // Rounded before the unit is chosen, so 59.6 minutes is "1 hour ago", not "60 minutes".
    const rounded = Math.round(duration)
    if (Math.abs(rounded) < division.amount) return rtf.format(rounded, division.unit)
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
  // Round, then pick the unit, so 59½ minutes reads "1h" rather than "60m".
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(seconds / 3600)
  if (hours < 24) return `${hours}h`
  const days = Math.round(seconds / 86400)
  if (days < 7) return `${days}d`
  // A month is 4.35 weeks, so rounding weeks can never reach a "5w" to carry.
  if (seconds < 2629800) return `${Math.round(seconds / 604800)}w`
  const months = Math.round(seconds / 2629800)
  if (months < 12) return `${months}mo`
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

const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' })
const datedYearFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
})

/**
 * The heading over a day's posts: "Today", "Yesterday", a weekday, or a date.
 *
 * A date outside the current year carries its year. A status account can post rarely
 * enough that thirty of its posts span more than a year, and "September 10" said twice
 * in one feed, a year apart, reads as one day split in two.
 */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'Unknown'

  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return weekdayFormatter.format(then)
  const sameYear = new Date(then).getFullYear() === new Date(now).getFullYear()
  return (sameYear ? dateFormatter : datedYearFormatter).format(then)
}

/**
 * Which local calendar day a post falls on, `2026-09-09`, for telling day groups apart.
 *
 * What `dayLabel` says is for reading and this is for keying: one key per day the
 * label could stand for, so two groups never share one. Anything dated ahead of the
 * local clock is today's, as `dayLabel` files it, and anything unparseable shares the
 * one `unknown`.
 */
export function dayKey(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'unknown'

  const day = new Date(Math.min(then, now))
  const month = String(day.getMonth() + 1).padStart(2, '0')
  const date = String(day.getDate()).padStart(2, '0')
  return `${day.getFullYear()}-${month}-${date}`
}
