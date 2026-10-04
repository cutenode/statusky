import { describe, expect, it } from 'vitest'
import {
  isWebhookSource,
  MAX_CLOCK_SKEW_MS,
  parseWebhookDelivery,
  segmentWebhookBody,
  sourceLabel,
  webhookAccount,
  webhookSourceId,
  type RawWebhookBody
} from './webhook'

const RECEIVED = '2026-03-01T12:00:00.000Z'

const PAGE = {
  id: 'pg_bsky',
  url: 'https://status.bsky.app',
  status_indicator: 'MINOROUTAGE',
  status_description: 'Degraded'
}

function delivery(body: RawWebhookBody, receivedAt = RECEIVED) {
  const parsed = parseWebhookDelivery(body, receivedAt)
  if (!parsed) throw new Error('expected the payload to parse')
  return parsed
}

describe('identifying a pushed source', () => {
  it('namespaces a page id so it cannot collide with a DID', () => {
    expect(webhookSourceId('pg_bsky')).toBe('webhook:pg_bsky')
    expect(isWebhookSource('webhook:pg_bsky')).toBe(true)
    expect(isWebhookSource('did:plc:abc')).toBe(false)
  })

  it('writes an AT Protocol handle with an @ and a status page host without one', () => {
    expect(sourceLabel('did:plc:abc', 'status.bsky.app')).toBe('@status.bsky.app')
    expect(sourceLabel('webhook:pg', 'status.bsky.app')).toBe('status.bsky.app')
    expect(sourceLabel('probe:network', 'Network checks')).toBe('Network checks')
  })

  it('builds a removable, notifying account from a page', () => {
    const account = webhookAccount(
      {
        id: 'webhook:pg',
        host: 'status.bsky.app',
        url: 'https://status.bsky.app',
        description: 'OK'
      },
      RECEIVED
    )

    expect(account).toMatchObject({
      did: 'webhook:pg',
      handle: 'status.bsky.app',
      displayName: 'status.bsky.app',
      description: 'OK',
      notify: 'default',
      muted: false,
      builtin: false,
      kind: 'webhook'
    })
  })

  it('names the source after the page hostname', () => {
    expect(delivery({ page: PAGE, incident: incident({}) }).source).toEqual({
      id: 'webhook:pg_bsky',
      host: 'status.bsky.app',
      url: 'https://status.bsky.app/',
      description: 'Degraded'
    })
  })

  it('falls back to the hostname when the page carries no id', () => {
    const { source } = delivery({
      page: { url: 'https://status.example.test' },
      incident: incident({})
    })

    expect(source.id).toBe('webhook:status.example.test')
    expect(source.description).toBeNull()
  })

  it('refuses a payload that identifies no page at all', () => {
    expect(parseWebhookDelivery({ incident: incident({}) }, RECEIVED)).toBeNull()
    expect(parseWebhookDelivery({ page: { url: 'ftp://status.test' } }, RECEIVED)).toBeNull()
  })

  it('refuses anything that is not a JSON object', () => {
    expect(parseWebhookDelivery(null, RECEIVED)).toBeNull()
    expect(parseWebhookDelivery('a string', RECEIVED)).toBeNull()
    expect(parseWebhookDelivery([{ page: PAGE }], RECEIVED)).toBeNull()
  })

  it('refuses a payload that carries no incident, maintenance or component', () => {
    expect(parseWebhookDelivery({ page: PAGE }, RECEIVED)).toBeNull()
  })
})

function incident(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'inc_1',
    name: 'Elevated error rates',
    status: 'INVESTIGATING',
    url: 'https://status.bsky.app/incidents/inc_1',
    created_at: '2026-03-01T09:00:00.000Z',
    ...overrides
  }
}

