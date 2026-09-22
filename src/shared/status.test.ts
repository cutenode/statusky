import { describe, expect, it } from 'vitest'
import {
  HEALTH_LABEL,
  HEALTH_NOUN,
  SEVERITY_LABEL,
  classifySeverity,
  deriveClaim,
  deriveHealth,
  isActiveIncident,
  overallHealth,
  type Health
} from './status'
import type { StatusPost, Severity } from './types'

/** Every string below is real text posted by status.bsky.app or status.blacksky.community. */
const REAL_POSTS: [string, Severity][] = [
  ['This incident has been resolved.\n\nstatus.bsky.app', 'resolved'],
  ['The issue has been resolved. We will continue to monitor the situation.', 'resolved'],
  ['Server work completed for today!', 'resolved'],
  // A `Resolved:` prefix restates the original text; the prefix must win.
  ['Resolved: We are investigating various alerts coming from our PDS fleet', 'resolved'],
  [
    'Resolved: We are experiencing an outage in one of our regions and are working to restore service.',
    'resolved'
  ],
  [
    'Resolved: We have identified the cause of an issue causing the site and related systems to fail to load and are working towards a resolution.',
    'resolved'
  ],

  ['We have restored service and are continuing to monitor.', 'monitoring'],
  ['Update: We have restored service and are continuing monitor.', 'monitoring'],
  [
    'The fix has been implemented, and service has been restored for users. We are continuing to monitor the situation.',
    'monitoring'
  ],
  [
    'We experienced a brief partial outage of chat functionality, which is now recovering.',
    'monitoring'
  ],
  [
    'We made a network configuration change that caused a brief availability incident. We have reverted the change and are observing traffic returning to normal.',
    'monitoring'
  ],

  [
    'We have identified the cause of an issue causing the site and related systems to fail to load and are working towards a resolution.',
    'identified'
  ],
  [
    'Update: We have identified the root cause of the incident and we are continuing to work to restore service.',
    'identified'
  ],

  ['We are investigating an issue with the site.', 'investigating'],
  [
    'We are investigating an issue where posts, likes, etc. are failing to be saved.',
    'investigating'
  ],
  // The account has posted this typo more than once.
  ['We are investigate connectivity issue with one of our PDS (inkcap)', 'investigating'],
  [
    'We have an incident under investigation on one of our PDSes that might affect some of our users.',
    'investigating'
  ],
  [
    'Video uploads are currently failing.  We are actively investigating the issue.',
    'investigating'
  ],

  [
    'We are performing repairs and maintenance on our backend server to reduce storage space.',
    'maintenance'
  ],
  [
    'We will be working on our servers from August 21, 2026 11pm ET to August 22, 2026 3am ET.',
    'maintenance'
  ],

  ['Update: Inkcap is unaccessible. We are working to restore connectivity', 'investigating'],
  [
    "Blacksky's fleet of PDSs were down from about 12:45am to 5:30am ET. logins and most requests timed out.",
    'outage'
  ],

  [
    'Our apps are currently experiencing a delay, which may be impacting your experience.',
    'degraded'
  ],

  [
    'You can follow @status.blacksky.community for updates or go to status.blacksky.community',
    'update'
  ],
  ['We will provide status updates as we complete this!', 'update']
]

describe('classifySeverity', () => {
  it.each(REAL_POSTS)('classifies %j as %s', (text, expected) => {
    expect(classifySeverity(text)).toBe(expected)
  })

  it('falls back to `update` for text with no lifecycle signal', () => {
    expect(classifySeverity('Hello from the team.')).toBe('update')
  })

  it('treats empty and whitespace-only text as an update', () => {
    expect(classifySeverity('')).toBe('update')
    expect(classifySeverity('   \n  ')).toBe('update')
  })

  it('does not let an `Update:` prefix mask the stage in the body', () => {
    expect(
      classifySeverity('Update: We are investigating multiple PDS instances being down.')
    ).toBe('investigating')
  })

  it('prefers the later lifecycle stage when several are mentioned', () => {
    // Both "identified" and "monitoring" language appear; monitoring is further along.
    expect(
      classifySeverity('We identified the cause and applied a fix. We are monitoring the results.')
    ).toBe('monitoring')
  })
})

