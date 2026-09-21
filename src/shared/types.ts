/**
 * Domain types shared between the main process, the preload bridge and the renderer.
 * Everything crossing IPC must be structured-cloneable: plain objects only.
 */

/**
 * Where a source's updates come from.
 *
 * `atproto` sources are polled from the public AppView. `webhook` sources push to us
 * instead: they are status pages that have our receiver URL in their subscriber list,
 * and they register themselves the first time they deliver. The one `probe` source is
 * Statusky's own network checks, which file an entry whenever a service they measure
 * goes down or comes back.
 */
export type SourceKind = 'atproto' | 'webhook' | 'probe'

/** A tracked source of infrastructure status updates. */
export interface Account {
  /**
   * Stable identifier, and the key everything else joins on.
   *
   * For an `atproto` source this is the account's DID — handles change, DIDs do not.
   * For a `webhook` source it is `webhook:<page id>`, minted from the status page's
   * own id in the payload, which is stable for the same reason.
   */
  did: string
  handle: string
  displayName: string
  avatar: string | null
  description: string | null
  /** Emit an OS notification when this account posts. */
  notify: boolean
  /** Hide this account's posts from the feed without forgetting it. */
  muted: boolean
  /** ISO timestamp of when the user added this account. */
  addedAt: string
  /** Set for the accounts shipped with the app; they can be muted but not removed. */
  builtin: boolean
  kind: SourceKind
}

/** Severity buckets derived from post text, used for colour-coding the feed. */
export type Severity =
  | 'resolved'
  | 'monitoring'
  | 'identified'
  | 'investigating'
  | 'outage'
  | 'degraded'
  | 'maintenance'
  | 'update'

/** A rich-text span after facet resolution. */
export type RichSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; uri: string }
  | { kind: 'mention'; text: string; did: string }
  | { kind: 'tag'; text: string; tag: string }

/** A normalised, renderable embed. Anything we can't render collapses to null. */
export type PostEmbed =
  | { kind: 'external'; uri: string; title: string; description: string; thumb: string | null }
  | { kind: 'images'; images: { thumb: string; fullsize: string; alt: string }[] }
  | { kind: 'record'; uri: string; author: string; text: string }

/** A single `app.bsky.feed.post` record, flattened for the UI. */
export interface StatusPost {
  /** `at://did/app.bsky.feed.post/rkey` — the record's canonical identity. */
  uri: string
  cid: string
  rkey: string
  authorDid: string
  authorHandle: string
  authorDisplayName: string
  authorAvatar: string | null
  text: string
  segments: RichSegment[]
  embed: PostEmbed | null
  /** ISO timestamp from the record itself. */
  createdAt: string
  /** ISO timestamp from the AppView index; used as a fallback ordering key. */
  indexedAt: string
  severity: Severity
  replyCount: number
  repostCount: number
  likeCount: number
  /** Public bsky.app permalink. */
  url: string
}

export type ThemePreference = 'system' | 'light' | 'dark'

/**
 * How unread updates are announced in the menu bar.
 *
 * `beat` plays one cardiac cycle on a loop in red, over the top of the health colour.
 * `dot` puts a badge on whichever health icon is showing, which is the quiet version of
 * the same statement. `count` keeps the plain health icon and writes the number beside
 * it — macOS only, since `Tray.setTitle` does nothing elsewhere, so it falls back to
 * `dot` on other platforms. `none` leaves the icon to report health and nothing else.
 */
export type TrayUnreadStyle = 'beat' | 'dot' | 'count' | 'none'

/**
 * When a post stops being unread without being clicked, in the Feed and Alerts tabs.
 *
 * `open` is the default: showing a tab is taken as having read what is in it, which is
 * what a menu bar app is for — you click the icon because something is beating at you,
 * and having looked, you are caught up. `never` leaves reading as something you do
 * rather than something that happens to you, for anyone who wants the count to mean
 * exactly what they have clicked. `seen` marks each post once it has actually been on
 * screen, which is the pedantic version of `open` for a list longer than the popover.
 *
 * The Unread tab ignores this. It is the view the menu bar summons you to, it shows
 * nothing but what you have not read, and opening it is reading it.
 */
export type MarkReadTrigger = 'never' | 'open' | 'seen'

export interface Settings {
  /** Seconds between feed refreshes. */
  pollIntervalSec: number
  /** Master switch; per-account `notify` still applies. */
  notificationsEnabled: boolean
  /** Play the system notification sound. */
  notificationSound: boolean
  theme: ThemePreference
  launchAtLogin: boolean
  /** How unread updates are announced in the menu bar. */
  trayUnreadStyle: TrayUnreadStyle
  /** When a post stops being unread without being clicked. */
  markReadOn: MarkReadTrigger
  /** Number of posts to request per account per refresh. */
  postsPerAccount: number
  /** Listen for pushed status updates on the local webhook receiver. */
  webhookEnabled: boolean
  /** Loopback port the receiver binds to. */
  webhookPort: number
  /** Probe relays, PDSes and AppViews from this machine on a timer. */
  networkChecks: boolean
  /** Seconds between network sweeps. */
  networkIntervalSec: number
}

export type WebhookState = 'off' | 'listening' | 'error'

/**
 * Runtime state of the webhook receiver. Not persisted: a port that was free last
 * week says nothing about whether it is free now, so this is always what the current
 * process actually managed to do.
 */
export interface WebhookStatus {
  state: WebhookState
  /**
   * The full endpoint to hand a status page, secret path included, or null when the
   * receiver is not listening. This is the one place the secret is readable.
   */
  url: string | null
  port: number | null
  error: string | null
  /** Deliveries accepted since launch — the fastest way to tell a tunnel is wired up. */
  deliveries: number
  lastDeliveryAt: string | null
}