describe('incidents', () => {
  it('turns every update into its own feed entry, keyed by the update id', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [
          {
            id: 'u2',
            status: 'MONITORING',
            created_at: '2026-03-01T10:00:00.000Z',
            body: 'Watching.'
          },
          {
            id: 'u1',
            status: 'INVESTIGATING',
            created_at: '2026-03-01T09:00:00.000Z',
            body: 'Looking.'
          }
        ]
      })
    })

    expect(posts.map((p) => p.uri)).toEqual([
      'webhook:pg_bsky/incident/inc_1/u2',
      'webhook:pg_bsky/incident/inc_1/u1'
    ])
    expect(posts.map((p) => p.severity)).toEqual(['monitoring', 'investigating'])
    expect(posts[0]!.createdAt).toBe('2026-03-01T10:00:00.000Z')
    expect(posts[0]!.indexedAt).toBe(RECEIVED)
    expect(posts[0]!.url).toBe('https://status.bsky.app/incidents/inc_1')
    expect(posts[0]!.authorDid).toBe('webhook:pg_bsky')
  })

  it('repeats the incident name above each update, so an entry reads on its own', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [{ id: 'u1', status: 'IDENTIFIED', body: 'A bad deploy.' }]
      })
    })

    expect(posts[0]!.text).toBe('Elevated error rates\n\nA bad deploy.')
  })

  it('maps every lifecycle status onto the feed severities', () => {
    const severities = ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED', 'POSTMORTEM'].map(
      (status) =>
        delivery({
          page: PAGE,
          incident: incident({ incident_updates: [{ id: status, status, body: 'x' }] })
        }).posts[0]!.severity
    )

    expect(severities).toEqual([
      'investigating',
      'identified',
      'monitoring',
      'resolved',
      'resolved'
    ])
  })

  it('accepts the same statuses in Statuspage casing and spelling', () => {
    const resolved = delivery({
      page: PAGE,
      incident: incident({ incident_updates: [{ id: 'u1', status: 'resolved', body: 'x' }] })
    })
    expect(resolved.posts[0]!.severity).toBe('resolved')

    // Statuspage writes its multi-word states in snake case.
    const underway = delivery({
      page: PAGE,
      maintenance: {
        id: 'mnt_1',
        name: 'Upgrade',
        maintenance_updates: [{ id: 'u1', status: 'in_progress', body: 'x' }]
      }
    })
    const broken = delivery({
      page: PAGE,
      component: { id: 'cmp_1', name: 'AppView' },
      component_update: { new_status: 'partial_outage' }
    })
    expect(underway.posts[0]!.severity).toBe('maintenance')
    expect(broken.posts[0]!.severity).toBe('outage')
  })

  it('falls through to the incident’s own stage for an update status it does not know', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({ incident_updates: [{ id: 'u1', status: 'in progress', body: 'x' }] })
    })
    expect(posts[0]!.severity).toBe('investigating')
  })

  it('classifies the prose when neither the update nor the incident names a stage', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        status: 'SOMETHING_NEW',
        incident_updates: [{ id: 'u1', status: '', body: 'We have identified the root cause.' }]
      })
    })

    expect(posts[0]!.severity).toBe('identified')
  })

  it('falls back to the incident record when it carries no updates', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({ status: 'RESOLVED', updated_at: '2026-03-01T11:00:00.000Z' })
    })

    expect(posts).toHaveLength(1)
    expect(posts[0]!.uri).toBe('webhook:pg_bsky/incident/inc_1')
    expect(posts[0]!.severity).toBe('resolved')
    expect(posts[0]!.createdAt).toBe('2026-03-01T11:00:00.000Z')
    expect(posts[0]!.text).toBe('Elevated error rates')
  })

  it('classifies an update-less incident from its name when it names no stage either', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({ status: '', name: 'Scheduled maintenance', updated_at: undefined })
    })

    expect(posts[0]!.severity).toBe('maintenance')
    // No `updated_at` either: the incident's own open time is the only timestamp left.
    expect(posts[0]!.createdAt).toBe('2026-03-01T09:00:00.000Z')
  })

  it('falls back to the name when an incident carries no id', () => {
    const withUpdates = delivery({
      page: PAGE,
      incident: incident({ id: undefined, incident_updates: [{ id: 'u1', body: 'x' }] })
    })
    const without = delivery({ page: PAGE, incident: incident({ id: undefined }) })

    expect(withUpdates.posts[0]!.uri).toBe('webhook:pg_bsky/incident/Elevated error rates/u1')
    expect(without.posts[0]!.uri).toBe('webhook:pg_bsky/incident/Elevated error rates')
  })

  it('falls back to a placeholder when an incident has updates but no name either', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({ id: undefined, name: '', incident_updates: [{ id: 'u1', body: 'x' }] })
    })

    expect(posts[0]!.uri).toBe('webhook:pg_bsky/incident/unknown/u1')
  })

  it('ignores an incident with neither an id nor a name', () => {
    expect(
      parseWebhookDelivery({ page: PAGE, incident: { status: 'RESOLVED' } }, RECEIVED)
    ).toBeNull()
  })

  it('positions an update with no id by where it sat in the list', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({ incident_updates: [{ status: 'RESOLVED', body: 'Done.' }] })
    })

    expect(posts[0]!.uri).toBe('webhook:pg_bsky/incident/inc_1/0')
  })

  it('dates an update with no timestamp from the incident it belongs to', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({ incident_updates: [{ id: 'u1', status: 'RESOLVED', body: 'Done.' }] })
    })

    expect(posts[0]!.createdAt).toBe('2026-03-01T09:00:00.000Z')
  })

  it('dates an incident that carries no timestamps from when the delivery arrived', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: { id: 'inc_2', name: 'Down', status: 'INVESTIGATING' }
    })

    expect(posts[0]!.createdAt).toBe(RECEIVED)
  })

  it('accepts epoch milliseconds as well as ISO timestamps', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [
          { id: 'u1', status: 'RESOLVED', created_at: 1_772_366_400_000, body: 'x' }
        ]
      })
    })

    expect(posts[0]!.createdAt).toBe(new Date(1_772_366_400_000).toISOString())
  })

  it('ignores a garbage timestamp rather than storing an Invalid Date', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [{ id: 'u1', status: 'RESOLVED', created_at: 'soon', body: 'x' }]
      })
    })

    expect(posts[0]!.createdAt).toBe('2026-03-01T09:00:00.000Z')
  })

  /** A finite number is not necessarily a date: `toISOString` throws past ±8.64e15 ms. */
  it('ignores an epoch timestamp too large to be a date rather than throwing on it', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [{ id: 'u1', status: 'RESOLVED', created_at: 1e20, body: 'x' }]
      })
    })

    expect(posts[0]!.createdAt).toBe('2026-03-01T09:00:00.000Z')
  })

  it('skips update entries that are not objects rather than throwing on them', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [null, 5, 'text', [], { id: 'u1', status: 'RESOLVED', body: 'Done.' }]
      })
    })

    expect(posts.map((post) => post.uri)).toEqual(['webhook:pg_bsky/incident/inc_1/u1'])
  })

  it('falls back to the incident record when none of its updates is an object', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({ incident_updates: [null] })
    })

    expect(posts.map((post) => post.uri)).toEqual(['webhook:pg_bsky/incident/inc_1'])
  })

  it('reads a part that is not an object as absent, whatever else the payload says', () => {
    expect(parseWebhookDelivery({ page: 'status.bsky.app', incident: incident({}) })).toBeNull()
    expect(parseWebhookDelivery({ page: PAGE, incident: 'down', maintenance: null })).toBeNull()
    expect(
      delivery({
        page: PAGE,
        incident: [],
        component: 'Relay',
        component_update: { component_id: 'cmp_1', new_status: 'MAJOROUTAGE' }
      }).posts[0]!.text
    ).toBe('A component is in a major outage.')
  })

  it('drops a non-http incident link rather than handing it to the shell', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        url: 'javascript:alert(1)',
        incident_updates: [{ id: 'u1', status: 'RESOLVED', body: 'x' }]
      })
    })

    // The page URL is the fallback; it is the only link left that we trust.
    expect(posts[0]!.url).toBe('https://status.bsky.app/')
  })

  it('leaves a post with no link at all when neither the incident nor the page has one', () => {
    const { posts } = delivery({
      page: { id: 'pg' },
      incident: incident({ url: undefined, incident_updates: [{ id: 'u1', body: 'x' }] })
    })

    expect(posts[0]!.url).toBe('')
  })
})

