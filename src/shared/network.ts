/**
 * Live network checks: the measured counterpart to the status feed.
 *
 * Status accounts report what their operators *say* is happening. This measures it,
 * the way Kuba Suder's status.feeds.blue does: it asks each relay, PDS, AppView and
 * piece of supporting infrastructure a handful of real questions from this machine and
 * judges the answers. The catalogue and the checks follow that page closely. Because the
 * requests leave from here, they test the user's own path to each service, which is why
 * a few well-known Internet endpoints ride along as a control group: when those fail as
 * well, the problem is this machine's connection and not the Atmosphere.
 *
 * Everything in this file is pure and shared by both processes. The requests themselves
 * are made in `src/main/probes.ts`; scheduling and debouncing live in
 * `src/main/network.ts`.
 */
import { HEALTH_LABEL, overallHealth, type Health } from './status'
import type {
  Account,
  NetworkHealth,
  NetworkSnapshot,
  NetworkSummary,
  ProbeCheck,
  ProbeCondition,
  ProbeGroup,
  ProbeKind,
  ProbeState,
  ProbeTier,
  ServiceProbe,
  Severity,
  StatusPost
} from './types'

// ------------------------------------------------------------------ catalogue

/**
 * What gets measured, and with what. This is status.feeds.blue's configuration, so the
 * two can be compared side by side.
 */