export type SyncStatus = 'idle' | 'syncing' | 'error'

// ------------------------------------------------------------- network checks

/** Which panel of the network dashboard a service sits in. */
export type ProbeGroup =
  'relays' | 'streams' | 'appviews' | 'pdses' | 'tangled' | 'apps' | 'infrastructure' | 'internet'

/** What a service is, which decides the requests that probe it. */
export type ProbeKind =
  | 'relay'
  | 'pds'
  | 'appview'
  | 'feed'
  | 'constellation'
  | 'cdn'
  | 'internet'
  | 'jetstream'
  | 'spacedust'
  | 'ufos'
  | 'slingshot'
  | 'foryou'
  | 'fleet'
  | 'tangled-appview'
  | 'bobbin'
  | 'hydrant'
  | 'knot'
  | 'spindle'
  | 'pckt'
  | 'leaflet'
  | 'offprint'

/**
 * How much a service's verdict is allowed to matter.
 *
 * `core` services are the Atmosphere proper: their failures set the header, the tray and
 * the notifications. `community` services are hobby and sandbox infrastructure that
 * publish no uptime promise — `pds.rip` says "uptime: no guarantee" on its own homepage —
 * so they are measured, shown and filed in the feed, but they never turn the tray icon
 * red. Without that distinction one abandoned PDS would speak for the whole network.
 */
export type ProbeTier = 'core' | 'community'

/**
 * How a check measured the service. `http` is one request and its round trip, which is
 * what a service's headline latency is made of. `stream` is the firehose, timed to the
 * first fresh commit. `derived` is a judgement over other checks' results, such as how
 * far an AppView's index lags behind its peers, and has no duration of its own.
 */
export type ProbeCheckKind = 'http' | 'stream' | 'derived'

/** One request, or one judgement, made while probing a service. */
export interface ProbeCheck {
  /** Short name: an XRPC method, `firehose`, `index freshness`… */
  label: string
  /** What was asked for, for the tooltip. Null for derived checks. */
  target: string | null
  kind: ProbeCheckKind
  /** Null while in flight. */
  ok: boolean | null
  /** Why it failed, worded for people. */
  error: string | null
  durationMs: number | null
}

/**
 * A service as it was last observed. Mirrors status.feeds.blue: `slow` is a pass that
 * took 15 seconds or more, `partial` means some checks failed, `down` means all did.
 */
export type ProbeState = 'pending' | 'live' | 'slow' | 'partial' | 'down'

/**
 * The debounced condition feed entries, notifications and the tray follow. A failure
 * has to be seen twice in a row before it counts, so one dropped request does not page
 * anybody; a recovery counts at once.
 */
export type ProbeCondition = 'unknown' | 'up' | 'partial' | 'down'

/** One observation in a service's recent history, for its uptime strip. */
export interface ProbeSample {
  at: string
  state: ProbeState
  latencyMs: number | null
}

export interface ServiceProbe {
  /** `<kind>:<host>` — stable across launches, and the key a feed entry links back to. */
  id: string
  group: ProbeGroup
  kind: ProbeKind
  label: string
  host: string
  tier: ProbeTier
  state: ProbeState
  condition: ProbeCondition
  /** When `condition` last changed, for "down for 12 minutes". */
  since: string | null
  checks: ProbeCheck[]
  startedAt: string | null
  checkedAt: string | null
  /** Median round trip of the HTTP checks that passed. */
  latencyMs: number | null
  /** Oldest first. */
  history: ProbeSample[]
  /** A failure is being re-checked before it is believed. */
  rechecking: boolean
}

/** The whole dashboard. Pushed on its own channel, because it changes by the request. */
export interface NetworkSnapshot {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  /** Every control check failed, so nothing else can be judged. */
  offline: boolean
  services: ServiceProbe[]
}

export type NetworkHealth = 'off' | 'unknown' | 'operational' | 'degraded' | 'down' | 'offline'

/** Just enough of the network state for the header, the tray and the notifications. */
export interface NetworkSummary {
  health: NetworkHealth
  /** Atmosphere services — the control checks are not counted. */
  total: number
  /** Of those, how many answered on their last observation. */
  reachable: number
  /** Labels of core services confirmed down. */
  down: string[]
  /** Labels of core services confirmed partly failing. */
  degraded: string[]
  /**
   * Labels of community services in trouble. Shown on the dashboard and filed in the
   * feed, but deliberately kept out of `health`: see `ProbeTier`.
   */
  community: string[]
  running: boolean
  lastSweepAt: string | null
}

/** Main asking the popover to show the dashboard, optionally scrolled to one service. */
export interface NetworkReveal {
  serviceId: string | null
}

/** Everything the renderer needs to draw itself. Pushed on every change. */
export interface AppState {
  accounts: Account[]
  posts: StatusPost[]
  settings: Settings
  /**
   * Post URIs the user has not read yet, newest first.
   *
   * Derived from the read cursors rather than stored as a list, so trimming the post
   * cache cannot resurrect an update you have already dealt with.
   */
  unread: string[]
  sync: {
    status: SyncStatus
    lastSyncedAt: string | null
    error: string | null
  }
  webhook: WebhookStatus
  network: NetworkSummary
  version: string
}

/** Result of looking up a handle before adding it. */
export interface ResolvedProfile {
  did: string
  handle: string
  displayName: string
  avatar: string | null
  description: string | null
  followersCount: number
  postsCount: number
}

/** Fields of an account the renderer is allowed to change. */
export type AccountPatch = Partial<Pick<Account, 'notify' | 'muted'>>

/** Mirrors `NodeJS.Platform`, spelled out so the renderer needs no Node types. */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'