describe('maintenance windows', () => {
  it('maps its own status vocabulary', () => {
    const severities = ['NOTSTARTEDYET', 'INPROGRESS', 'VERIFYING', 'COMPLETED'].map(
      (status) =>
        delivery({
          page: PAGE,
          maintenance: {
            id: 'mnt_1',
            name: 'Database upgrade',
            maintenance_updates: [{ id: status, status, body: 'x' }]
          }
        }).posts[0]!.severity
    )

    expect(severities).toEqual(['maintenance', 'maintenance', 'maintenance', 'resolved'])
  })

  it('files maintenance under its own key space, so ids cannot collide with incidents', () => {
    const { posts } = delivery({
      page: PAGE,
      maintenance: { id: 'inc_1', name: 'Upgrade', maintenance_updates: [{ id: 'u1', body: 'x' }] }
    })

    expect(posts[0]!.uri).toBe('webhook:pg_bsky/maintenance/inc_1/u1')
  })

  it('is ignored when an incident is present, which is the more urgent of the two', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({ incident_updates: [{ id: 'u1', body: 'x' }] }),
      maintenance: { id: 'mnt_1', name: 'Upgrade', maintenance_updates: [{ id: 'u1', body: 'y' }] }
    })

    expect(posts).toHaveLength(1)
    expect(posts[0]!.uri).toContain('/incident/')
  })
})