describe('isActiveIncident', () => {
  it('treats unresolved operational states as active', () => {
    expect(isActiveIncident('investigating')).toBe(true)
    expect(isActiveIncident('identified')).toBe(true)
    expect(isActiveIncident('outage')).toBe(true)
    expect(isActiveIncident('degraded')).toBe(true)
  })

  it('does not treat recovery, maintenance or chatter as active', () => {
    expect(isActiveIncident('resolved')).toBe(false)
    expect(isActiveIncident('monitoring')).toBe(false)
    expect(isActiveIncident('maintenance')).toBe(false)
    expect(isActiveIncident('update')).toBe(false)
  })
})

function post(severity: Severity, createdAt: string): StatusPost {
  return {
    uri: `at://did:plc:x/app.bsky.feed.post/${createdAt}`,
    cid: 'cid',
    rkey: createdAt,
    authorDid: 'did:plc:x',
    authorHandle: 'x.test',
    authorDisplayName: 'X',
    authorAvatar: null,
    text: '',
    segments: [],
    embed: null,
    createdAt,
    indexedAt: createdAt,
    severity,
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    url: 'https://bsky.app'
  }
}

describe('deriveHealth', () => {
  it('reports unknown with no posts', () => {
    expect(deriveHealth([])).toBe('unknown')
  })

  it('uses the newest post, which callers pass first', () => {
    const posts = [post('resolved', '2026-09-05T01:00:00Z'), post('outage', '2026-09-05T00:00:00Z')]
    expect(deriveHealth(posts)).toBe('operational')
  })

  it('maps an unresolved newest post to an incident', () => {
    expect(deriveHealth([post('investigating', '2026-09-05T00:00:00Z')])).toBe('incident')
  })

  it('keeps monitoring distinct from fully operational', () => {
    expect(deriveHealth([post('monitoring', '2026-09-05T00:00:00Z')])).toBe('monitoring')
  })
})

describe('deriveClaim', () => {
  const NOW = Date.parse('2026-09-05T12:00:00.000Z')
  const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString()

  it('dates the claim to the post it rests on', () => {
    expect(deriveClaim([post('outage', hoursAgo(2))], NOW)).toEqual({
      health: 'incident',
      at: hoursAgo(2),
      stale: false
    })
  })

  it('has nothing to date when the source has posted nothing', () => {
    expect(deriveClaim([], NOW)).toEqual({ health: 'unknown', at: null, stale: false })
  })

  it('keeps an incident for twelve hours and a maintenance window for a day', () => {
    expect(deriveClaim([post('outage', hoursAgo(11))], NOW).stale).toBe(false)
    expect(deriveClaim([post('outage', hoursAgo(13))], NOW).stale).toBe(true)
    expect(deriveClaim([post('monitoring', hoursAgo(13))], NOW).stale).toBe(true)
    expect(deriveClaim([post('maintenance', hoursAgo(23))], NOW).stale).toBe(false)
    expect(deriveClaim([post('maintenance', hoursAgo(25))], NOW).stale).toBe(true)
  })

  it('goes stale without changing what was claimed', () => {
    // The verdict is withdrawn from the rollup, not replaced by its opposite: an app
    // that flips to "all clear" on a timer is asserting something it knows no better.
    expect(deriveClaim([post('maintenance', hoursAgo(400))], NOW)).toEqual({
      health: 'maintenance',
      at: hoursAgo(400),
      stale: true
    })
  })

  it('never ages out an all-clear, which has nothing to withdraw', () => {
    expect(deriveClaim([post('resolved', hoursAgo(5000))], NOW).stale).toBe(false)
    expect(deriveClaim([post('update', hoursAgo(5000))], NOW).stale).toBe(false)
  })

  it('treats an undated post as current rather than dropping it', () => {
    expect(deriveClaim([post('outage', 'not a date')], NOW).stale).toBe(false)
  })
})