export const CATALOGUE = {
  relays: [
    'bsky.network',
    'relay1.us-east.bsky.network',
    'relay1.us-west.bsky.network',
    'europe.firehose.network',
    // microcosm.blue's relays. Stock `indigo`, so the same three checks fit unchanged.
    // relay2 is not on microcosm's homepage; it only appears in their updates feed.
    'relay3.fr.hose.cam',
    'relay.fire.hose.cam',
    'relay2.fire.hose.cam'
  ],
  /**
   * Jetstream carries the same commits as the firehose as plain JSON, with a top-level
   * `time_us`: no CAR or CBOR to decode, one integer to compare against the clock.
   * `jetstream1.us-east` is here specifically because UFOs consumes it, so its lag
   * explains UFOs' lag.
   */
  jetstreams: ['jetstream1.us-east.fire.hose.cam', 'jetstream2.fr.hose.cam'],
  appViews: [
    'api.bsky.app',
    'public.api.bsky.app',
    'api.blacksky.community',
    'api.eurosky.network'
  ],
  /**
   * Probed directly, every sweep. This is a hand-kept sample of a fleet that is 89 hosts
   * and growing: `fleet` below checks the whole set from one page instead. Keeping these
   * fixed means the dashboard shows the same rows sweep to sweep, which no automatic
   * ranking of the fleet could — every uptime strip would be measuring a different host.
   */
  pdses: [
    'eurosky.social',
    'blacksky.app',
    'amanita.us-east.host.bsky.network',
    'blewit.us-west.host.bsky.network',
    'boletus.us-west.host.bsky.network',
    'coral.us-east.host.bsky.network',
    'cordyceps.us-west.host.bsky.network',
    'elfcup.us-east.host.bsky.network',
    'hydnum.us-west.host.bsky.network',
    'jellybaby.us-east.host.bsky.network',
    'morel.us-east.host.bsky.network',
    'shiitake.us-east.host.bsky.network'
  ],
  /** Prolific posters: between them, somebody has always posted recently. */
  authorFeedDids: [
    'did:plc:ragtjsm2j2vknwkz3zp4oxrd',
    'did:plc:f4z2nftgrn75h7h3wucdyzaf',
    'did:plc:mrozf7u6e7kjpo7itbrudpc6',
    'did:plc:65r3dy2t6xfuwidxmzvctvsh'
  ],
  profileDids: ['did:plc:ragtjsm2j2vknwkz3zp4oxrd', 'did:plc:rnpkyqnmsw4ipey6eotbdnnf'],
  handles: ['pfrazee.com', 'bad-example.com', 'pds.dad'],
  feeds: [
    {
      label: 'Discover feed',
      host: 'discover.bsky.app',
      uri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot'
    }
  ],
  /**
   * The For You feed: the most liked custom feed on Bluesky, and two machines wearing
   * one hostname. The feed is a single Go binary on its author's PC at home, and a small
   * rented VPS faces the Internet in front of it — nginx there hands the skeleton route
   * to a proxy that validates the caller's JWT and forwards what is left over Tailscale.
   * The author documents the whole arrangement, and `probeForYou` is shaped around it:
   * https://atproto.com/blog/serving-the-for-you-feed
   *
   * Nothing here touches the playground or the also-liked page, the two routes that
   * would exercise the recommender itself rather than the machinery around it: both sit
   * behind a Turnstile challenge, and both are disallowed by the site's `robots.txt`.
   */
  forYou: {
    host: 'foryou.club',
    /** What the generator record points at, and what an AppView resolves before calling. */
    did: 'did:web:foryou.club',
    feed: 'at://did:plc:3guzzweuqraryl3rdkimjamk/app.bsky.feed.generator/for-you',
    /** A structural line of the site's `<head>`, rather than the copy around it. */
    siteMarker: '<link rel="canonical" href="https://foryou.club/">',
    /** What the site says, in plain text under a 503, when it is shedding load. */
    busy: 'server busy',
    /**
     * Where Bluesky's own verdict on the generator is read from. Whether the feed works
     * in the app is this AppView's opinion and nobody else's, so it is worth asking.
     */
    appView: 'public.api.bsky.app'
  },
  constellationHosts: ['constellation.microcosm.blue'],
  constellationBacklinks: [
    {
      subject: 'did:plc:z72i7hdynmk6r22z27h6tvur',
      source: 'app.bsky.graph.follow:subject',
      limit: 3
    }
  ],
  cdnHosts: ['cdn.bsky.app'],
  cdnImages: [
    {
      did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
      cid: 'bafkreiebtvblnu4jwu66y57kakido7uhiigenznxdlh6r6wiswblv5m4py'
    },
    {
      did: 'did:plc:z72i7hdynmk6r22z27h6tvur',
      cid: 'bafkreicnrpnkalwhwp2td7sxgpbxbt6ii3tjth2n5hdcdok5mxfro6np3u'
    },
    {
      did: 'did:plc:ragtjsm2j2vknwkz3zp4oxrd',
      cid: 'bafkreihydtvo6guxfd7sxp5lm3ainn2iib5lghudm4vb7kg36ri2pu3rrq'
    }
  ],
  /**
   * Community and sandbox PDSes. Real, federated, and explicitly best-effort — `pds.rip`
   * publishes "uptime: no guarantee, backups: none" — so they are graded at the
   * `community` tier and never reach the tray. See `ProbeTier`.
   */
  communityPdses: ['pds.rip', 'pds.pckt.cafe', 'npmx.social'],
  /** An identity that has not changed and will not, for exact-match checks. */
  anchor: { handle: 'bsky.app', did: 'did:plc:z72i7hdynmk6r22z27h6tvur' },
  /**
   * Who is asked about everybody else, and who answers `getHostStatus`.
   *
   * `listHosts` is the only authoritative host enumeration in the Atmosphere, and far
   * too much of it to walk: 6,312 hosts, 488 KB uncompressed. The fleet check reads one
   * page of it, which is all Bluesky's own fleet takes. See `probeFleet`.
   */
  directory: {
    relay: 'bsky.network',
    /** Hosts under this suffix are Bluesky's own fleet. */
    fleetSuffix: '.host.bsky.network',
    /**
     * Graded through the relay's eyes rather than probed: 72 bytes each for its own
     * `active`/`idle`/`offline`/`banned` verdict, with no third-party round trip.
     */
    watched: [
      'atproto.brid.gy',
      'pds.wsocial.network',
      'certified.one',
      'haruhwa.com',
      'tngl.sh',
      'keik.info',
      'bailey.protobase.at'
    ]
  },
  /** The microcosm.blue suite around Constellation. */
  microcosm: {
    ufos: 'ufos-api.microcosm.blue',
    slingshot: 'slingshot.microcosm.blue',
    spacedust: 'spacedust.microcosm.blue',
    /** A link source that fires many times a second: a narrow one reads as down. */
    spacedustSource: 'app.bsky.feed.like:subject.uri'
  },
  /**
   * Tangled: an AppView serving HTML only, a separate XRPC API (Bobbin) with its own
   * upstream (Hydrant), and the distributed git nodes — knots — and CI runners — spindles.
   * The infrastructure has not moved off `tangled.sh` even though the site has.
   */
  tangled: {
    appview: 'tangled.org',
    /** Static 92-byte string: routing only, no database behind it. */
    goGetPath: '/core?go-get=1',
    /** The full path: routing, database, identity resolution and render. */
    repoPath: '/tangled.org/core',
    /**
     * What the repository page titles itself. Only the name, not the whole title: the
     * separator after it is served as the entity `&middot;` rather than the character,
     * and a check has no business knowing which.
     */
    repoTitle: 'tangled.org/core',
    api: 'api.tangled.org',
    /** This project's own repo, as minted by its knot. */
    repoDid: 'did:plc:j5hmlfdrwkvtxm7cjmu7j2is',
    ownerDid: 'did:plc:wshs7t2adsemcrrd4snkeqli',
    knots: ['knot1.tangled.sh'],
    spindles: ['spindle.tangled.sh']
  },
  /** Publishing apps, which answer on `/up` rather than `/xrpc/_health`. */
  apps: {
    pckt: 'pckt.blog',
    leaflet: {
      host: 'leaflet.pub',
      /** A published document, whose well-known route is a 77-byte index read. */
      publication: { did: 'did:plc:btxrwcaeyodrap5mnjw2fvmz', rkey: '3lppk75kw7k26' },
      /** A busy publication, for its feed's `<updated>`. */
      feed: { did: 'did:plc:jbeaa5kdaladzwq3r7f5xgwe', rkey: '3gtfwwbnks225' },
      query: 'leaflet'
    },
    offprint: {
      host: 'offprint.app',
      publicationHost: 'news.offprint.app',
      publication: 'at://did:plc:pgjkomf37an4czloay5zeth6/site.standard.publication/3mcqqd47cw22j'
    }
  },
  internet: [
    {
      id: 'github',
      label: 'GitHub API',
      url: 'https://api.github.com/meta',
      validator: 'json-object'
    },
    {
      id: 'cloudflare',
      label: 'Cloudflare DNS',
      url: 'https://cloudflare-dns.com/dns-query?name=cloudflare.com&type=A',
      validator: 'dns-answer'
    },
    {
      id: 'google',
      label: 'Google DNS',
      url: 'https://dns.google/resolve?name=google.com&type=A',
      validator: 'dns-answer'
    },
    {
      id: 'aws',
      label: 'Amazon AWS',
      url: 'https://checkip.amazonaws.com',
      validator: 'plain-text'
    }
  ]
} as const