describe('component status changes', () => {
  const component = { id: 'cmp_1', name: 'AppView', status: 'OPERATIONAL' }

  it('reads as a sentence and carries the matching severity', () => {
    const { posts } = delivery({
      page: PAGE,
      component,
      component_update: {
        component_id: 'cmp_1',
        new_status: 'MAJOROUTAGE',
        created_at: '2026-03-01T10:00:00.000Z'
      }
    })

    expect(posts[0]!.text).toBe('AppView is in a major outage.')
    expect(posts[0]!.severity).toBe('outage')
    expect(posts[0]!.uri).toBe('webhook:pg_bsky/component/cmp_1/2026-03-01T10:00:00.000Z')
  })

  it('maps every component state, treating a partial outage as an outage', () => {
    const severities = [
      'OPERATIONAL',
      'UNDERMAINTENANCE',
      'DEGRADEDPERFORMANCE',
      'PARTIALOUTAGE',
      'MAJOROUTAGE'
    ].map(
      (new_status) =>
        delivery({ page: PAGE, component, component_update: { new_status } }).posts[0]!.severity
    )

    expect(severities).toEqual(['resolved', 'maintenance', 'degraded', 'outage', 'outage'])
  })

  it('falls back to the component record when the update names no new status', () => {
    const { posts } = delivery({
      page: PAGE,
      component: { ...component, status: 'DEGRADEDPERFORMANCE' },
      component_update: { component_id: 'cmp_1' }
    })

    expect(posts[0]!.severity).toBe('degraded')
  })

  it('ignores a state neither record recognises', () => {
    expect(
      parseWebhookDelivery(
        { page: PAGE, component, component_update: { new_status: 'ON_FIRE' } },
        RECEIVED
      )
    ).toBeNull()
  })

  it('ignores an update that names no component', () => {
    expect(
      parseWebhookDelivery(
        { page: PAGE, component_update: { new_status: 'MAJOROUTAGE' } },
        RECEIVED
      )
    ).toBeNull()
  })

  it('names an anonymous component rather than leaving a gap in the sentence', () => {
    const { posts } = delivery({
      page: PAGE,
      component: { id: 'cmp_9' },
      component_update: { new_status: 'PARTIALOUTAGE', created_at: '2026-03-01T10:00:00.000Z' }
    })

    expect(posts[0]!.text).toBe('A component is in a partial outage.')
  })

  it('falls back to the component name when it carries no id', () => {
    const { posts } = delivery({
      page: PAGE,
      component: { name: 'Relay' },
      component_update: { new_status: 'MAJOROUTAGE', created_at: '2026-03-01T10:00:00.000Z' }
    })

    expect(posts[0]!.uri).toBe('webhook:pg_bsky/component/Relay/2026-03-01T10:00:00.000Z')
  })

  it('dates a change with no timestamp from when the delivery arrived', () => {
    const { posts } = delivery({
      page: PAGE,
      component,
      component_update: { new_status: 'MAJOROUTAGE' }
    })

    expect(posts[0]!.createdAt).toBe(RECEIVED)
  })
})