describe('overallHealth', () => {
  it('reports the worst state across accounts', () => {
    expect(overallHealth(['operational', 'incident', 'monitoring'])).toBe('incident')
    expect(overallHealth(['operational', 'maintenance'])).toBe('maintenance')
    expect(overallHealth(['operational', 'monitoring'])).toBe('monitoring')
    expect(overallHealth(['operational', 'operational'])).toBe('operational')
  })

  it('reports unknown when nothing is known', () => {
    expect(overallHealth([])).toBe('unknown')
    expect(overallHealth(['unknown', 'unknown'])).toBe('unknown')
  })

  it('ranks a measured partial failure above maintenance but below an incident', () => {
    expect(overallHealth(['maintenance', 'degraded'])).toBe('degraded')
    expect(overallHealth(['degraded', 'incident'])).toBe('incident')
  })

  it('lets anything known outrank being offline, which only says nothing is known', () => {
    expect(overallHealth(['offline', 'operational'])).toBe('operational')
    expect(overallHealth(['offline', 'unknown'])).toBe('offline')
  })
})

describe('deriveHealth, per severity', () => {
  it.each([
    ['resolved', 'operational'],
    ['update', 'operational'],
    ['monitoring', 'monitoring'],
    ['maintenance', 'maintenance'],
    ['investigating', 'incident'],
    ['identified', 'incident'],
    ['outage', 'incident'],
    ['degraded', 'incident']
  ] as const)('maps %s to %s', (severity, health) => {
    expect(deriveHealth([post(severity, '2026-09-05T00:00:00Z')])).toBe(health)
  })
})

describe('HEALTH_NOUN', () => {
  it('reads inside a sentence, where HEALTH_LABEL would not', () => {
    expect(`Blacksky Status reported ${HEALTH_NOUN.maintenance} 3 days ago`).toBe(
      'Blacksky Status reported maintenance 3 days ago'
    )
    expect(`Bluesky Status reported ${HEALTH_NOUN.incident} 2 hours ago`).toBe(
      'Bluesky Status reported an incident 2 hours ago'
    )
  })

  it('names every health, as the label table does', () => {
    expect(Object.keys(HEALTH_NOUN).toSorted()).toEqual(Object.keys(HEALTH_LABEL).toSorted())
  })
})

describe('the severity and health label tables', () => {
  it('names every severity', () => {
    const severities: Severity[] = [
      'resolved',
      'monitoring',
      'identified',
      'investigating',
      'outage',
      'degraded',
      'maintenance',
      'update'
    ]
    expect(Object.keys(SEVERITY_LABEL).toSorted()).toEqual([...severities].toSorted())
    expect(Object.values(SEVERITY_LABEL).every((label) => label.length > 0)).toBe(true)
  })

  it('names every health state', () => {
    const healths: Health[] = [
      'operational',
      'monitoring',
      'degraded',
      'incident',
      'maintenance',
      'offline',
      'unknown'
    ]
    expect(Object.keys(HEALTH_LABEL).toSorted()).toEqual([...healths].toSorted())
    expect(Object.values(HEALTH_LABEL).every((label) => label.length > 0)).toBe(true)
  })
})

describe('isActiveIncident', () => {
  it.each([
    ['investigating', true],
    ['identified', true],
    ['outage', true],
    ['degraded', true],
    ['monitoring', false],
    ['resolved', false],
    ['maintenance', false],
    ['update', false]
  ] as const)('reports %s as %s', (severity, active) => {
    expect(isActiveIncident(severity)).toBe(active)
  })
})
