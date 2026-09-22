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
 * When a post stops being unread without being clicked, in the Feed tab.
 *
 * `open` is the default: showing a tab is taken as having read what is in it, which is
 * what a menu bar app is for — you click the icon because something is beating at you,
 * and having looked, you are caught up. `never` leaves reading as something you do
 * rather than something that happens to you, for anyone who wants the count to mean
 * exactly what they have clicked. `seen` marks each post once it has actually been on
 * screen, which is the pedantic version of `open` for a list longer than the popover.
 *
 * The Timeline ignores this. It is the view the menu bar summons you to, it leads with
 * what you have not read, and opening it is reading it.
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
  /**
   * A system-wide key combination that summons the popover, or `''` for none.
   *
   * Empty by default, and deliberately so: a global shortcut is taken from every other
   * application on the machine for as long as this one is running, which is not a thing
   * an app gets to do to somebody who never asked for it. The value is an Electron
   * accelerator (`CommandOrControl+Shift+S`); whether the OS actually granted it is a
   * separate question, answered by `AppState.shortcut` rather than by this field.
   */
  globalShortcut: string
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

/**
 * What the OS actually did with `Settings.launchAtLogin`, as opposed to what was asked.
 *
 * Not persisted, and deliberately separate from the setting itself: the setting is the
 * user's intention and stays theirs, while this is a fact about this machine right now,
 * re-established at every launch. They are allowed to disagree, and when they do it is
 * the only warning anybody gets — a login item that was refused produces no error the
 * user ever sees, because the next thing that would have told them is the app that
 * failed to start. See src/main/login-item.ts.
 */
export interface LoginItemStatus {
  /** Whether the OS reports the login item as registered, read back rather than assumed. */
  registered: boolean
  /**
   * Why `registered` disagrees with the setting, worded for a person to act on; null
   * when the OS did what it was asked.
   */
  error: string | null
}

/**
 * What the OS did with `Settings.globalShortcut`, as opposed to what was asked.
 *
 * The same split as `LoginItemStatus`, for the same reason: the setting is the user's
 * intention and stays theirs, this is a fact about this machine right now. A global
 * shortcut is first-come-first-served across the whole session — `globalShortcut.register`
 * answers false when another application already owns the combination — and a refusal
 * is otherwise completely silent, because the only symptom is a key that does nothing
 * while some other app quietly handles it. Not persisted: whichever app got there first
 * today says nothing about tomorrow, so this is re-established on every launch.
 */
export interface ShortcutStatus {
  /** Whether the combination is registered to this app right now. */
  registered: boolean
  /** Why it is not, worded for a person to act on; null when it is, or when none is set. */
  error: string | null
}

/**
 * How far along this install is in becoming a newer Statusky.
 *
 * `current` is both "you are up to date" and "we have not been able to find out", and
 * the two are deliberately not distinguished: the only thing either can honestly make
 * the app say is nothing. `available` means a newer release exists and this build cannot
 * install it for itself, so the user has to go and fetch it. `ready` means one has
 * already been downloaded and is sitting there waiting for a restart.
 *
 * The two are mutually exclusive by construction rather than by accident — see
 * src/main/update.ts, where exactly one of the two mechanisms is ever running.
 */
export type UpdateStage = 'current' | 'available' | 'ready'

/**
 * Whether there is a newer Statusky than this one, and whose job it is to do something
 * about it.
 *
 * The same shape of thing as `LoginItemStatus` and `ShortcutStatus`: not a setting, not
 * persisted, and re-established from scratch on every launch, because what was the newest
 * release yesterday says nothing about today. Unlike those two it is not a refusal being
 * reported — it is the one piece of news this app carries about itself.
 *
 * It deliberately does not travel as an OS notification. This app's banners mean *the
 * Atmosphere is broken*, and spending that channel on "a new version is out" teaches
 * people that the thing which pages them is routine. See src/main/update.ts.
 */
export interface UpdateStatus {
  stage: UpdateStage
  /**
   * The version on offer, as the release names it — without the `v` a Git tag usually
   * carries. Null while `current`, and also null when an update is `ready` but the
   * platform would not say which version it is; see `downloadedVersion` in
   * src/main/update.ts.
   */
  version: string | null
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

/**
 * Why the sweep schedule is not doing what the settings ask of it.
 *
 * A sweep is around a hundred small requests and five brief firehose connections, which
 * is defensible every ten minutes on a desk and indefensible on a laptop at 9% — so the
 * OS gets a say. `battery` widens the interval while the machine is unplugged. `thermal`
 * holds scheduled sweeps back entirely while the machine is under thermal pressure or
 * has had its CPU ceiling cut: piling a hundred TLS handshakes onto a machine already in
 * trouble is rude, and the measurements would be about this laptop's throttling rather
 * than about the services, which is the opposite of what this app claims to do.
 *
 * `thermal` outranks `battery`, because it is the stronger statement of the two.
 */
export type SweepRestraint = 'battery' | 'thermal'

/** The whole dashboard. Pushed on its own channel, because it changes by the request. */
export interface NetworkSnapshot {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  /** Every control check failed, so nothing else can be judged. */
  offline: boolean
  /**
   * What the machine's own condition is doing to the schedule, or null when nothing is.
   *
   * Carried so that a sweep that never ran is distinguishable from one that ran and
   * found nothing. Without it, a dashboard last measured forty minutes ago under a
   * ten-minute setting reads as the app being broken.
   */
  restraint: SweepRestraint | null
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
  /**
   * What the machine's own condition is doing to the schedule; see `SweepRestraint`.
   * Mirrored out of `NetworkSnapshot` so the tray tooltip and the header, which never
   * see the dashboard itself, can say why the last sweep is older than the setting.
   */
  restraint: SweepRestraint | null
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
  /** Whether the OS really did register the login item, and why not when it did not. */
  loginItem: LoginItemStatus
  /** Whether the OS really did grant the global shortcut, and why not when it did not. */
  shortcut: ShortcutStatus
  /** Whether there is a newer Statusky, and whether this build can install it itself. */
  update: UpdateStatus
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
