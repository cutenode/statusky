import { describe, expect, it } from 'vitest'
import {
  makeAccount,
  makeCheck,
  makeNetworkSummary,
  makePost,
  makeService,
  makeSnapshot
} from '../test/factories'
import {
  CATALOGUE,
  PROBE_GROUPS,
  PROBE_SOURCE_DID,
  SERVICES,
  SLOW_MS,
  blankService,
  checkDetail,
  describeFailure,
  formatLatency,
  headline,
  humanDuration,
  isControl,
  isCore,
  isOffline,
  isProbeSource,
  isReachable,
  medianLatency,
  networkAsHealth,
  networkForHealth,
  observedCondition,
  probeAccount,
  probePost,
  probeServiceId,
  probeState,
  reportHeadline,
  servicesFor,
  splitHost,
  summarizeNetwork,
  uptimePercent,
  type ProbeEvent
} from './network'
import { DEFAULT_PROBE_TARGETS } from './probe-targets'
import { HEALTH_LABEL, type Health } from './status'
import type { ProbeState } from './types'

const relay = SERVICES.find((s) => s.id === 'relay:europe.firehose.network')!

const count = (group: string): number => SERVICES.filter((s) => s.group === group).length

const control = (state: ProbeState): { group: 'internet'; state: ProbeState } => ({
  group: 'internet',
  state
})

const sample = (state: ProbeState): { state: ProbeState } => ({ state })

describe('the catalogue', () => {
  it('covers every service status.feeds.blue measures', () => {
    expect(count('relays')).toBe(CATALOGUE.relays.length)
    expect(count('appviews')).toBe(CATALOGUE.appViews.length + CATALOGUE.communityAppViews.length)
    // The hand-kept PDSes and the community ones.
    expect(count('pdses')).toBe(CATALOGUE.pdses.length + CATALOGUE.communityPdses.length)
    // Discover feed, For You, Constellation, UFOs, Slingshot and the CDN.
    expect(count('infrastructure')).toBe(6)
    expect(count('internet')).toBe(4)
  })

  it('covers the services beyond that page', () => {
    expect(count('streams')).toBe(CATALOGUE.jetstreams.length + 1)
    // Appview, Bobbin, Hydrant, the PDS, the default knot and the default spindle.
    expect(count('tangled')).toBe(
      4 + CATALOGUE.tangled.knots.length + CATALOGUE.tangled.spindles.length
    )
    expect(count('apps')).toBe(3)
    expect(SERVICES.find((s) => s.id === 'pds:tngl.sh')?.group).toBe('tangled')
  })

  it('grades hobby infrastructure below the network proper', () => {
    const community = SERVICES.filter((s) => s.tier === 'community').map((s) => s.host)
    expect(community).toEqual([...CATALOGUE.communityAppViews, ...CATALOGUE.communityPdses])
    expect(SERVICES.filter(isCore).every((s) => s.tier === 'core')).toBe(true)
    expect(SERVICES.filter(isControl).some(isCore)).toBe(false)
  })

  it('gives every service a unique, stable id', () => {
    const ids = SERVICES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('relay:bsky.network')
    expect(ids).toContain('feed:discover.bsky.app')
    expect(ids).toContain('internet:github')
  })

  it('names friendly services, and writes hosts for the rest', () => {
    const discover = SERVICES.find((s) => s.kind === 'feed')!
    expect(discover).toMatchObject({ label: 'Discover feed', host: 'discover.bsky.app' })
    const aws = SERVICES.find((s) => s.id === 'internet:aws')!
    expect(aws).toMatchObject({ label: 'Amazon AWS', host: 'checkip.amazonaws.com' })
    expect(relay.label).toBe(relay.host)
  })

  it('has a panel for every group, the control group last', () => {
    expect(PROBE_GROUPS.map((g) => g.id)).toEqual([
      'relays',
      'streams',
      'appviews',
      'pdses',
      'tangled',
      'apps',
      'infrastructure',
      'internet'
    ])
    for (const service of SERVICES) {
      expect(PROBE_GROUPS.some((g) => g.id === service.group)).toBe(true)
    }
  })

  it('gives each listed feed a row of its own, and leaves every other row alone', () => {
    const feeds = [
      {
        label: 'Cats',
        host: 'cats.example.test',
        uri: 'at://did:plc:cats/app.bsky.feed.generator/cats'
      },
      {
        label: 'Dogs',
        host: 'dogs.example.test',
        uri: 'at://did:plc:dogs/app.bsky.feed.generator/dogs'
      }
    ]
    const services = servicesFor({ ...structuredClone(DEFAULT_PROBE_TARGETS), feeds })
    expect(services.filter((s) => s.kind === 'feed').map((s) => [s.id, s.label])).toEqual([
      ['feed:cats.example.test', 'Cats'],
      ['feed:dogs.example.test', 'Dogs']
    ])
    expect(services.filter((s) => s.kind !== 'feed')).toEqual(
      SERVICES.filter((s) => s.kind !== 'feed')
    )
    // No feeds is no feed rows, and nothing else missing.
    const none = servicesFor({ ...structuredClone(DEFAULT_PROBE_TARGETS), feeds: [] })
    expect(none).toHaveLength(SERVICES.length - DEFAULT_PROBE_TARGETS.feeds.length)
  })

  it('measures the checked-in targets unless told otherwise', () => {
    expect(SERVICES).toEqual(servicesFor(DEFAULT_PROBE_TARGETS))
  })

  it('treats only the Internet group as the control', () => {
    expect(SERVICES.filter(isControl).map((s) => s.kind)).toEqual(
      Array.from({ length: 4 }, () => 'internet')
    )
  })
})