export type InternetCheck = (typeof CATALOGUE.internet)[number]

/** A measured service, before anything is known about it. */
export interface ServiceDefinition {
  id: string
  group: ProbeGroup
  kind: ProbeKind
  label: string
  host: string
  tier: ProbeTier
}

interface DefineOptions {
  label?: string
  tier?: ProbeTier
}

function define(
  kind: ProbeKind,
  group: ProbeGroup,
  host: string,
  { label = host, tier = 'core' }: DefineOptions = {}
): ServiceDefinition {
  return { id: `${kind}:${host}`, group, kind, label, host, tier }
}

/** Every service the catalogue names, in dashboard order. Discovery adds to this. */
export const SERVICES: readonly ServiceDefinition[] = [
  ...CATALOGUE.relays.map((host) => define('relay', 'relays', host)),
  ...CATALOGUE.jetstreams.map((host) => define('jetstream', 'streams', host)),
  define('spacedust', 'streams', CATALOGUE.microcosm.spacedust),
  ...CATALOGUE.appViews.map((host) => define('appview', 'appviews', host)),
  ...CATALOGUE.pdses.map((host) => define('pds', 'pdses', host)),
  define('fleet', 'pdses', CATALOGUE.directory.relay, { label: 'Host directory' }),
  ...CATALOGUE.communityPdses.map((host) => define('pds', 'pdses', host, { tier: 'community' })),
  define('tangled-appview', 'tangled', CATALOGUE.tangled.appview),
  define('bobbin', 'tangled', CATALOGUE.tangled.api, { label: 'Bobbin (Tangled API)' }),
  define('hydrant', 'tangled', CATALOGUE.tangled.api, { label: 'Hydrant (Bobbin upstream)' }),
  ...CATALOGUE.tangled.knots.map((host) => define('knot', 'tangled', host)),
  ...CATALOGUE.tangled.spindles.map((host) => define('spindle', 'tangled', host)),
  define('pckt', 'apps', CATALOGUE.apps.pckt),
  define('leaflet', 'apps', CATALOGUE.apps.leaflet.host),
  define('offprint', 'apps', CATALOGUE.apps.offprint.host),
  ...CATALOGUE.feeds.map((feed) =>
    define('feed', 'infrastructure', feed.host, { label: feed.label })
  ),
  define('foryou', 'infrastructure', CATALOGUE.forYou.host, { label: 'For You feed' }),
  ...CATALOGUE.constellationHosts.map((host) => define('constellation', 'infrastructure', host)),
  define('ufos', 'infrastructure', CATALOGUE.microcosm.ufos),
  define('slingshot', 'infrastructure', CATALOGUE.microcosm.slingshot),
  ...CATALOGUE.cdnHosts.map((host) => define('cdn', 'infrastructure', host)),
  ...CATALOGUE.internet.map((check) => ({
    id: `internet:${check.id}`,
    group: 'internet' as const,
    kind: 'internet' as const,
    label: check.label,
    host: new URL(check.url).hostname,
    tier: 'core' as const
  }))
]

