import { SERVICES, isCore, isProbeSource, probeServiceId } from './network'
import type {
  Account,
  AwayBehaviour,
  NotificationSound,
  NotifyLevel,
  ProbeNotifyScope,
  Settings,
  Severity,
  StatusPost
} from './types'

/**
 * Which updates are worth a banner, and when.
 *
 * Everything here is pure and shared: the main process decides with it, and the Settings
 * panel uses the same presets and wording to describe what the decision will be. The
 * timing half — holding banners through quiet hours, a snooze or an absence — lives in
 * `createNotifier` in src/main/notifications.ts, which asks this module what time it is
 * in the user's day but keeps its own clock.
 */

/** The stages that mean something is broken right now: sound, stickiness, quiet hours. */
export const URGENT_SEVERITIES: readonly Severity[] = ['outage', 'degraded']

/** The stages a source set to `outages` is heard about, and the `outages` preset. */
export const OUTAGE_SEVERITIES: readonly Severity[] = ['outage', 'degraded', 'investigating']

/** Stages that answer an earlier update rather than starting a story of their own. */
export const FOLLOW_UP_SEVERITIES: readonly Severity[] = ['monitoring', 'resolved']

/** Stages that open an incident, so that its follow-ups are worth hearing. */
const OPENING_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  'outage',
  'degraded',
  'investigating',
  'identified'
])

/** Every stage, in the order the Settings panel lists them: worst first, routine last. */
export const SEVERITY_ORDER: readonly Severity[] = [
  'outage',
  'degraded',
  'investigating',
  'identified',
  'monitoring',
  'resolved',
  'maintenance',
  'update'
]

export type NotifyPreset = 'all' | 'incidents' | 'outages'

export const NOTIFY_PRESETS: {
  value: NotifyPreset
  label: string
  hint: string
  severities: readonly Severity[]
}[] = [
  {
    value: 'all',
    label: 'Everything',
    hint: 'Every update, routine ones included.',
    severities: SEVERITY_ORDER
  },
  {
    value: 'incidents',
    label: 'Incidents',
    hint: 'Everything but routine updates and maintenance.',
    severities: ['outage', 'degraded', 'investigating', 'identified', 'monitoring', 'resolved']
  },
  {
    value: 'outages',
    label: 'Outages',
    hint: 'Only when something is broken right now.',
    severities: OUTAGE_SEVERITIES
  }
]

/** How much of one source is worth a banner, as the Sources panel offers it. */
export const NOTIFY_LEVEL_CHOICES: {
  value: NotifyLevel
  label: string
  /** For the control itself, which sits in a crowded row. */
  short: string
  hint: string
}[] = [
  {
    value: 'default',
    label: 'Use defaults',
    short: 'Default',
    hint: 'The stages chosen in Settings.'
  },
  { value: 'all', label: 'Every update', short: 'All', hint: 'Every update from this source.' },
  {
    value: 'outages',
    label: 'Outages only',
    short: 'Outages',
    hint: 'Only when something is broken.'
  },
  {
    value: 'off',
    label: 'No banners',
    short: 'Off',
    hint: 'Still in the feed, but never a banner.'
  }
]

export const SOUND_CHOICES: { value: NotificationSound; label: string; hint: string }[] = [
  { value: 'all', label: 'Always', hint: 'The system sound with every banner.' },
  { value: 'urgent', label: 'Outages only', hint: 'Heard for outages, seen for the rest.' },
  { value: 'never', label: 'Never', hint: 'Every banner arrives silently.' }
]

export const AWAY_CHOICES: { value: AwayBehaviour; label: string; hint: string }[] = [
  { value: 'digest', label: 'Summarize', hint: 'Held, then one banner saying what you missed.' },
  { value: 'deliver', label: 'Deliver anyway', hint: 'Banners go up as they come, for later.' },
  { value: 'drop', label: 'Stay silent', hint: 'Nothing is announced; it waits in the feed.' }
]