describe('probeState', () => {
  const pass = makeCheck({ ok: true, durationMs: 100 })
  const fail = makeCheck({ ok: false, error: 'HTTP 500' })
  const wait = makeCheck({ ok: null, durationMs: null })

  it.each<[string, ReturnType<typeof makeCheck>[], ProbeState]>([
    ['nothing started', [], 'pending'],
    ['everything in flight', [wait, wait], 'pending'],
    ['everything passing', [pass, pass], 'live'],
    ['a pass that took the slow threshold', [pass, makeCheck({ durationMs: SLOW_MS })], 'slow'],
    ['every check failing', [fail, fail], 'down'],
    ['a failure beside a pass', [pass, fail], 'partial'],
    ['a failure beside one still in flight', [fail, wait], 'partial'],
    ['passes with one still in flight', [pass, wait], 'pending']
  ])('%s', (_name, checks, expected) => {
    expect(probeState(checks)).toBe(expected)
  })

  it('does not call a slow failure slow', () => {
    expect(probeState([makeCheck({ ok: false, durationMs: 40_000 }), makeCheck()])).toBe('partial')
  })

  it('counts a pass with no duration as quick', () => {
    expect(probeState([makeCheck({ durationMs: null })])).toBe('live')
  })
})

describe('isReachable', () => {
  it.each<[ProbeState, boolean]>([
    ['live', true],
    ['slow', true],
    ['partial', false],
    ['down', false],
    ['pending', false]
  ])('%s', (state, expected) => {
    expect(isReachable(state)).toBe(expected)
  })
})

describe('medianLatency', () => {
  it('is null with nothing timed', () => {
    expect(medianLatency([])).toBeNull()
  })

  it('takes the middle of an odd count', () => {
    expect(medianLatency([30, 10, 20].map((durationMs) => makeCheck({ durationMs })))).toBe(20)
  })

  it('averages the middle two of an even count', () => {
    expect(medianLatency([10, 20, 31, 40].map((durationMs) => makeCheck({ durationMs })))).toBe(26)
  })

  it('counts only HTTP checks that passed', () => {
    expect(
      medianLatency([
        makeCheck({ durationMs: 100 }),
        makeCheck({ kind: 'stream', durationMs: 5000 }),
        makeCheck({ kind: 'derived', durationMs: null }),
        makeCheck({ ok: false, durationMs: 30_000 }),
        makeCheck({ ok: null, durationMs: null }),
        makeCheck({ durationMs: null })
      ])
    ).toBe(100)
  })
})

