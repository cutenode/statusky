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
   * own id in the payload, which is stable for the same reason. The one `probe` source
   * is always `probe:network`.
   */
  did: string
  /**
   * The account's handle for an `atproto` source; a status page's hostname, or the
   * checks' own name, for the others. Only the first is written with an `@`, so show it
   * through `sourceLabel` in src/shared/webhook.ts rather than prefixing one by hand.
   */
  handle: string
  displayName: string
  avatar: string | null
  description: string | null
  /** How much of this source is worth a banner. See `NotifyLevel`. */
  notify: NotifyLevel
  /** Hide this account's posts from the feed without forgetting it. */
  muted: boolean
  /**
   * ISO timestamp of when this source started being tracked: added by the user, seeded
   * on first launch, or registered by its own first delivery or measured outage.
   */
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

/**
 * One entry in the feed: an `app.bsky.feed.post` record flattened for the UI, or a
 * pushed status-page update or a network-check event given the same shape. Those two
 * have no record behind them, so their `cid` and `rkey` are only filled in to match —
 * and every count is zero.
 */
export interface StatusPost {
  /**
   * The entry's identity, and the key read state and redeliveries join on. For a post it
   * is the record's `at://did/app.bsky.feed.post/rkey`. A pushed update is
   * `webhook:<page id>/…`, followed by the incident update or component change it
   * reports, and a network-check entry is `probe:network/<service id>/<epoch ms>`.
   */
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
  /**
   * ISO timestamp of when the entry says it was written: the record's own `createdAt`, a
   * status page's time for the update, or when a check confirmed the change. A record
   * with no string `createdAt` falls back to `indexedAt`, and failing that to the epoch.
   */
  createdAt: string
  /**
   * ISO timestamp from the AppView index, or when an entry with no index behind it
   * reached us; used as a fallback ordering key.
   */
  indexedAt: string
  severity: Severity
  replyCount: number
  repostCount: number
  likeCount: number
  /**
   * Where the entry can be read on the web: the public bsky.app permalink for a post, the
   * incident's or the status page's own page for a pushed update. `''` when there is
   * nowhere to go, which is every network-check entry, so test it before opening it.
   */
  url: string
}

export type ThemePreference = 'system' | 'light' | 'dark'

/**
 * How much of one source is worth a banner.
 *
 * `default` follows the stages chosen in Settings, which is what almost every source
 * wants. The other three override them for this source alone: `all` is every update it
 * posts, `outages` is only the stages that mean something is broken right now, and `off`
 * is no banners at all while the source stays in the feed. Muting is a separate thing,
 * because it hides the source from the feed too.
 */
export type NotifyLevel = 'default' | 'all' | 'outages' | 'off'

/** When a banner makes a sound: every time, only for outages, or never. */
export type NotificationSound = 'all' | 'urgent' | 'never'

/**
 * Which services the network checks may raise a banner about.
 *
 * `core` is the Atmosphere proper, the same services that are allowed to set the tray's
 * health: core tier (see `ProbeTier`), in a panel `Settings.countedProbeGroups` keeps. `all` adds community infrastructure. `pinned` is only the
 * services the user has starred on the dashboard, for someone who runs a PDS and cares
 * about that and nothing else.
 */
export type ProbeNotifyScope = 'core' | 'all' | 'pinned'

/**
 * What happens to banners that would go up while nobody is at the machine.
 *
 * `digest` holds them and says once, on the way back, how many there were. `deliver`
 * shows them as they arrive anyway, for anyone who reads Notification Center later or
 * works on a second screen. `drop` holds them and then says nothing. In every case the
 * updates stay unread, so the tray and the Timeline still have them.
 */