describe('rendering an update body', () => {
  it('strips markup and keeps paragraphs as blank lines', () => {
    expect(segmentWebhookBody('<p>First.</p><p>Second.</p>')).toEqual([
      { kind: 'text', text: 'First.\n\nSecond.' }
    ])
  })

  it('keeps anchors as links, without letting them swallow the text around them', () => {
    expect(
      segmentWebhookBody('See the <a href="https://bsky.app/status">status page</a> for more.')
    ).toEqual([
      { kind: 'text', text: 'See the ' },
      { kind: 'link', text: 'status page', uri: 'https://bsky.app/status' },
      { kind: 'text', text: ' for more.' }
    ])
  })

  it('links a URL that opens the body, with nothing before it', () => {
    expect(segmentWebhookBody('https://status.bsky.app is the place to look')).toEqual([
      { kind: 'link', text: 'https://status.bsky.app', uri: 'https://status.bsky.app/' },
      { kind: 'text', text: ' is the place to look' }
    ])
  })

  it('links a URL that ends the sentence without punctuation', () => {
    expect(segmentWebhookBody('See https://status.bsky.app/x for more')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://status.bsky.app/x', uri: 'https://status.bsky.app/x' },
      { kind: 'text', text: ' for more' }
    ])
  })

  it('leaves something URL-shaped that is not a URL as plain text', () => {
    expect(segmentWebhookBody('nothing at https://. sorry')).toEqual([
      { kind: 'text', text: 'nothing at https://. sorry' }
    ])
  })

  it('leaves inline markup out of the line breaks', () => {
    expect(segmentWebhookBody('<p>Some <strong>bold</strong> text.</p>')).toEqual([
      { kind: 'text', text: 'Some bold text.' }
    ])
  })

  it('closes an anchor when a second one opens inside it', () => {
    expect(
      segmentWebhookBody('<a href="https://a.test">first<a href="https://b.test">second</a>')
    ).toEqual([
      { kind: 'link', text: 'first', uri: 'https://a.test/' },
      { kind: 'link', text: 'second', uri: 'https://b.test/' }
    ])
  })

  it('turns a bare URL in prose into a link', () => {
    expect(segmentWebhookBody('Details at https://status.bsky.app/incidents/1.')).toEqual([
      { kind: 'text', text: 'Details at ' },
      {
        kind: 'link',
        text: 'https://status.bsky.app/incidents/1',
        uri: 'https://status.bsky.app/incidents/1'
      },
      { kind: 'text', text: '.' }
    ])
  })

  it('keeps the words when an anchor points somewhere we will not open', () => {
    expect(segmentWebhookBody('<a href="javascript:alert(1)">click me</a>')).toEqual([
      { kind: 'text', text: 'click me' }
    ])
    expect(segmentWebhookBody('<a>bare anchor</a>')).toEqual([
      { kind: 'text', text: 'bare anchor' }
    ])
  })

  it('drops an anchor that wraps nothing', () => {
    expect(segmentWebhookBody('a<a href="https://x.test"></a>b')).toEqual([
      { kind: 'text', text: 'ab' }
    ])
  })

  it('closes an unterminated anchor at the next block boundary', () => {
    expect(segmentWebhookBody('<a href="https://x.test">link<p>after')).toEqual([
      { kind: 'link', text: 'link', uri: 'https://x.test/' },
      { kind: 'text', text: '\nafter' }
    ])
  })

  it('closes an anchor left open at the end of the body', () => {
    expect(segmentWebhookBody('<a href="https://x.test">tail')).toEqual([
      { kind: 'link', text: 'tail', uri: 'https://x.test/' }
    ])
  })

  it('decodes named, decimal and hex entities', () => {
    expect(
      segmentWebhookBody('R&amp;D &lt;tags&gt; &#39;quoted&#39; &#x2014; done&nbsp;now')
    ).toEqual([{ kind: 'text', text: "R&D <tags> 'quoted' — done now" }])
  })

  it('leaves an entity it does not understand alone', () => {
    expect(segmentWebhookBody('100&percnt; &#x110000; &#0;')).toEqual([
      { kind: 'text', text: '100&percnt; &#x110000; &#0;' }
    ])
  })

  it('does not mistake what every object inherits for an entity', () => {
    expect(segmentWebhookBody('&constructor; &toString; &__proto__;')).toEqual([
      { kind: 'text', text: '&constructor; &toString; &__proto__;' }
    ])
  })

  it('produces nothing at all for an empty body', () => {
    expect(segmentWebhookBody('')).toEqual([])
    expect(segmentWebhookBody('<p></p>')).toEqual([])
  })

  it('collapses the whitespace that stripped markup leaves behind', () => {
    expect(segmentWebhookBody('<div>a</div>\n\n\n\n<div>b</div>')).toEqual([
      { kind: 'text', text: 'a\n\nb' }
    ])
  })

  it('does not linkify inside an anchor it already captured', () => {
    expect(segmentWebhookBody('<a href="https://a.test">https://b.test</a>')).toEqual([
      { kind: 'link', text: 'https://b.test', uri: 'https://a.test/' }
    ])
  })

  it('flattens the segments into the plain text a notification reads', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [
          {
            id: 'u1',
            status: 'RESOLVED',
            body: '<p>Fixed. See <a href="https://x.test">here</a>.</p>'
          }
        ]
      })
    })

    expect(posts[0]!.text).toBe('Elevated error rates\n\nFixed. See here.')
  })
})