export const PROBE_SCOPE_CHOICES: { value: ProbeNotifyScope; label: string; hint: string }[] = [
  { value: 'core', label: 'Core only', hint: 'Relays, AppViews and PDSes the network runs on.' },
  { value: 'all', label: 'Core + community', hint: 'Hobby and sandbox services too.' },
  { value: 'pinned', label: 'Pinned only', hint: 'Only the services you pin below.' }
]

/** How long a measured outage must last before it is announced, in seconds. */
export const GRACE_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: 'No wait' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' }
]

/** The preset these stages amount to, or null when they are a hand-picked set. */
export function presetOf(severities: readonly Severity[]): NotifyPreset | null {
  const chosen = new Set(severities)
  const match = NOTIFY_PRESETS.find(
    (preset) =>
      preset.severities.length === chosen.size && preset.severities.every((s) => chosen.has(s))
  )
  return match?.value ?? null
}

// ------------------------------------------------------------------ what

function probeTier(serviceId: string | null): 'core' | 'community' {
  const service = serviceId ? SERVICES.find((s) => s.id === serviceId) : undefined
  return service && !isCore(service) ? 'community' : 'core'
}

/** Whether follow-ups for this source wait for the incident they follow. */
function gatesFollowUps(account: Account, settings: Settings): boolean {
  return settings.notifyFollowUpsOnly && account.notify !== 'all'
}

/**
 * Whether one update is the kind this user wants a banner for, on its own merits.
 *
 * Deliberately stateless: a follow-up that waits for its incident passes here, and
 * `applyFollowUps` then decides whether that incident was ever announced.
 */
export function wantsBanner(post: StatusPost, account: Account, settings: Settings): boolean {
  if (account.notify === 'off' || account.muted) return false
  if (!settings.notifySources.includes(account.kind)) return false

  if (isProbeSource(post.authorDid)) {
    const serviceId = probeServiceId(post)
    switch (settings.notifyProbeScope) {
      case 'core':
        if (probeTier(serviceId) !== 'core') return false
        break
      case 'pinned':
        if (!serviceId || !settings.pinnedServices.includes(serviceId)) return false
        break
    }
    if (post.severity === 'degraded' && !settings.notifyProbePartial) return false
    if (post.severity === 'resolved' && !settings.notifyProbeRecovery) return false
  }

  if (account.notify === 'all') return true
  if (FOLLOW_UP_SEVERITIES.includes(post.severity) && gatesFollowUps(account, settings)) return true
  const stages = account.notify === 'outages' ? OUTAGE_SEVERITIES : settings.notifySeverities
  return stages.includes(post.severity)
}

/**
 * The incident an update belongs to, as far as can be told.
 *
 * A measured service is its own incident. A pushed status page names its incidents, and
 * every update carries that name in its key. A status account's posts are fetched without
 * their replies, so there is no thread to follow, and the account itself stands in: an
 * outage it announced stays open until it posts that something is resolved.
 */
export function incidentKey(post: StatusPost): string {
  const serviceId = probeServiceId(post)
  if (serviceId) return `${post.authorDid}/${serviceId}`

  // `webhook:<page>/incident/<id>/<update>`: the incident is everything before the update.
  const [source, kind, id] = post.uri.split('/')
  if (source?.startsWith('webhook:') && (kind === 'incident' || kind === 'maintenance') && id) {
    return `${source}/${kind}/${id}`
  }
  return post.authorDid
}

/** How many open incidents to remember. Far more than are ever open at once. */
const MAX_OPEN_INCIDENTS = 200

/**
 * Drop follow-ups to incidents nobody was told about, and keep track of which are open.
 *
 * `posts` are the updates `wantsBanner` let through, oldest first, so an incident that
 * opens and resolves inside one refresh is announced and then closed in order. Returns
 * what is left worth a banner and the open incidents afterwards.
 */