export type AwayBehaviour = 'digest' | 'deliver' | 'drop'

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
  /** When a banner plays the system notification sound. */
  notificationSound: NotificationSound
  /** Leave outage banners on screen until dismissed rather than letting them time out. */
  notifyStickyOutages: boolean
  /** The incident stages worth a banner, for sources left on `NotifyLevel` `default`. */
  notifySeverities: Severity[]
  /**
   * Announce *Monitoring* and *Resolved* only for incidents whose start got a banner.
   *
   * On, the two follow-up stages ignore `notifySeverities` and are shown exactly when the
   * incident they follow was: the all-clear always reaches whoever heard about the
   * outage, and nobody is told something is fixed that they never knew was broken.
   */
  notifyFollowUpsOnly: boolean
  /** The kinds of source allowed to raise a banner at all. */
  notifySources: SourceKind[]
  /** Which measured services may raise a banner. See `ProbeNotifyScope`. */
  notifyProbeScope: ProbeNotifyScope
  /**
   * How long a service has to stay down before the banner goes up, in seconds. Zero is
   * as soon as the checks have confirmed it, which is already one re-check after the
   * first failure. A recovery inside the window cancels both banners.
   */
  notifyProbeGraceSec: number
  /** Raise a banner when a measured service comes back. */
  notifyProbeRecovery: boolean
  /** Raise a banner when a measured service is only partly failing. */
  notifyProbePartial: boolean
  /** Hold banners between `quietHoursStart` and `quietHoursEnd`, local time. */
  quietHoursEnabled: boolean
  /** `HH:MM`, 24-hour, local time. */
  quietHoursStart: string
  /** `HH:MM`, 24-hour, local time. Earlier than the start means the window spans midnight. */
  quietHoursEnd: string
  /** Let outages through during quiet hours. */
  quietHoursBreakthrough: boolean
  /** What happens to banners while nobody is at the machine. */
  notifyWhenAway: AwayBehaviour
  /** Fold updates that arrive shortly after a banner into one summary. */
  notifyCombineBursts: boolean
  /**
   * ISO timestamp banners are held until, or null when nobody has snoozed them. Nothing
   * clears it when the time comes, so a time already past is a snooze that has ended:
   * ask `snoozedUntil` in src/shared/notify.ts rather than testing it for null.
   */
  notificationsSnoozedUntil: string | null
  /** Show the update's text in the banner, rather than only its source and stage. */
  notificationShowBody: boolean
  /** Service ids starred on the dashboard. See `ProbeNotifyScope`. */
  pinnedServices: string[]
  /**
   * The dashboard's panels whose services count: towards the header, the tray icon, and
   * the banners `ProbeNotifyScope` `core` allows.
   *
   * Everything is measured and filed in the feed whatever this says. What it decides is
   * which failures speak for the network *to this person*: somebody who has never opened
   * Tangled has no use for an amber menu bar because a spindle is down. Community
   * infrastructure never counts, whichever panel it is in (see `ProbeTier`), and the
   * control group is never judged at all.
   */
  countedProbeGroups: ProbeGroup[]
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
  /**
   * Loopback port the receiver binds to, or 0 for whichever one the OS offers — which
   * `WebhookStatus.port` then reports.
   */
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
  /**
   * The user's own choice of what the network checks read, or null for the checked-in
   * defaults in `src/shared/probeTargets.json`.
   *
   * Always the whole document when set, never a patch over the defaults: that is what
   * makes exporting it the same thing as saving it, and "reset to defaults" nothing more
   * than null. An override identical to the defaults is stored as null, so somebody who
   * opened the editor and saved without changing anything still gets whatever the next
   * release ships. Read it through `effectiveProbeTargets` in
   * src/shared/probe-targets.ts, never directly.
   */
  probeTargets: ProbeTargets | null
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
  /**
   * The port actually bound, which is the OS's choice when the setting is 0, or null when
   * the receiver is not listening.
   */
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
 *
 * `version` is the version on offer, as the release names it — without the `v` a Git tag
 * usually carries. Which stages may leave it out is part of the type: there is nothing
 * to name while `current`, `available` only ever comes from a release tag that parsed as
 * one, and `ready` goes without when the release was not named as a version; see
 * `downloadedVersion` in src/main/update.ts.
 */
export type UpdateStatus =
  | { stage: 'current'; version: null }
  | { stage: 'available'; version: string }
  | { stage: 'ready'; version: string | null }

export type SyncStatus = 'idle' | 'syncing' | 'error'

// ------------------------------------------------------------- network checks

/** Which panel of the network dashboard a service sits in. */
export type ProbeGroup =
  'relays' | 'streams' | 'appviews' | 'pdses' | 'tangled' | 'apps' | 'infrastructure' | 'internet'

/** What a service is, which decides the requests that probe it. */
export type ProbeKind =
  | 'relay'
  | 'pds'
  | 'entryway'
  | 'appview'
  | 'feed'
  | 'constellation'
  | 'cdn'
  | 'plc'
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
  /**
   * What was asked for, for the tooltip. Null for derived checks, and for a request whose
   * URL depends on an earlier check's answer until that answer arrives — for good, if it
   * never does.
   */
  target: string | null
  kind: ProbeCheckKind
  /** Null while in flight. */
  ok: boolean | null
  /** Why it failed, worded for people. */
  error: string | null
  /**
   * Why a failure is not held against the service, when it is not: the thing it asked
   * about is gone, rather than the service being broken. Every AppView saying an account
   * does not exist is the account's news. An excused check is shown with its failure and
   * this beside it, and left out of the service's state. See `TargetCensus`.
   */
  excused?: string
  /**
   * How long it took. Null while in flight, for a check that was never started — a
   * derived one, or one skipped because a check it depends on failed — and for a failure
   * whose time would only restate a wait or a cancellation.
   */
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
  /**
   * `<kind>:<host>`, or `internet:<check id>` for a control check — stable across
   * launches, and the key a feed entry links back to.
   */
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
  /**
   * Listed accounts, or their handles, that no AppView could find at the last sweep that
   * asked: deleted, deactivated or renamed out from under the checks. See `TargetCensus`.
   */
  vanished: VanishedTarget[]
  services: ServiceProbe[]
}