describe('refusing to trust the payload', () => {
  it('keeps only http and https links to the page and the incident', () => {
    const { source, posts } = delivery({
      page: { ...PAGE, url: 'https://status.bsky.app' },
      incident: incident({ url: 'smb://attacker.test/share' })
    })

    expect(source.url).toBe('https://status.bsky.app/')
    // The incident's own link is refused, so the entry falls back to the page's.
    expect(posts[0]!.url).toBe('https://status.bsky.app/')
  })

  it('caps how many updates one delivery can turn into posts', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: Array.from({ length: 120 }, (_, i) => ({
          id: `u${i}`,
          status: 'MONITORING',
          body: 'x'
        }))
      })
    })

    expect(posts).toHaveLength(50)
  })

  it('caps the length of the body it will store', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        name: '',
        incident_updates: [{ id: 'u1', status: 'MONITORING', body: 'x'.repeat(10_000) }]
      })
    })

    expect(posts[0]!.text).toHaveLength(4_000)
  })

  it('ignores an update list that is not a list', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({ incident_updates: { id: 'u1' } })
    })

    expect(posts).toHaveLength(1)
    expect(posts[0]!.uri).toBe('webhook:pg_bsky/incident/inc_1')
  })

  it('ignores fields of the wrong type instead of rendering "undefined"', () => {
    const { posts } = delivery({
      page: { id: 'pg', url: 42 },
      incident: { id: 7, name: 'Broken', status: 99, incident_updates: [{ id: 'u1', body: [] }] }
    })

    expect(posts[0]!.uri).toBe('webhook:pg/incident/Broken/u1')
    expect(posts[0]!.text).toBe('Broken')
    expect(posts[0]!.url).toBe('')
  })
})

/**
 * The sender picks every timestamp in a delivery. Within a few minutes of its arrival a
 * date is two clocks disagreeing and is kept; past that it is a date nobody can vouch
 * for, and the update is dated when it arrived. See `MAX_CLOCK_SKEW_MS`.
 */
/** An epoch time as the ISO string a delivery would carry. */
function at(ms: number): string {
  return new Date(ms).toISOString()
}

describe('timestamps from the future', () => {
  const arrived = Date.parse(RECEIVED)

  it('keeps an update dated a little after it arrived, as clocks disagree', () => {
    const ahead = at(arrived + MAX_CLOCK_SKEW_MS)
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [{ id: 'u1', status: 'MONITORING', created_at: ahead, body: 'x' }]
      })
    })

    expect(posts[0]!.createdAt).toBe(ahead)
  })

  it('dates an update from further ahead than that when it arrived', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [
          { id: 'u2', status: 'MONITORING', created_at: '2099-01-01T00:00:00.000Z', body: 'x' },
          { id: 'u1', status: 'INVESTIGATING', created_at: at(arrived + MAX_CLOCK_SKEW_MS + 1) }
        ]
      })
    })

    expect(posts.map((post) => post.createdAt)).toEqual([RECEIVED, RECEIVED])
  })

  it('holds an epoch timestamp to the same rule as an ISO one', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        incident_updates: [{ id: 'u1', status: 'RESOLVED', created_at: 4_102_444_800_000 }]
      })
    })

    expect(posts[0]!.createdAt).toBe(RECEIVED)
  })

  it('dates an incident with no update list from the future when it arrived', () => {
    const { posts } = delivery({
      page: PAGE,
      incident: incident({
        created_at: '2099-01-01T00:00:00.000Z',
        updated_at: '2099-01-02T00:00:00.000Z'
      })
    })

    expect(posts[0]!.createdAt).toBe(RECEIVED)
  })

  it('dates a component change from the future when it arrived', () => {
    const { posts } = delivery({
      page: PAGE,
      component: { id: 'cmp_1', name: 'AppView' },
      component_update: { new_status: 'MAJOROUTAGE', created_at: '2099-01-01T00:00:00.000Z' }
    })

    expect(posts[0]!.createdAt).toBe(RECEIVED)
    expect(posts[0]!.uri).toBe(`webhook:pg_bsky/component/cmp_1/${RECEIVED}`)
  })
})
