import type { Severity, StatusPost } from './types'

/**
 * Status posts follow a loose incident lifecycle borrowed from Statuspage:
 * investigating -> identified -> monitoring -> resolved, with maintenance as a
 * parallel track. Accounts announce the stage in prose rather than in a field,
 * so we recover it from the text.
 */

/** Explicit `Label:` prefixes win outright — they are the author stating the stage. */
const PREFIX_RULES: [RegExp, Severity][] = [
  [/^resolved\b/i, 'resolved'],
  [/^completed\b/i, 'resolved'],
  [/^fixed\b/i, 'resolved'],
  [/^monitoring\b/i, 'monitoring'],
  [/^identified\b/i, 'identified'],
  [/^investigating\b/i, 'investigating'],
  [/^(scheduled )?maintenance\b/i, 'maintenance'],
  [/^scheduled\b/i, 'maintenance'],
  [/^degraded\b/i, 'degraded'],
  [/^outage\b/i, 'outage']
]

/**
 * Body rules, most-advanced lifecycle stage first. The first bucket with a match
 * wins, so "the fix has been implemented ... we are continuing to monitor" lands on
 * `monitoring` rather than `identified`.
 */
const BODY_RULES: [Severity, RegExp[]][] = [
  [
    'resolved',
    [
      /\b(has|have|is|are|been)\s+(been\s+)?resolved\b/i,
      /\bincident\s+(is\s+)?(now\s+)?(closed|over|resolved)\b/i,
      /\bwe\s+have\s+fixed\b/i,
      /\b(work|maintenance)\s+(is\s+)?(now\s+)?complete(d)?\b/i,
      /\ball\s+(systems|services)\s+(are\s+)?(back\s+)?(to\s+)?(normal|operational)\b/i,
      /\bfully\s+restored\b/i,
      /\bno\s+longer\s+(affected|impacted)\b/i
    ]
  ],
  [
    'monitoring',
    [/\bmonitor(ing|ed)?\b/i, /\brecover(ing|ed)\b/i, /\bobserving\b/i, /\bwatching\s+for\b/i]
  ],
  [
    'identified',
    [
      /\bidentified\s+(the\s+)?(cause|root\s+cause|issue|source)\b/i,
      /\broot\s+cause\b/i,
      /\bfix\s+(has\s+been|is\s+being|was)\s+(implemented|deployed|applied|rolled\s+out)\b/i,
      /\b(have|has)\s+(applied|deployed|implemented)\s+a\s+fix\b/i,
      /\bwe\s+have\s+reverted\b/i,
      /\bworking\s+(towards|toward)\s+a\s+resolution\b/i
    ]
  ],
  [
    'investigating',
    [
      /\binvestigat(e|ing|ion)\b/i,
      /\blooking\s+into\b/i,
      /\btriaging\b/i,
      /\bwe\s+are\s+aware\s+of\b/i,
      /\bworking\s+to\s+(restore|fix|mitigate)\b/i
    ]
  ],
  [
    'maintenance',
    [
      /\bmaintenance\b/i,
      /\bwill\s+be\s+working\s+on\b/i,
      /\bserver\s+work\b/i,
      /\bplanned\s+(work|downtime|window)\b/i,
      /\bupgrad(e|ing)\b/i,
      /\bmigrat(e|ing|ion)\b/i
    ]
  ],
  [
    'outage',
    [
      /\boutage\b/i,
      /\b(is|are|were|was)\s+(currently\s+)?down\b/i,
      /\bunavailable\b/i,
      /\bun?accessible\b/i,
      /\binaccessible\b/i,
      /\b(fail(s|ing|ed)?)\s+to\s+load\b/i,
      /\btimed?\s+out\b/i,
      /\bhard\s+down\b/i
    ]
  ],
  [
    'degraded',
    [
      /\bdegrad(ed|ation)\b/i,
      /\bslow(er|ness)?\b/i,
      /\bdelay(s|ed)?\b/i,
      /\bpartial\b/i,
      /\binterruption\b/i,
      /\bintermittent\b/i,
      /\belevated\s+(errors?|latency)\b/i,
      /\b(issue|issues|problem|problems|incident)\b/i,
      /\bimpact(ing|ed)\b/i,
      /\bfailing\b/i
    ]
  ]
]

/** Classify a post's text into an incident-lifecycle stage. */
export function classifySeverity(text: string): Severity {
  const trimmed = text.trim()
  if (!trimmed) return 'update'

  // An explicit prefix is the author naming the stage; trust it over the body.
  // `Update:` deliberately has no rule — it means "the stage is in the body".
  for (const [pattern, severity] of PREFIX_RULES) {
    if (pattern.test(trimmed)) return severity
  }

  for (const [severity, patterns] of BODY_RULES) {
    if (patterns.some((p) => p.test(trimmed))) return severity
  }

  return 'update'
}

/** Severities that represent something actively wrong right now. */
const ACTIVE: ReadonlySet<Severity> = new Set<Severity>([
  'investigating',
  'identified',
  'outage',
  'degraded'
])