/**
 * One of the listed accounts as no AppView knows it any more. `account` is the account
 * itself gone — deleted, deactivated, suspended. `handle` is the account still there
 * under a handle other than the one listed, so resolving the listed one fails.
 */
export interface VanishedTarget {
  did: string
  part: 'account' | 'handle'
}

export type NetworkHealth = 'off' | 'unknown' | 'operational' | 'degraded' | 'down' | 'offline'

/** Just enough of the network state for the header, the tray and the notifications. */
export interface NetworkSummary {
  health: NetworkHealth
  /** Atmosphere services — the control checks are not counted. */
  total: number
  /**
   * Of those, how many answered on their last observation. A service a sweep is measuring
   * again is `pending` until it answers, so while one runs this counts only the ones it
   * has already heard back from.
   */
  reachable: number
  /** Labels of core services confirmed down. */
  down: string[]
  /** Labels of core services confirmed partly failing. */
  degraded: string[]
  /**
   * Labels of services in trouble that do not count: community infrastructure, and
   * anything in a panel left out of `Settings.countedProbeGroups`. Shown on the dashboard
   * and filed in the feed, but deliberately kept out of `health`.
   */
  uncounted: string[]
  /** Mirrored from `NetworkSnapshot.vanished`, for Settings to point at. */
  vanished: VanishedTarget[]
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

// ------------------------------------------------------------- probe targets

/**
 * An account the AppView checks read, by both halves of its identity.
 *
 * Every AppView is asked for each one's profile by DID, for its handle to be resolved —
 * which must come back as exactly this DID — and for its newest posts. Keeping the two
 * halves together is what makes that resolution checkable at all, and is why a handle
 * cannot be listed without the DID it belongs to.
 */
export interface ProbeAccount {
  did: string
  handle: string
}

/** A custom feed, asked for one post of its skeleton. One row on the dashboard each. */
export interface ProbeFeed {
  label: string
  /** The feed generator's host, which the skeleton is asked of directly. */
  host: string
  /** The `app.bsky.feed.generator` record that names the feed. */
  uri: string
}

/** One record, by the repository it lives in and its key. */
export interface ProbeRecord {
  did: string
  rkey: string
}

/** One image blob on the CDN, by whose repository it is in and its CID. */
export interface ProbeImage {
  did: string
  cid: string
}

/**
 * Everything the network checks read that somebody could delete or edit out from under
 * them: particular accounts, feeds, images, repositories and documents.
 *
 * Hostnames are mostly not in here. They are the services themselves, and live in
 * `CATALOGUE` in src/shared/network.ts; these are only the things each service is asked
 * about. Two lists are the exception, because each entry in them is a dashboard row of
 * the user's own choosing: `feeds`, and `pdses`. The checked-in defaults are
 * `src/shared/probeTargets.json`, and a user may replace the whole document through
 * `Settings.probeTargets` when one of them disappears.
 */
export interface ProbeTargets {
  /**
   * The accounts every AppView is asked about. Prolific posters on purpose: between
   * them somebody has always posted recently, which is what the newest-post comparison
   * between AppViews needs. The defaults are every account the three separate lists
   * this replaced — author feeds, profiles and handles — ever named.
   */
  accounts: ProbeAccount[]
  feeds: ProbeFeed[]
  /**
   * PDS hosts the user wants watched as well as the catalogue's: their own, typically.
   * Each is a row of its own, probed like any other PDS — including whether Bluesky's
   * relay still carries it, which is the question somebody running a PDS asks first
   * when their posts stop showing up. Empty by default. Hosts the catalogue already
   * measures are not measured twice.
   */
  pdses: string[]
  forYou: {
    /** What the generator record points at, and what an AppView resolves before calling. */
    did: string
    /** The feed itself, as the `app.bsky.feed.generator` record that names it. */
    feed: string
  }
  /** Images whose first chunk the CDN is asked for. */
  cdnImages: ProbeImage[]
  tangled: {
    /**
     * A Go vanity route, `?go-get=1` and all. A static 92-byte answer: routing only, no
     * database behind it. It has to name the same repository as `repoPath`.
     */
    goGetPath: string
    /**
     * A repository page, as `/<owner handle>/<name>`. The full path: routing, database,
     * identity resolution and render. The page titles itself with this path minus its
     * leading slash, so that is what the check looks for — and why the owner has to be
     * written as the handle, which is what a DID or `@` path would redirect to.
     */
    repoPath: string
    /** The same repository's own DID, as minted by its knot, for Bobbin to look up. */
    repoDid: string
    /** Who owns the repository: Tangled's own account, which runs the default spindle too. */
    ownerDid: string
  }
  apps: {
    pckt: {
      /** What the blog host's well-known route answers with: an AT-URI. */
      publication: string
    }
    leaflet: {
      /** A published document, whose well-known route is a 77-byte index read. */
      publication: ProbeRecord
      /** A busy publication, for its feed's `<updated>`. */
      feed: ProbeRecord
    }
    offprint: {
      /** What the publication host's well-known route answers with: an AT-URI. */
      publication: string
    }
  }
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