export function applyFollowUps(
  posts: StatusPost[],
  accounts: Account[],
  settings: Settings,
  open: readonly string[]
): { posts: StatusPost[]; open: string[] } {
  const byDid = new Map(accounts.map((account) => [account.did, account]))
  const still = new Set(open)
  const kept: StatusPost[] = []

  for (const post of posts) {
    const account = byDid.get(post.authorDid)
    const key = incidentKey(post)
    const followUp = FOLLOW_UP_SEVERITIES.includes(post.severity)

    if (followUp && account && gatesFollowUps(account, settings) && !still.has(key)) continue
    kept.push(post)

    if (OPENING_SEVERITIES.has(post.severity)) still.add(key)
    else if (post.severity === 'resolved') still.delete(key)
  }

  return { posts: kept, open: [...still].slice(-MAX_OPEN_INCIDENTS) }
}

// ------------------------------------------------------------------ when

/** Minutes since midnight for `HH:MM`, or null for anything that is not one. */
function minutesOf(clock: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Whether `now` falls in the user's quiet hours, in local time.
 *
 * A start later than the end is a window across midnight, which is the usual case. A
 * start equal to the end is an empty window rather than the whole day: someone who
 * wants no banners at all has a switch for that.
 */
export function inQuietHours(settings: Settings, now: Date): boolean {
  if (!settings.quietHoursEnabled) return false
  const start = minutesOf(settings.quietHoursStart)
  const end = minutesOf(settings.quietHoursEnd)
  if (start === null || end === null || start === end) return false
  const minute = now.getHours() * 60 + now.getMinutes()
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/** The next moment quiet hours end after `now`, or null if they are off or malformed. */
export function quietHoursEnd(settings: Settings, now: Date): Date | null {
  if (!settings.quietHoursEnabled) return null
  const end = minutesOf(settings.quietHoursEnd)
  if (end === null) return null
  const next = new Date(now)
  next.setHours(Math.floor(end / 60), end % 60, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}

/** When the snooze ends, or null when banners are not snoozed at `now`. */
export function snoozedUntil(
  settings: Pick<Settings, 'notificationsSnoozedUntil'>,
  now: Date
): Date | null {
  const until = settings.notificationsSnoozedUntil
  if (!until) return null
  const at = new Date(until)
  return Number.isNaN(at.getTime()) || at.getTime() <= now.getTime() ? null : at
}

export type SnoozeChoice = 'hour' | 'tomorrow'

export const SNOOZE_CHOICES: { value: SnoozeChoice; label: string }[] = [
  { value: 'hour', label: 'For 1 hour' },
  { value: 'tomorrow', label: 'Until tomorrow' }
]

/**
 * When a snooze started at `now` should end.
 *
 * *Until tomorrow* ends when the user's quiet hours do if they have set some, since
 * that is already their answer to when the day starts, and at eight otherwise. It is
 * the next such morning, not the morning of the next date: chosen at half past
 * midnight, that is the one a few hours away rather than a day and a half.
 */
export function snoozeEnd(choice: SnoozeChoice, settings: Settings, now: Date): Date {
  if (choice === 'hour') return new Date(now.getTime() + 60 * 60_000)
  const morning = (settings.quietHoursEnabled ? minutesOf(settings.quietHoursEnd) : null) ?? 8 * 60
  const next = new Date(now)
  next.setHours(Math.floor(morning / 60), morning % 60, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}

/** "14:05", or "Tue 08:00" for a moment that is not today. */
export function formatClock(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (at.toDateString() === now.toDateString()) return time
  return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

/** Whether a banner for this update should make a sound. */
export function bannerSound(settings: Settings, severities: readonly Severity[]): boolean {
  switch (settings.notificationSound) {
    case 'all':
      return true
    case 'urgent':
      return severities.some((severity) => URGENT_SEVERITIES.includes(severity))
    default:
      return false
  }
}
