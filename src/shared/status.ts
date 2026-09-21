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
 * Roll an account's recent posts up into a single at-a-glance health state,
 * based on the most recent post — status accounts post chronologically, so the
 * latest message is the current state of the world.
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

export const HEALTH_LABEL: Record<Health, string> = {
  operational: 'All systems operational',
  monitoring: 'Recovering — monitoring',
  degraded: 'Degraded performance',
  incident: 'Active incident',
  maintenance: 'Under maintenance',
  offline: 'You appear to be offline',
  unknown: 'No data yet'
}