export const PROBE_GROUPS: readonly { id: ProbeGroup; title: string; blurb: string }[] = [
  { id: 'relays', title: 'Relays', blurb: 'Carry every repository commit on the firehose' },
  { id: 'streams', title: 'Streams', blurb: 'The firehose as JSON, and the links built from it' },
  { id: 'appviews', title: 'AppViews', blurb: 'Serve the profiles, feeds and threads apps read' },
  { id: 'pdses', title: 'PDSes', blurb: 'Host accounts and the records they write' },
  { id: 'tangled', title: 'Tangled', blurb: 'Git collaboration: appview, API, knots and spindles' },
  { id: 'apps', title: 'Apps', blurb: 'Publishing apps and the indexes behind them' },
  {
    id: 'infrastructure',
    title: 'Other infrastructure',
    blurb: 'Feeds, backlinks, identity and media'
  },
  {
    id: 'internet',
    title: 'Internet',
    blurb: 'Control checks: if these fail too, the problem is your connection'
  }
]

// ------------------------------------------------------------------ timings

/** A check that takes this long still passes, but the service reads as slow. */
export const SLOW_MS = 15_000
/** Every request gives up after this long. */
export const REQUEST_TIMEOUT_MS = 30_000
/** How long to wait on the firehose for a fresh commit. */
export const FIREHOSE_WINDOW_MS = 15_000
/** A commit stamped within this long ago proves the relay is live. */
export const FIREHOSE_FRESH_MS = 60_000
/** How far an AppView's newest post may trail its freshest peer's. */
export const INDEX_LAG_MS = 15 * 60_000
/**
 * How far a service's own consumer cursor may trail the clock before it counts as
 * stalled. UFOs runs a tenth of a second behind and pckt under a second, so this is
 * generous by two orders of magnitude on purpose: it has to survive a quiet minute, a
 * clock a little out of step with the server's — one sample read as 0.1s *ahead* — and
 * a sweep that only looks every ten minutes.
 */
export const CURSOR_LAG_MS = 5 * 60_000
/**
 * How long a check that is too expensive for every sweep waits between runs. Offprint's
 * platform feed is the case: it is the most direct staleness signal found anywhere, and
 * it is 61 KB gzipped with no working limit parameter, so it runs hourly instead.
 */
export const SLOW_CHECK_EVERY_MS = 60 * 60_000
/**
 * Posts per `getAuthorFeed`. status.feeds.blue asks for 100, which is half a megabyte a
 * request — fine once in a browser tab, not every few minutes from a menu bar. The newest
 * post is always near the top, so a handful finds it just as well.
 */
export const AUTHOR_FEED_LIMIT = 5
/** Observations kept per service for its uptime strip. */
export const HISTORY_LENGTH = 40

// ------------------------------------------------------------------ judging

/** The control group, which judges this machine's connection rather than the Atmosphere. */
export function isControl(service: { group: ProbeGroup }): boolean {
  return service.group === 'internet'
}

/**
 * Whether a service's verdict is allowed to set the header and the tray. Community
 * infrastructure is measured and filed like anything else but kept out of the rollup:
 * see `ProbeTier`.
 */
export function isCore(service: { group: ProbeGroup; tier: ProbeTier }): boolean {
  return !isControl(service) && service.tier === 'core'
}

/**
 * Roll a service's checks up into one state, the way status.feeds.blue does: every
 * check passing is `live` (or `slow`, when one took 15 seconds or more), every check
 * failing is `down`, and anything failing alongside a pass — or alongside a check still
 * in flight — is `partial`.
 */
