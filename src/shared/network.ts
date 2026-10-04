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
import { DEFAULT_PROBE_TARGETS } from './probe-targets'
import { HEALTH_LABEL, deriveClaim, overallHealth, type Claim, type Health } from './status'
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
  ProbeTargets,
  ProbeTier,
  ServiceProbe,
  Severity,
  StatusPost
} from './types'

// ------------------------------------------------------------------ catalogue

/**
 * What gets measured, and with what. This is status.feeds.blue's configuration, so the
 * two can be compared side by side.
 *
 * These are the services themselves, which do not change under anybody's feet. What each
 * one is *asked about* — which accounts, feeds, images, repositories and documents — is
 * other people's content, and lives in `probeTargets.json` where a user can replace it;
 * see src/shared/probe-targets.ts. The exact words the answers are held to live in
 * `expectedResponses.json`; see src/shared/expected-responses.ts.
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
    'relay2.fire.hose.cam',
    // W Social's relay, also stock `indigo`. It carries the whole network, but not by
    // crawling it: its host list is W Social's own PDS and `bsky.network`, so everything
    // else reaches it through Bluesky's relay, and an outage there is an outage here too.
    'relay.wsocial.eu'
  ],
  /**
   * The relay each PDS is asked about with `com.atproto.sync.getHostStatus`: whether it
   * is still subscribed to that host, and so whether that PDS's commits reach the rest
   * of the network. Bluesky's own, as the relay a PDS can least afford to be dropped by.
   */
  hostStatusRelay: 'bsky.network',
  /**
   * Jetstream carries the same commits as the firehose as plain JSON, with a top-level
   * `time_us`: no CAR or CBOR to decode, one integer to compare against the clock.
   * `jetstream1.us-east` is here specifically because UFOs consumes it, so its lag
   * explains UFOs' lag.
   */
  jetstreams: [
    // Bluesky's own, which most bots, feeds and hobby apps consume. One per region.
    'jetstream1.us-east.bsky.network',
    'jetstream2.us-west.bsky.network',
    'jetstream1.us-east.fire.hose.cam',
    'jetstream2.fr.hose.cam'
  ],
  /**
   * Where the AppViews' indexing check gets its posts, and how many. A handful of posts
   * created in the last few seconds, taken straight off a Jetstream, are what each
   * AppView is then asked for with one `getPosts`: a measurement of how far behind its
   * indexer is in seconds, which no account's newest post can give.
   */
  indexSample: { jetstream: 'jetstream1.us-east.bsky.network', size: 10 },
  appViews: [
    'api.bsky.app',
    'public.api.bsky.app',
    'api.blacksky.community',
    'api.eurosky.network'
  ],
  /**
   * AppViews that are real but not yet whole. W Social's is in public beta and indexes
   * only part of the network by design: its own PDS's users, and accounts verified by
   * `bsky.app` itself. Anyone else — including accounts verified only by another trusted
   * verifier — gets "Profile not found". The default accounts are all ones it has, but a
   * user's own may not be, so it is measured and shown yet graded at the `community` tier,
   * where a gap it chose does not hold the tray amber. See `ProbeTier`.
   */
  communityAppViews: ['appview.wsocial.eu'],
  /**
   * AppViews that are another AppView's index under a second name, mapped to the host
   * whose index it is. `public.api.bsky.app` is the cached public face of `api.bsky.app`:
   * both are measured, because either can fail on its own, but what they say about an
   * account is one index talking. See `TargetCensus`.
   */
  sharedIndexes: { 'public.api.bsky.app': 'api.bsky.app' },
  /**
   * Bluesky's entryway: where every account on Bluesky's own PDSes signs in, refreshes
   * its session and is sent for OAuth. It is not one of those PDSes, and none of their
   * checks reach it, so it is a row of its own.
   */
  entryway: 'bsky.social',
  /**
   * Probed directly, every sweep: the independent providers' PDSes, then a hand-kept
   * sample of Bluesky's fleet, which is 89 hosts and growing. Keeping these fixed means
   * the dashboard shows the same rows sweep to sweep, which no automatic ranking of the
   * fleet could — every uptime strip would be measuring a different host.
   */
  pdses: [
    'eurosky.social',
    'blacksky.app',
    'northsky.social',
    'pds.wsocial.network',
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
  /**
   * The PLC directory, where every `did:plc` resolves. Account creation, handle changes,
   * PDS migrations and every OAuth sign-in, which resolves the DID to find the PDS, go
   * through it. The most central service in the Atmosphere.
   */
  plc: 'plc.directory',
  /**
   * Community and sandbox PDSes. Real, federated, and explicitly best-effort — `pds.rip`
   * publishes "uptime: no guarantee, backups: none" — so they are graded at the
   * `community` tier and never reach the tray. See `ProbeTier`.
   */
  communityPdses: ['pds.rip', 'pds.pckt.cafe', 'npmx.social'],
  /** An identity that has not changed and will not, for exact-match checks. */
  anchor: { handle: 'bsky.app', did: 'did:plc:z72i7hdynmk6r22z27h6tvur' },
  /** The microcosm.blue suite around Constellation. */
  microcosm: {
    ufos: 'ufos-api.microcosm.blue',
    slingshot: 'slingshot.microcosm.blue',
    spacedust: 'spacedust.microcosm.blue'
  },
  /**
   * Tangled: an AppView serving HTML only, a separate XRPC API (Bobbin) with its own
   * upstream (Hydrant), its own PDS, and the distributed git nodes — knots — and CI runners — spindles.
   * The infrastructure has not moved off `tangled.sh` even though the site has.
   */
  tangled: {
    appview: 'tangled.org',
    api: 'api.tangled.org',
    /** Tangled's own PDS, where `*.tngl.sh` handles live. A stock PDS, probed as one. */
    pds: 'tngl.sh',
    knots: ['knot1.tangled.sh'],
    spindles: ['spindle.tangled.sh']
  },
  /** Publishing apps, which answer on `/up` rather than `/xrpc/_health`. */
  apps: {
    pckt: {
      host: 'pckt.blog',
      /** A blog on pckt's own subdomains, whose well-known route resolves out of the database. */
      publicationHost: 'notes.pckt.blog'
    },
    leaflet: {
      host: 'leaflet.pub',
      /** What the full-text search is asked for: the app's own name always finds something. */
      query: 'leaflet'
    },
    offprint: {
      host: 'offprint.app',
      /** A publication on a custom domain, whose well-known route resolves out of the database. */
      publicationHost: 'news.offprint.app'
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

/** Every PDS host the catalogue measures already, under whatever kind. */
const CATALOGUE_PDSES: ReadonlySet<string> = new Set([
  ...CATALOGUE.pdses,
  ...CATALOGUE.communityPdses,
  CATALOGUE.tangled.pds,
  CATALOGUE.entryway
])

/**
 * The PDSes a user listed that the catalogue does not already measure. Listing one it
 * does would otherwise be two rows with one id.
 */
function ownPdses(targets: ProbeTargets): string[] {
  return targets.pdses.filter((host) => !CATALOGUE_PDSES.has(host))
}

/**
 * Every service the catalogue names, in dashboard order, under the given targets.
 *
 * Nearly every row is a host in `CATALOGUE` and stays put whatever the targets say. The
 * feeds and the user's own PDSes are the exceptions: each one listed is its own row, so
 * this list follows `ProbeTargets.feeds` and `ProbeTargets.pdses`, and
 * `NetworkMonitor.retarget` rebuilds the dashboard from them when they change. A feed's
 * row is `feed:<host>` like everything else's, which is why the schema holds each feed
 * to a host of its own.
 */
export function servicesFor(targets: ProbeTargets): ServiceDefinition[] {
  return [
    ...CATALOGUE.relays.map((host) => define('relay', 'relays', host)),
    ...CATALOGUE.jetstreams.map((host) => define('jetstream', 'streams', host)),
    define('spacedust', 'streams', CATALOGUE.microcosm.spacedust),
    ...CATALOGUE.appViews.map((host) => define('appview', 'appviews', host)),
    ...CATALOGUE.communityAppViews.map((host) =>
      define('appview', 'appviews', host, { tier: 'community' })
    ),
    // The user's own come first: they are the rows somebody who listed them looks for.
    ...ownPdses(targets).map((host) => define('pds', 'pdses', host)),
    define('entryway', 'pdses', CATALOGUE.entryway, { label: 'bsky.social (Bluesky sign-in)' }),
    ...CATALOGUE.pdses.map((host) => define('pds', 'pdses', host)),
    ...CATALOGUE.communityPdses.map((host) => define('pds', 'pdses', host, { tier: 'community' })),
    define('tangled-appview', 'tangled', CATALOGUE.tangled.appview),
    define('bobbin', 'tangled', CATALOGUE.tangled.api, { label: 'Bobbin (Tangled API)' }),
    define('hydrant', 'tangled', CATALOGUE.tangled.api, { label: 'Hydrant (Bobbin upstream)' }),
    define('pds', 'tangled', CATALOGUE.tangled.pds, { label: 'tngl.sh (Tangled PDS)' }),
    ...CATALOGUE.tangled.knots.map((host) => define('knot', 'tangled', host)),
    ...CATALOGUE.tangled.spindles.map((host) => define('spindle', 'tangled', host)),
    define('pckt', 'apps', CATALOGUE.apps.pckt.host),
    define('leaflet', 'apps', CATALOGUE.apps.leaflet.host),
    define('offprint', 'apps', CATALOGUE.apps.offprint.host),
    ...targets.feeds.map((feed) =>
      define('feed', 'infrastructure', feed.host, { label: feed.label })
    ),
    define('plc', 'infrastructure', CATALOGUE.plc, { label: 'PLC directory' }),
    // One person's PC at home, behind a small VPS, promising nothing about uptime: by the
    // same rule as `pds.rip`, community. See `ProbeTier`.
    define('foryou', 'infrastructure', CATALOGUE.forYou.host, {
      label: 'For You feed',
      tier: 'community'
    }),
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
}

/** Every service measured under the checked-in targets. */
export const SERVICES: readonly ServiceDefinition[] = servicesFor(DEFAULT_PROBE_TARGETS)

export const PROBE_GROUPS: readonly { id: ProbeGroup; title: string; blurb: string }[] = [
  { id: 'relays', title: 'Relays', blurb: 'Carry every repository commit on the firehose' },
  { id: 'streams', title: 'Streams', blurb: 'The firehose as JSON, and the links built from it' },
  { id: 'appviews', title: 'AppViews', blurb: 'Serve the profiles, feeds and threads apps read' },
  { id: 'pdses', title: 'PDSes', blurb: 'Host accounts and the records they write' },
  {
    id: 'tangled',
    title: 'Tangled',
    blurb: 'Git collaboration: appview, API, PDS, knots and spindles'
  },
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
/**
 * How many times its own usual latency a service has to take to read as slow.
 *
 * `SLOW_MS` is status.feeds.blue's rule, and against a thirty-second timeout it almost
 * never fires: a relay that answers in 300 ms and starts taking 4 s is something people
 * feel, and fifteen seconds never sees it. Each service is compared with itself instead.
 */
export const SLOW_FACTOR = 4
/** Nothing under this reads as slow, however fast the service usually is. */
export const SLOW_FLOOR_MS = 2_000
/** Recent answers a service needs before its usual latency means anything. */
export const BASELINE_SAMPLES = 6
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
 * stalled. UFOs runs a tenth of a second behind, so this is generous by three orders of
 * magnitude on purpose: it has to survive a quiet minute, a clock a little out of step
 * with the server's — one sample read as 0.1s *ahead* — and a sweep that only looks
 * every ten minutes.
 */
export const CURSOR_LAG_MS = 5 * 60_000
/**
 * How long each AppView is given to index a sample of brand-new posts before it is
 * asked for them. Healthy AppViews have nearly all of them within three seconds, so a
 * row that cannot find half of them after ten is behind by more than a hiccup.
 */
export const INDEX_GRACE_MS = 10_000
/**
 * How long a check that is too expensive for every sweep waits between runs. Leaflet's
 * publication feed is the case: twelve kilobytes for a date that moves in hours, so it
 * runs hourly instead.
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
 * Whether a service counts for this person: core, and in a panel they have kept in.
 * See `Settings.countedProbeGroups`.
 */
export function isCounted(
  service: { group: ProbeGroup; tier: ProbeTier },
  groups: readonly ProbeGroup[]
): boolean {
  return isCore(service) && groups.includes(service.group)
}

/**
 * Roll a service's checks up into one state, the way status.feeds.blue does: every
 * check passing is `live` (or `slow`, when one took 15 seconds or more), every check
 * failing is `down`, and anything failing alongside a pass — or alongside a check still
 * in flight — is `partial`.
 */
export function probeState(checks: ProbeCheck[]): ProbeState {
  if (!checks.length) return 'pending'
  // An excused failure is the target's news, not the service's; see `ProbeCheck.excused`.
  const judged = checks.filter((check) => check.excused === undefined)
  if (!judged.length) return 'live'
  return judgedState(judged)
}

function judgedState(checks: ProbeCheck[]): ProbeState {
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

/**
 * The latency a service usually answers in: the median of its recent answers, or null
 * while it has too few to say. Failed observations are left out, since a timeout is not
 * a latency.
 */
export function usualLatency(
  history: readonly { state: ProbeState; latencyMs: number | null }[]
): number | null {
  const times = history
    .filter((sample) => isReachable(sample.state) && sample.latencyMs !== null)
    .map((sample) => sample.latencyMs!)
    .toSorted((a, b) => a - b)
  if (times.length < BASELINE_SAMPLES) return null
  const middle = times.length >> 1
  return times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2
}

/** Whether `latencyMs` is slow for a service with this history. See `SLOW_FACTOR`. */
export function slowForItself(
  latencyMs: number | null,
  history: readonly { state: ProbeState; latencyMs: number | null }[],
  floorMs = SLOW_FLOOR_MS
): boolean {
  if (latencyMs === null || latencyMs < floorMs) return false
  const usual = usualLatency(history)
  return usual !== null && latencyMs >= usual * SLOW_FACTOR
}

/**
 * What one finished observation of a service reads as: its checks rolled up by
 * `probeState`, and then, if they all passed, whether it took several times as long as
 * it usually does. `history` is what came before this observation, not including it.
 */
export function observedState(
  checks: ProbeCheck[],
  history: readonly { state: ProbeState; latencyMs: number | null }[],
  floorMs = SLOW_FLOOR_MS
): ProbeState {
  const state = probeState(checks)
  if (state !== 'live') return state
  return slowForItself(medianLatency(checks), history, floorMs) ? 'slow' : 'live'
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

/**
 * Roll the dashboard up into the few facts the header, tray and tooltip show, counting
 * only the services in `counted` panels. See `Settings.countedProbeGroups`.
 */
export function summarizeNetwork(
  snapshot: NetworkSnapshot,
  enabled: boolean,
  counted: readonly ProbeGroup[]
): NetworkSummary {
  const atmosphere = snapshot.services.filter((service) => !isControl(service))
  const core = atmosphere.filter((service) => isCounted(service, counted))
  const down = core.filter((s) => s.condition === 'down').map((s) => s.label)
  const degraded = core.filter((s) => s.condition === 'partial').map((s) => s.label)
  const uncounted = atmosphere
    .filter((s) => !isCounted(s, counted) && (s.condition === 'down' || s.condition === 'partial'))
    .map((s) => s.label)

  let health: NetworkHealth
  if (!enabled) health = 'off'
  else if (snapshot.offline) health = 'offline'
  else if (down.length) health = 'down'
  else if (degraded.length) health = 'degraded'
  // A service that does not count still proves the checks are working when it answers,
  // so it counts towards `operational` even though its failures never count against it.
  else if (atmosphere.some((s) => s.condition === 'up')) health = 'operational'
  else health = 'unknown'

  return {
    health,
    total: atmosphere.length,
    reachable: atmosphere.filter((s) => isReachable(s.state)).length,
    down,
    degraded,
    uncounted,
    vanished: snapshot.vanished,
    running: snapshot.running,
    lastSweepAt: snapshot.finishedAt,
    // Carried through unjudged: it says why the schedule is behaving as it is, which is
    // never a statement about the Atmosphere and so never touches `health`.
    restraint: snapshot.restraint
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

/**
 * Who the headline rests on, for the line underneath it.
 *
 * A verdict that comes from somebody's post is a report, not a measurement, and the
 * header says so: which source, and how long ago. A `stale` attribution is the case
 * this exists for — the claim no longer sets the verdict, and rather than dropping it
 * silently the header keeps it on screen with its age, where the reader can weigh it.
 */
export interface Attribution {
  /** How the source names itself: a display name, a handle, or a status page's host. */
  name: string
  /**
   * What was claimed. The same as the headline's own health while the claim is current;
   * once it is stale the headline has moved on to what was measured, and this is the
   * only place left that says what the post actually said.
   */
  health: Health
  /** When the source said it. */
  at: string
  /** How many other sources are saying the same thing, beyond this one. */
  others: number
  /** The claim has outlived its own window; it is context now, not a report. */
  stale: boolean
}

export interface Headline {
  health: Health
  label: string
  /** Null when the line is this machine's own measurement rather than anybody's claim. */
  attribution: Attribution | null
}

/** Nothing current from anybody, and what is on file has outlived itself. */
const NOTHING_RECENT = 'Nothing reported recently'

/**
 * The one line at the top of the popover and the tray tooltip.
 *
 * The worse of what the status accounts say and what the checks measured wins. When
 * they agree, the accounts' wording is kept — an operator's "Active incident" is more
 * authoritative than a probe's. Being offline trumps both: with nothing reachable, the
 * cached posts are stale and every check is meaningless.
 *
 * `posts` is the rollup of the claims still speaking for the present; see
 * `reportHeadline`, which is what both processes actually call.
 */
export function headline(
  posts: Health,
  network: NetworkSummary | null,
  attribution: Attribution | null = null
): Headline {
  const measured = network ? networkAsHealth(network.health) : null
  if (measured === 'offline') {
    return { health: 'offline', label: HEALTH_LABEL.offline, attribution: null }
  }

  const health = measured ? overallHealth([posts, measured]) : posts
  // Only name services when the measurement is what made the headline worse.
  const measuredWorse = network !== null && health === measured && health !== posts

  if (measuredWorse && network.down.length) {
    return {
      health,
      label:
        network.down.length === 1
          ? `${network.down[0]} is unreachable`
          : `${network.down.length} services unreachable`,
      attribution: null
    }
  }
  if (measuredWorse && network.degraded.length) {
    return {
      health,
      label:
        network.degraded.length === 1
          ? `${network.degraded[0]} is degraded`
          : `${network.degraded.length} services degraded`,
      attribution: null
    }
  }
  // "No data yet" is false when somebody said something three days ago; that it has
  // gone stale is the news, and the attribution underneath carries the rest.
  const nothingCurrent = health === 'unknown' && attribution?.stale === true
  return {
    health,
    label: nothingCurrent ? NOTHING_RECENT : HEALTH_LABEL[health],
    attribution
  }
}

/** A source and what it is currently claiming. */
interface Claimed {
  name: string
  claim: Claim
}

/** A source that has posted something, so its claim has a time to attribute. */
interface Spoken extends Claimed {
  claim: Claim & { at: string }
}

/** Sources that have actually said something is wrong; the rest attribute nothing. */
function speaking(claims: Claimed[]): Spoken[] {
  return claims.filter(
    (c): c is Spoken =>
      c.claim.at !== null && c.claim.health !== 'operational' && c.claim.health !== 'unknown'
  )
}

function newest(claims: Spoken[]): Spoken | null {
  let best: Spoken | null = null
  for (const candidate of claims) {
    const at = Date.parse(candidate.claim.at)
    if (Number.isNaN(at)) continue
    if (!best || at > Date.parse(best.claim.at)) best = candidate
  }
  return best
}

/**
 * Who to name under the headline: whoever's claim set the verdict, or — when nothing
 * current set it — whoever last said something that has since gone quiet.
 */
function attributionFor(claims: Claimed[], reported: Health): Attribution | null {
  const said = speaking(claims)
  const current = said.filter((c) => !c.claim.stale && c.claim.health === reported)
  const candidates = current.length ? current : said.filter((c) => c.claim.stale)

  const chosen = newest(candidates)
  if (!chosen) return null
  // "+1" has to mean one more source saying *this*. Withdrawn claims are not otherwise
  // alike — one account's maintenance and another's incident both end up here — so the
  // count is taken among those agreeing with whoever is being named.
  const agreeing = candidates.filter((c) => c.claim.health === chosen.claim.health)
  return {
    name: chosen.name,
    health: chosen.claim.health,
    at: chosen.claim.at,
    others: agreeing.length - 1,
    stale: chosen.claim.stale
  }
}

/**
 * The header line and the tray tooltip, assembled from a whole snapshot.
 *
 * The popover and the tray draw the same sentence from the same state, and any
 * difference between them is a bug — so neither builds it itself. A claim that has
 * outlived its own window stops counting towards the verdict and becomes the line
 * underneath instead: the header goes on reporting what this machine knows, and the
 * tray icon goes back to neutral, while the post itself keeps its colour everywhere it
 * is a post rather than a verdict.
 */
export function reportHeadline(
  accounts: Account[],
  posts: StatusPost[],
  network: NetworkSummary,
  now: number
): Headline {
  const claims: Claimed[] = accounts
    .filter((account) => !account.muted && !isProbeSource(account.did))
    .map((account) => ({
      name: account.displayName || account.handle,
      claim: deriveClaim(
        posts.filter((post) => post.authorDid === account.did),
        now
      )
    }))

  const reported = overallHealth(claims.filter((c) => !c.claim.stale).map((c) => c.claim.health))
  return headline(reported, networkForHealth(accounts, network), attributionFor(claims, reported))
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
    notify: 'default',
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
  const { service } = event
  // Counted and named the way `probeState` judged them, with an excused failure — an
  // account gone from under every AppView — left out. Kept in, three of those would be
  // all an entry had room to name, and the failure that actually changed the service's
  // condition would be the "1 more" after them.
  const checks = event.checks.filter((check) => check.excused === undefined)
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
 * dashboard can set the code in figures and leave the sentence readable. When the server
 * gave its own reason — `HTTP 400 · Profile not found` — that is the sentence, being more
 * specific than any status can be. Messages that are already prose come back whole, with
 * no code.
 */
export function describeFailure(error: string): { code: string | null; text: string } {
  const http = /^HTTP (\d{3})(?: · (.+))?$/.exec(error)
  if (!http) return { code: null, text: error }
  const status = Number(http[1])
  if (http[2]) return { code: String(status), text: http[2] }
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