describe('observedCondition', () => {
  it.each([
    ['live', 'up'],
    ['slow', 'up'],
    ['partial', 'partial'],
    ['down', 'down'],
    ['pending', null]
  ] as const)('%s reads as %s', (state, condition) => {
    expect(observedCondition(state)).toBe(condition)
  })
})

describe('isOffline', () => {
  it('is offline when every control check failed', () => {
    expect(isOffline([control('down'), control('down'), { group: 'relays', state: 'live' }])).toBe(
      true
    )
  })

  it('is online while any control check answers', () => {
    expect(isOffline([control('down'), control('live')])).toBe(false)
    expect(isOffline([control('down'), control('partial')])).toBe(false)
  })

  it('never claims offline without a control group to judge by', () => {
    expect(isOffline([{ group: 'relays', state: 'down' }])).toBe(false)
  })
})

describe('summarizeNetwork', () => {
  const up = makeService({ id: 'relay:bsky.network', label: 'bsky.network' })
  const down = makeService({
    id: 'relay:europe.firehose.network',
    label: 'europe.firehose.network',
    state: 'down',
    condition: 'down'
  })
  const partial = makeService({
    id: 'pds:eurosky.social',
    label: 'eurosky.social',
    state: 'partial',
    condition: 'partial'
  })
  const github = makeService({ id: 'internet:github', group: 'internet', state: 'down' })

  it('is off when checks are switched off, whatever was measured', () => {
    expect(summarizeNetwork(makeSnapshot({ services: [down] }), false).health).toBe('off')
  })

  it('is offline when the sweep said so', () => {
    expect(summarizeNetwork(makeSnapshot({ offline: true, services: [down] }), true).health).toBe(
      'offline'
    )
  })

  it('names what is down and what is degraded', () => {
    const summary = summarizeNetwork(
      makeSnapshot({ services: [up, down, partial, github], finishedAt: '2026-01-01T00:00:00Z' }),
      true
    )
    expect(summary).toEqual({
      health: 'down',
      total: 3,
      reachable: 1,
      down: ['europe.firehose.network'],
      degraded: ['eurosky.social'],
      community: [],
      running: false,
      lastSweepAt: '2026-01-01T00:00:00Z',
      restraint: null
    })
  })

  it('keeps community infrastructure out of the health rollup', () => {
    const hobby = makeService({
      id: 'pds:pds.rip',
      label: 'pds.rip',
      state: 'down',
      condition: 'down'
    })
    const summary = summarizeNetwork(makeSnapshot({ services: [up, hobby] }), true)
    // Measured, listed and filed in the feed — but it never reaches the tray.
    expect(summary).toMatchObject({
      health: 'operational',
      total: 2,
      reachable: 1,
      down: [],
      community: ['pds.rip']
    })
  })

  it('is degraded with only partial failures', () => {
    expect(summarizeNetwork(makeSnapshot({ services: [up, partial] }), true).health).toBe(
      'degraded'
    )
  })

  it('is operational once anything is known to be up', () => {
    expect(summarizeNetwork(makeSnapshot({ services: [up] }), true).health).toBe('operational')
  })

  it('is unknown before anything is judged', () => {
    const blank = blankService(relay)
    expect(
      summarizeNetwork(makeSnapshot({ services: [blank], running: true }), true)
    ).toMatchObject({ health: 'unknown', running: true, reachable: 0, total: 1 })
  })

  it('leaves the control group out of every count', () => {
    expect(summarizeNetwork(makeSnapshot({ services: [github] }), true)).toMatchObject({
      health: 'unknown',
      total: 0,
      down: []
    })
  })
})