export function probeState(checks: ProbeCheck[]): ProbeState {
  if (!checks.length) return 'pending'
  let passed = 0
  let failed = 0
  let slow = false
  for (const check of checks) {
    if (check.ok === true) {
      passed++
      if ((check.durationMs ?? 0) >= SLOW_MS) slow = true
    } else if (check.ok === false) {
      failed++
    }
  }
  if (passed === checks.length) return slow ? 'slow' : 'live'
  if (failed === checks.length) return 'down'
  if (failed > 0) return 'partial'
  return 'pending'
}

/** Whether a state counts as the service answering. */
export function isReachable(state: ProbeState): boolean {
  return state === 'live' || state === 'slow'
}

/** Median round trip of the HTTP checks that passed, in whole milliseconds. */
export function medianLatency(checks: ProbeCheck[]): number | null {
  const times = checks
    .filter((check) => check.kind === 'http' && check.ok === true && check.durationMs !== null)
    .map((check) => check.durationMs!)
    .toSorted((a, b) => a - b)
  if (!times.length) return null
  const middle = times.length >> 1
  const median = times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2
  return Math.round(median)
}

/** What a finished observation says about the service, for the debounced condition. */
export function observedCondition(state: ProbeState): Exclude<ProbeCondition, 'unknown'> | null {
  switch (state) {
    case 'live':
    case 'slow':
      return 'up'
    case 'partial':
      return 'partial'
    case 'down':
      return 'down'
    default:
      return null
  }
}

/**
 * The machine is offline when every control check failed. With nothing reachable, a
 * failing relay says nothing about the relay, so a sweep like that changes no service's
 * condition and files nothing in the feed.
 */
export function isOffline(services: { group: ProbeGroup; state: ProbeState }[]): boolean {
  const controls = services.filter(isControl)
  return controls.length > 0 && controls.every((service) => service.state === 'down')
}

/** Roll the dashboard up into the few facts the header, tray and tooltip show. */
export function summarizeNetwork(snapshot: NetworkSnapshot, enabled: boolean): NetworkSummary {
  const atmosphere = snapshot.services.filter((service) => !isControl(service))
  const core = atmosphere.filter(isCore)
  const down = core.filter((s) => s.condition === 'down').map((s) => s.label)
  const degraded = core.filter((s) => s.condition === 'partial').map((s) => s.label)
  const community = atmosphere
    .filter((s) => !isCore(s) && (s.condition === 'down' || s.condition === 'partial'))
    .map((s) => s.label)

  let health: NetworkHealth
  if (!enabled) health = 'off'
  else if (snapshot.offline) health = 'offline'
  else if (down.length) health = 'down'
  else if (degraded.length) health = 'degraded'
  // A community service answering still proves the checks are working, so it counts
  // towards `operational` even though its failures never count against it.
  else if (atmosphere.some((s) => s.condition === 'up')) health = 'operational'
  else health = 'unknown'

  return {
    health,
    total: atmosphere.length,
    reachable: atmosphere.filter((s) => isReachable(s.state)).length,
    down,
    degraded,
    community,
    running: snapshot.running,
    lastSweepAt: snapshot.finishedAt
  }
}

// ------------------------------------------------------------------ health

/** Where network health sits on the scale posts use, or null when it has nothing to say. */
export function networkAsHealth(health: NetworkHealth): Health | null {
  switch (health) {
    case 'down':
      return 'incident'
    case 'degraded':
      return 'degraded'
    case 'operational':
      return 'operational'
    case 'offline':
      return 'offline'
    default:
      return null
  }
}

export interface Headline {
  health: Health
  label: string
}

/**
 * The one line at the top of the popover and the tray tooltip.
 *
 * The worse of what the status accounts say and what the checks measured wins. When
 * they agree, the accounts' wording is kept — an operator's "Active incident" is more
 * authoritative than a probe's. Being offline trumps both: with nothing reachable, the
 * cached posts are stale and every check is meaningless.
 */
export function headline(posts: Health, network: NetworkSummary | null): Headline {
  const measured = network ? networkAsHealth(network.health) : null
  if (measured === 'offline') return { health: 'offline', label: HEALTH_LABEL.offline }

  const health = measured ? overallHealth([posts, measured]) : posts
  // Only name services when the measurement is what made the headline worse.
  const measuredWorse = network !== null && health === measured && health !== posts

  if (measuredWorse && network.down.length) {
    return {
      health,
      label:
        network.down.length === 1
          ? `${network.down[0]} is unreachable`
          : `${network.down.length} services unreachable`
    }
  }
  if (measuredWorse && network.degraded.length) {
    return {
      health,
      label:
        network.degraded.length === 1
          ? `${network.degraded[0]} is degraded`
          : `${network.degraded.length} services degraded`
    }
  }
  return { health, label: HEALTH_LABEL[health] }
}