export function isActiveIncident(severity: Severity): boolean {
  return ACTIVE.has(severity)
}

/**
 * `degraded` and `offline` never come from posts: they are what the network checks add.
 * `degraded` is a service partly failing its checks, and `offline` means this machine
 * could not reach anything at all — including the control checks — so no other health
 * can be judged.
 */
export type Health =
  'operational' | 'monitoring' | 'degraded' | 'incident' | 'maintenance' | 'offline' | 'unknown'

/**
 * What a source is saying, and whether it has said it recently enough to still be a
 * report of the present rather than a piece of history.
 */
export interface Claim {
  health: Health
  /** When the post behind it was written, or null when the source has posted nothing. */
  at: string | null
  /** The claim has outlived the window its author would have updated it in. */
  stale: boolean
}

/**
 * How long a claim stays the present tense, in hours, by what it claims.
 *
 * Status accounts announce a problem and then, very often, announce nothing more. A
 * maintenance window's end is in the sentence that opened it; an incident's resolution
 * sometimes goes to a hosted status page rather than back to the feed. The post is not
 * wrong — it has stopped being news — but a header that reads the newest post as the
 * state of the world will report a four-hour window for a fortnight, and a menu bar
 * icon that is coloured most of the time has stopped carrying any signal at all.
 *
 * These are fixed rather than derived from each source's own cadence, on purpose: the
 * sample that would calibrate a per-source window is the same sample that contains the
 * silences being corrected for, so it calibrates towards tolerating them. Twelve hours
 * is already past the longest `status.bsky.app` has ever taken to follow up on an active
 * post; maintenance gets a day, because a window legitimately outlives a shift.
 *
 * `operational` and `unknown` are absent on purpose: there is nothing to withdraw.
 */
const CLAIM_LIFE_HOURS: Partial<Record<Health, number>> = {
  incident: 12,
  monitoring: 12,
  maintenance: 24
}

/**
 * `deriveHealth` judged against the clock.
 *
 * Going stale never flips the verdict to its opposite — that would trade a claim the
 * app cannot support for the opposite claim it cannot support either. It withdraws the
 * claim from the rollup and hands it back with its age on it, for the header to show
 * as what it now is: something somebody said, a while ago.
 */
export function deriveClaim(posts: StatusPost[], now: number): Claim {
  const health = deriveHealth(posts)
  const latest = posts[0]
  if (!latest) return { health, at: null, stale: false }

  const life = CLAIM_LIFE_HOURS[health]
  const at = Date.parse(latest.createdAt)
  const stale = life !== undefined && !Number.isNaN(at) && now - at > life * 3_600_000
  return { health, at: latest.createdAt, stale }
}

/**
 * Roll an account's recent posts up into a single at-a-glance health state,
 * based on the most recent post — status accounts post chronologically, so the
 * latest message is the current state of the world.
 *
 * This is what a source last *said*, which is the right thing for its own row in the
 * accounts list. Anything reporting the state of the world — the header, the tray —
 * wants `deriveClaim`, which also asks how long ago it said it.
 */
export function deriveHealth(posts: StatusPost[]): Health {
  const latest = posts[0]
  if (!latest) return 'unknown'
  switch (latest.severity) {
    case 'resolved':
      return 'operational'
    case 'monitoring':
      return 'monitoring'
    case 'maintenance':
      return 'maintenance'
    case 'update':
      return 'operational'
    default:
      return 'incident'
  }
}

/** Worst-case rollup across every tracked account, for the tray tooltip and header. */
export function overallHealth(healths: Health[]): Health {
  if (healths.includes('incident')) return 'incident'
  if (healths.includes('degraded')) return 'degraded'
  if (healths.includes('maintenance')) return 'maintenance'
  if (healths.includes('monitoring')) return 'monitoring'
  if (healths.includes('operational')) return 'operational'
  if (healths.includes('offline')) return 'offline'
  return 'unknown'
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  resolved: 'Resolved',
  monitoring: 'Monitoring',
  identified: 'Identified',
  investigating: 'Investigating',
  outage: 'Outage',
  degraded: 'Degraded',
  maintenance: 'Maintenance',
  update: 'Update'
}

/**
 * The same states as a noun, for reading inside a sentence: "Blacksky Status reported
 * maintenance 3 days ago". `HEALTH_LABEL` is the verdict; this is the reported claim.
 */
export const HEALTH_NOUN: Record<Health, string> = {
  operational: 'all clear',
  monitoring: 'a recovery',
  degraded: 'degraded service',
  incident: 'an incident',
  maintenance: 'maintenance',
  offline: 'no connection',
  unknown: 'nothing'
}

export const HEALTH_LABEL: Record<Health, string> = {
  operational: 'All systems operational',
  monitoring: 'Recovering — monitoring',
  degraded: 'Degraded performance',
  incident: 'Active incident',
  maintenance: 'Under maintenance',
  offline: 'You appear to be offline',
  unknown: 'No data yet'
}