describe('networkAsHealth', () => {
  it.each([
    ['down', 'incident'],
    ['degraded', 'degraded'],
    ['operational', 'operational'],
    ['offline', 'offline'],
    ['unknown', null],
    ['off', null]
  ] as const)('%s → %s', (health, expected) => {
    expect(networkAsHealth(health)).toBe(expected)
  })
})

describe('headline', () => {
  const quiet = makeNetworkSummary({ health: 'operational', total: 26, reachable: 26 })
  const NOW_ISO = '2026-01-02T12:00:00.000Z'

  it('keeps the accounts’ wording when nothing is measured', () => {
    expect(headline('monitoring', null)).toEqual({
      health: 'monitoring',
      label: HEALTH_LABEL.monitoring,
      attribution: null
    })
    expect(headline('incident', makeNetworkSummary({ health: 'off' }))).toEqual({
      health: 'incident',
      label: HEALTH_LABEL.incident,
      attribution: null
    })
  })

  it('agrees with the accounts when both say all is well', () => {
    expect(headline('operational', quiet)).toEqual({
      health: 'operational',
      label: HEALTH_LABEL.operational,
      attribution: null
    })
  })

  it('lets a clean measurement stand in for accounts that have not posted', () => {
    expect(headline('unknown', quiet)).toEqual({
      health: 'operational',
      label: HEALTH_LABEL.operational,
      attribution: null
    })
  })

  it('names the one service the checks found down', () => {
    const network = makeNetworkSummary({ health: 'down', down: ['europe.firehose.network'] })
    expect(headline('operational', network)).toEqual({
      health: 'incident',
      label: 'europe.firehose.network is unreachable',
      attribution: null
    })
  })

  it('counts several services down', () => {
    const network = makeNetworkSummary({ health: 'down', down: ['a', 'b'], degraded: ['c'] })
    expect(headline('monitoring', network).label).toBe('2 services unreachable')
  })

  it('names one degraded service, and counts several', () => {
    expect(
      headline('operational', makeNetworkSummary({ health: 'degraded', degraded: ['a.test'] }))
    ).toEqual({ health: 'degraded', label: 'a.test is degraded', attribution: null })
    expect(
      headline('maintenance', makeNetworkSummary({ health: 'degraded', degraded: ['a', 'b'] }))
        .label
    ).toBe('2 services degraded')
  })

  it('keeps an operator’s incident over a measured one', () => {
    const network = makeNetworkSummary({ health: 'down', down: ['europe.firehose.network'] })
    expect(headline('incident', network)).toEqual({
      health: 'incident',
      label: HEALTH_LABEL.incident,
      attribution: null
    })
  })

  it('lets a worse report from the accounts win over a milder measurement', () => {
    const network = makeNetworkSummary({ health: 'degraded', degraded: ['a'] })
    expect(headline('incident', network).label).toBe(HEALTH_LABEL.incident)
  })

  it('says offline above everything else', () => {
    expect(headline('incident', makeNetworkSummary({ health: 'offline' }))).toEqual({
      health: 'offline',
      label: HEALTH_LABEL.offline,
      attribution: null
    })
  })

  it('drops the attribution when the measurement is what made it worse', () => {
    const network = makeNetworkSummary({ health: 'down', down: ['a.test'] })
    const said = {
      name: 'Somebody',
      health: 'operational' as const,
      at: NOW_ISO,
      others: 0,
      stale: false
    }
    expect(headline('operational', network, said).attribution).toBeNull()
    expect(
      headline('incident', makeNetworkSummary({ health: 'offline' }), said).attribution
    ).toBeNull()
  })

  it('will not say “no data yet” over a claim it has only just withdrawn', () => {
    const withdrawn = {
      name: 'Blacksky Status',
      health: 'maintenance' as const,
      at: NOW_ISO,
      others: 0,
      stale: true
    }
    expect(headline('unknown', null, withdrawn).label).toBe('Nothing reported recently')
    expect(headline('unknown', null, null).label).toBe(HEALTH_LABEL.unknown)
  })
})