/**
 * The network summary as the health rollup should see it: not at all when the user has
 * hidden the checks' source, exactly as a muted account stops counting.
 */
export function networkForHealth(
  accounts: Account[],
  network: NetworkSummary
): NetworkSummary | null {
  const source = accounts.find((account) => account.did === PROBE_SOURCE_DID)
  return source?.muted ? null : network
}

// ------------------------------------------------------------------ the feed source

/** The synthetic `Account.did` the checks' feed entries are filed under. */
export const PROBE_SOURCE_DID = 'probe:network'
export const PROBE_SOURCE_NAME = 'Network checks'
const PROBE_URI_PREFIX = `${PROBE_SOURCE_DID}/`

export function isProbeSource(did: string): boolean {
  return did === PROBE_SOURCE_DID
}

/**
 * The source the checks register as the first time they have something to report.
 *
 * Like a pushed status page, it is an ordinary `Account`, so notification toggles,
 * muting, unread counts and the feed's filter chips all work unchanged. It is marked
 * built in because removing it would only bring it back at the next outage.
 */
export function probeAccount(addedAt: string): Account {
  return {
    did: PROBE_SOURCE_DID,
    handle: PROBE_SOURCE_NAME,
    displayName: PROBE_SOURCE_NAME,
    avatar: null,
    description: 'Outages and recoveries measured from this computer.',
    notify: true,
    muted: false,
    addedAt,
    builtin: true,
    kind: 'probe'
  }
}

/** A confirmed change in a service's condition: the thing worth a feed entry. */
export interface ProbeEvent {
  service: ServiceDefinition
  from: ProbeCondition
  to: Exclude<ProbeCondition, 'unknown'>
  at: string
  /** When the previous condition began, so a recovery can say how long it lasted. */
  since: string | null
  checks: ProbeCheck[]
}

const EVENT_SEVERITY: Record<ProbeEvent['to'], Severity> = {
  down: 'outage',
  partial: 'degraded',
  up: 'resolved'
}

/** Failures worth naming in an entry, at most three of them. */
function failureSummary(checks: ProbeCheck[]): string {
  const failed = checks.filter((check) => check.ok === false)
  const named = failed.slice(0, 3).map((check) => `${check.label}: ${check.error ?? 'failed'}`)
  if (failed.length > named.length) named.push(`${failed.length - named.length} more`)
  return named.join('; ')
}

function eventText(event: ProbeEvent): string {
  const { service, checks } = event
  switch (event.to) {
    case 'down':
      return `${service.label} is not responding from this computer. ${failureSummary(checks)}.`
    case 'partial': {
      const failed = checks.filter((check) => check.ok === false).length
      return (
        `${service.label} is partly failing: ${failed} of ${checks.length} checks. ` +
        `${failureSummary(checks)}.`
      )
    }
    default: {
      const lasted = event.since ? Date.parse(event.at) - Date.parse(event.since) : Number.NaN
      const after = Number.isFinite(lasted) && lasted > 0 ? ` after ${humanDuration(lasted)}` : ''
      return event.from === 'down'
        ? `${service.label} is responding again${after}.`
        : `${service.label} is passing every check again${after}.`
    }
  }
}

/** One feed entry for one confirmed change, shaped like any other status post. */
export function probePost(event: ProbeEvent): StatusPost {
  const epoch = Date.parse(event.at)
  const uri = `${PROBE_URI_PREFIX}${event.service.id}/${epoch}`
  const text = eventText(event)
  return {
    uri,
    cid: '',
    rkey: String(epoch),
    authorDid: PROBE_SOURCE_DID,
    authorHandle: PROBE_SOURCE_NAME,
    authorDisplayName: PROBE_SOURCE_NAME,
    authorAvatar: null,
    text,
    segments: [{ kind: 'text', text }],
    embed: null,
    createdAt: event.at,
    indexedAt: event.at,
    severity: EVENT_SEVERITY[event.to],
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    // Nothing on the web to open: the entry links back into the dashboard instead.
    url: ''
  }
}

/** The service a checks entry is about, or null for anything else. */
export function probeServiceId(post: Pick<StatusPost, 'uri' | 'authorDid'>): string | null {
  if (!isProbeSource(post.authorDid) || !post.uri.startsWith(PROBE_URI_PREFIX)) return null
  const rest = post.uri.slice(PROBE_URI_PREFIX.length)
  const slash = rest.lastIndexOf('/')
  return slash > 0 ? rest.slice(0, slash) : null
}

// ------------------------------------------------------------------ wording

/** "45 seconds", "12 minutes", "3 hours", "2 days" — status.feeds.blue's own phrasing. */
export function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  let amount: number
  let unit: string
  if (seconds < 60) [amount, unit] = [seconds, 'second']
  else if (seconds < 3600) [amount, unit] = [Math.floor(seconds / 60), 'minute']
  else if (seconds < 86_400) [amount, unit] = [Math.floor(seconds / 3600), 'hour']
  else [amount, unit] = [Math.floor(seconds / 86_400), 'day']
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`
}

/**
 * "184 ms", "1.2 s", "31 s" — with a narrow no-break space, so the unit never ends up
 * alone on the next line.
 */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}\u202Fms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}\u202Fs`
  return `${Math.round(ms / 1000)}\u202Fs`
}

/**
 * A hostname split for typesetting: the distinctive first label, then the rest.
 * `amanita.us-east.host.bsky.network` reads as **amanita**.us-east.host.bsky.network.
 */
export function splitHost(host: string): [head: string, tail: string] {
  const dot = host.indexOf('.')
  return dot > 0 ? [host.slice(0, dot), host.slice(dot)] : [host, '']
}

/**
 * The plain-English half of an HTTP status, for the ones these checks actually meet.
 * Anything unlisted falls back to what its family means.
 */
const HTTP_MEANING: Record<number, string> = {
  400: 'Bad request',
  401: 'Not authorised',
  403: 'Refused',
  404: 'Not found',
  408: 'Request timed out',
  410: 'Gone',
  429: 'Rate limited',
  500: 'Server error',
  501: 'Not implemented',
  502: 'Bad gateway',
  503: 'Unavailable',
  504: 'Gateway timed out',
  521: 'Origin refused the connection',
  522: 'Origin did not answer',
  523: 'Origin unreachable',
  524: 'Origin timed out'
}

/**
 * A failure split into the two things it says: a short code, if it has one, and what
 * that code or message means in words. `HTTP 429` becomes `429` · `Rate limited`, so the
 * dashboard can set the code in figures and leave the sentence readable. Messages that
 * are already prose come back whole, with no code.
 */
export function describeFailure(error: string): { code: string | null; text: string } {
  const http = /^HTTP (\d{3})$/.exec(error)
  if (!http) return { code: null, text: error }
  const status = Number(http[1])
  const meaning =
    HTTP_MEANING[status] ??
    (status >= 500
      ? 'Server error'
      : status >= 400
        ? 'Request refused'
        : status >= 300
          ? 'Redirected away'
          : 'Unexpected status')
  return { code: String(status), text: meaning }
}

/**
 * The part of a check's request that tells it apart from its siblings — which actor,
 * which handle, which image — for the dashboard's request list.
 */
export function checkDetail(check: Pick<ProbeCheck, 'target'>): string | null {
  if (!check.target) return null
  let url: URL
  try {
    url = new URL(check.target)
  } catch {
    return null
  }
  const params = url.searchParams
  const named =
    params.get('handle') ?? params.get('actor') ?? params.get('repo') ?? params.get('subject')
  if (named) return named
  const feed = params.get('feed')
  if (feed) return feed.slice(feed.lastIndexOf('/') + 1)
  if (url.pathname.startsWith('/img/')) return url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
  return null
}

/** Share of a service's recent observations that found it answering, 0–100. */
export function uptimePercent(history: { state: ProbeState }[]): number | null {
  if (!history.length) return null
  const up = history.filter((sample) => isReachable(sample.state)).length
  return Math.round((up / history.length) * 1000) / 10
}

/** A service that has not been measured yet. */
export function blankService(definition: ServiceDefinition): ServiceProbe {
  return {
    ...definition,
    state: 'pending',
    condition: 'unknown',
    since: null,
    checks: [],
    startedAt: null,
    checkedAt: null,
    latencyMs: null,
    history: [],
    rechecking: false
  }
}