describe('reportHeadline', () => {
  const NOW = Date.parse('2026-01-02T12:00:00.000Z')
  const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString()
  const quiet = makeNetworkSummary({ health: 'operational', total: 26, reachable: 26 })

  const bsky = makeAccount({ did: 'did:plc:bsky', displayName: 'Bluesky Status' })
  const black = makeAccount({ did: 'did:plc:black', displayName: 'Blacksky Status' })

  it('names the source a current claim came from, and when', () => {
    const line = reportHeadline(
      [bsky],
      [makePost({ authorDid: bsky.did, severity: 'outage', createdAt: hoursAgo(3) })],
      quiet,
      NOW
    )
    expect(line).toEqual({
      health: 'incident',
      label: HEALTH_LABEL.incident,
      attribution: {
        name: 'Bluesky Status',
        health: 'incident',
        at: hoursAgo(3),
        others: 0,
        stale: false
      }
    })
  })

  it('stops a claim setting the verdict once its author has gone quiet', () => {
    const posts = [
      makePost({ authorDid: black.did, severity: 'maintenance', createdAt: hoursAgo(72) })
    ]
    expect(reportHeadline([black], posts, quiet, NOW)).toEqual({
      health: 'operational',
      label: HEALTH_LABEL.operational,
      attribution: {
        name: 'Blacksky Status',
        health: 'maintenance',
        at: hoursAgo(72),
        others: 0,
        stale: true
      }
    })
  })

  it('keeps a maintenance window for a day and an incident for half of one', () => {
    const maintenance = (hours: number): Health =>
      reportHeadline(
        [black],
        [makePost({ authorDid: black.did, severity: 'maintenance', createdAt: hoursAgo(hours) })],
        quiet,
        NOW
      ).health
    const incident = (hours: number): Health =>
      reportHeadline(
        [bsky],
        [makePost({ authorDid: bsky.did, severity: 'outage', createdAt: hoursAgo(hours) })],
        quiet,
        NOW
      ).health

    expect(maintenance(23)).toBe('maintenance')
    expect(maintenance(25)).toBe('operational')
    expect(incident(11)).toBe('incident')
    expect(incident(13)).toBe('operational')
  })

  it('never lets a resolved post go stale', () => {
    const line = reportHeadline(
      [bsky],
      [makePost({ authorDid: bsky.did, severity: 'resolved', createdAt: hoursAgo(5000) })],
      quiet,
      NOW
    )
    expect(line.health).toBe('operational')
    expect(line.attribution).toBeNull()
  })

  it('lets a source that is still speaking outrank one that has gone quiet', () => {
    const line = reportHeadline(
      [bsky, black],
      [
        makePost({ authorDid: bsky.did, severity: 'outage', createdAt: hoursAgo(1) }),
        makePost({ authorDid: black.did, severity: 'maintenance', createdAt: hoursAgo(72) })
      ],
      quiet,
      NOW
    )
    expect(line.health).toBe('incident')
    expect(line.attribution?.name).toBe('Bluesky Status')
    expect(line.attribution?.stale).toBe(false)
  })

  it('counts the others saying the same thing', () => {
    const line = reportHeadline(
      [bsky, black],
      [
        makePost({ authorDid: bsky.did, severity: 'outage', createdAt: hoursAgo(3) }),
        makePost({ authorDid: black.did, severity: 'outage', createdAt: hoursAgo(1) })
      ],
      quiet,
      NOW
    )
    // The newest of the two speaks for both, and the count says it is not alone.
    expect(line.attribution?.name).toBe('Blacksky Status')
    expect(line.attribution?.others).toBe(1)
  })

  it('names the newest claim, whichever order the sources are listed in', () => {
    const line = reportHeadline(
      [black, bsky],
      [
        makePost({ authorDid: black.did, severity: 'outage', createdAt: hoursAgo(1) }),
        makePost({ authorDid: bsky.did, severity: 'outage', createdAt: hoursAgo(3) })
      ],
      quiet,
      NOW
    )
    expect(line.attribution).toMatchObject({ name: 'Blacksky Status', others: 1 })
  })

  it('names a source with no display name by its handle', () => {
    const plain = makeAccount({ handle: 'status.example.test', displayName: '' })
    const line = reportHeadline(
      [plain],
      [makePost({ authorDid: plain.did, severity: 'outage', createdAt: hoursAgo(1) })],
      quiet,
      NOW
    )
    expect(line.attribution?.name).toBe('status.example.test')
  })

  /**
   * A post's `createdAt` is whatever the client that wrote it said. One that is not a
   * date still speaks — it is the source's latest word — but it cannot be dated, so it
   * is never the one named.
   */
  it('counts a claim it cannot date, and names somebody it can', () => {
    const line = reportHeadline(
      [bsky, black],
      [
        makePost({ authorDid: bsky.did, severity: 'outage', createdAt: 'the other day' }),
        makePost({ authorDid: black.did, severity: 'outage', createdAt: hoursAgo(2) })
      ],
      quiet,
      NOW
    )
    expect(line.health).toBe('incident')
    expect(line.attribution).toMatchObject({ name: 'Blacksky Status', at: hoursAgo(2) })

    const alone = reportHeadline(
      [bsky],
      [makePost({ authorDid: bsky.did, severity: 'outage', createdAt: 'the other day' })],
      quiet,
      NOW
    )
    expect(alone).toMatchObject({ health: 'incident', attribution: null })
  })

  it('counts only the withdrawn claims that agree with the one it names', () => {
    const line = reportHeadline(
      [bsky, black],
      [
        makePost({ authorDid: bsky.did, severity: 'outage', createdAt: hoursAgo(40) }),
        makePost({ authorDid: black.did, severity: 'maintenance', createdAt: hoursAgo(30) })
      ],
      quiet,
      NOW
    )
    // Both have gone quiet, but they were not saying the same thing, so neither speaks
    // for the other.
    expect(line.attribution).toEqual({
      name: 'Blacksky Status',
      health: 'maintenance',
      at: hoursAgo(30),
      others: 0,
      stale: true
    })
  })

  it('takes no notice of a muted source, however loudly it is claiming', () => {
    const line = reportHeadline(
      [{ ...black, muted: true }],
      [makePost({ authorDid: black.did, severity: 'outage', createdAt: hoursAgo(1) })],
      quiet,
      NOW
    )
    expect(line.health).toBe('operational')
    expect(line.attribution).toBeNull()
  })

  it('leaves the checks’ own entries to the live measurement', () => {
    const source = probeAccount('2026-01-01T00:00:00Z')
    const line = reportHeadline(
      [source],
      [makePost({ authorDid: PROBE_SOURCE_DID, severity: 'outage', createdAt: hoursAgo(1) })],
      quiet,
      NOW
    )
    expect(line.health).toBe('operational')
    expect(line.attribution).toBeNull()
  })

  it('says nothing was reported recently when the checks are off as well', () => {
    const line = reportHeadline(
      [black],
      [makePost({ authorDid: black.did, severity: 'maintenance', createdAt: hoursAgo(72) })],
      makeNetworkSummary({ health: 'off' }),
      NOW
    )
    expect(line.health).toBe('unknown')
    expect(line.label).toBe('Nothing reported recently')
    expect(line.attribution?.stale).toBe(true)
  })
})

describe('networkForHealth', () => {
  const network = makeNetworkSummary({ health: 'down', down: ['x'] })

  it('counts the checks until their source exists', () => {
    expect(networkForHealth([makeAccount()], network)).toBe(network)
  })

  it('counts them while their source is visible', () => {
    expect(networkForHealth([probeAccount('2026-01-01T00:00:00Z')], network)).toBe(network)
  })

  it('stops counting them once their source is hidden, like any muted account', () => {
    const muted = { ...probeAccount('2026-01-01T00:00:00Z'), muted: true }
    expect(networkForHealth([muted], network)).toBeNull()
  })
})

describe('the checks as a feed source', () => {
  it('is a built-in, pollless account', () => {
    expect(probeAccount('2026-01-01T00:00:00Z')).toEqual({
      did: PROBE_SOURCE_DID,
      handle: 'Network checks',
      displayName: 'Network checks',
      avatar: null,
      description: expect.any(String),
      notify: 'default',
      muted: false,
      addedAt: '2026-01-01T00:00:00Z',
      builtin: true,
      kind: 'probe'
    })
    expect(isProbeSource(PROBE_SOURCE_DID)).toBe(true)
    expect(isProbeSource('did:plc:someone')).toBe(false)
  })

  const failing = [
    makeCheck({ label: 'firehose', ok: false, error: 'No commits received' }),
    makeCheck({ label: '_health', ok: false, error: 'HTTP 502' }),
    makeCheck({ label: 'listHosts', ok: true })
  ]
  const event = (overrides: Partial<ProbeEvent>): ProbeEvent => ({
    service: relay,
    from: 'up',
    to: 'down',
    at: '2026-01-01T12:00:00.000Z',
    since: '2026-01-01T11:00:00.000Z',
    checks: failing,
    ...overrides
  })

  it('files an outage as an outage, naming what failed', () => {
    const post = probePost(event({}))
    expect(post).toMatchObject({
      uri: `probe:network/relay:europe.firehose.network/${Date.parse('2026-01-01T12:00:00.000Z')}`,
      authorDid: PROBE_SOURCE_DID,
      authorHandle: 'Network checks',
      severity: 'outage',
      createdAt: '2026-01-01T12:00:00.000Z',
      indexedAt: '2026-01-01T12:00:00.000Z',
      url: '',
      embed: null
    })
    expect(post.text).toBe(
      'europe.firehose.network is not responding from this computer. ' +
        'firehose: No commits received; _health: HTTP 502.'
    )
    expect(post.segments).toEqual([{ kind: 'text', text: post.text }])
  })

  it('files a partial failure as degraded, with a count', () => {
    const post = probePost(event({ to: 'partial' }))
    expect(post.severity).toBe('degraded')
    expect(post.text).toMatch(/^europe\.firehose\.network is partly failing: 2 of 3 checks\./)
  })

  it('names three failures at most', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      makeCheck({ label: `c${i}`, ok: false, error: null })
    )
    expect(probePost(event({ checks: many })).text).toContain(
      'c0: failed; c1: failed; c2: failed; 2 more.'
    )
  })

  it('files a recovery as resolved, saying how long it lasted', () => {
    const post = probePost(event({ from: 'down', to: 'up', checks: [] }))
    expect(post.severity).toBe('resolved')
    expect(post.text).toBe('europe.firehose.network is responding again after 1 hour.')
  })

  it('words a recovery from a partial failure differently', () => {
    expect(probePost(event({ from: 'partial', to: 'up', checks: [] })).text).toBe(
      'europe.firehose.network is passing every check again after 1 hour.'
    )
  })

  it('leaves the duration out when it is unknown', () => {
    expect(probePost(event({ from: 'down', to: 'up', since: null })).text).toBe(
      'europe.firehose.network is responding again.'
    )
    expect(
      probePost(event({ from: 'down', to: 'up', since: '2026-01-01T12:00:00.000Z' })).text
    ).toBe('europe.firehose.network is responding again.')
  })

  it('finds the service an entry is about', () => {
    expect(probeServiceId(probePost(event({})))).toBe('relay:europe.firehose.network')
  })

  it('finds no service behind anything else', () => {
    expect(
      probeServiceId({ uri: 'at://did:plc:x/app.bsky.feed.post/1', authorDid: 'did:plc:x' })
    ).toBeNull()
    expect(probeServiceId({ uri: 'somewhere/else/1', authorDid: PROBE_SOURCE_DID })).toBeNull()
    expect(probeServiceId({ uri: 'probe:network/1', authorDid: PROBE_SOURCE_DID })).toBeNull()
  })
})

describe('wording', () => {
  it.each([
    [0, '0 seconds'],
    [1_000, '1 second'],
    [59_999, '59 seconds'],
    [60_000, '1 minute'],
    [150_000, '2 minutes'],
    [3_600_000, '1 hour'],
    [7_300_000, '2 hours'],
    [86_400_000, '1 day'],
    [3 * 86_400_000, '3 days'],
    [-5_000, '0 seconds']
  ])('humanDuration(%i) is %s', (ms, expected) => {
    expect(humanDuration(ms)).toBe(expected)
  })

  it.each([
    [184.4, '184 ms'],
    [1_234, '1.2 s'],
    [31_000, '31 s']
  ])('formatLatency(%d) is %s', (ms, expected) => {
    expect(formatLatency(ms)).toBe(expected)
  })

  it('splits a hostname for typesetting', () => {
    expect(splitHost('amanita.us-east.host.bsky.network')).toEqual([
      'amanita',
      '.us-east.host.bsky.network'
    ])
    expect(splitHost('localhost')).toEqual(['localhost', ''])
  })
})

describe('checkDetail', () => {
  it.each([
    ['https://h/xrpc/com.atproto.identity.resolveHandle?handle=pfrazee.com', 'pfrazee.com'],
    ['https://h/xrpc/app.bsky.actor.getProfile?actor=did:plc:abc', 'did:plc:abc'],
    ['https://h/xrpc/com.atproto.repo.listRecords?repo=did:plc:r&limit=1', 'did:plc:r'],
    ['https://h/xrpc/blue.microcosm.links.getBacklinks?subject=did:plc:s', 'did:plc:s'],
    ['https://h/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://d/g/whats-hot', 'whats-hot'],
    ['https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:x/bafkcid', 'bafkcid']
  ])('picks out %s', (target, expected) => {
    expect(checkDetail({ target })).toBe(expected)
  })

  it('has nothing to add for a bare endpoint, a derived check or a bad URL', () => {
    expect(checkDetail({ target: 'https://h/xrpc/_health' })).toBeNull()
    expect(checkDetail({ target: null })).toBeNull()
    expect(checkDetail({ target: 'not a url' })).toBeNull()
  })
})

describe('describeFailure', () => {
  it.each([
    ['HTTP 429', '429', 'Rate limited'],
    ['HTTP 502', '502', 'Bad gateway'],
    ['HTTP 418', '418', 'Request refused'],
    ['HTTP 599', '599', 'Server error'],
    ['HTTP 302', '302', 'Redirected away'],
    ['HTTP 204', '204', 'Unexpected status']
  ])('sets %s as a code and a meaning', (error, code, text) => {
    expect(describeFailure(error)).toEqual({ code, text })
  })

  it('leaves a message that is already prose alone', () => {
    for (const error of ['Timed out after 10s', 'Image was empty', 'HTTP error', 'HTTP 5022']) {
      expect(describeFailure(error)).toEqual({ code: null, text: error })
    }
  })
})

describe('uptimePercent', () => {
  it('is null without history', () => {
    expect(uptimePercent([])).toBeNull()
  })

  it('counts slow answers as answers, to one decimal place', () => {
    expect(uptimePercent([sample('live'), sample('slow'), sample('down')])).toBe(66.7)
    expect(uptimePercent([sample('live')])).toBe(100)
  })
})

describe('blankService', () => {
  it('starts unmeasured and unjudged', () => {
    expect(blankService(relay)).toEqual({
      ...relay,
      state: 'pending',
      condition: 'unknown',
      since: null,
      checks: [],
      startedAt: null,
      checkedAt: null,
      latencyMs: null,
      history: [],
      rechecking: false
    })
  })
})
