import { DEFAULT_SETTINGS } from '@shared/defaults'
import type {
  AccountPatch,
  Account,
  AppState,
  NetworkSnapshot,
  NetworkSummary,
  Platform,
  ProbeTargets,
  ResolvedProfile,
  Settings,
  StatusPost,
  UpdateStatus,
  WebhookStatus
} from '@shared/types'
import type { OpenedFile } from '@ipc/common/statusky'
import { isProbeSource, networkAsHealth, reportHeadline, type Headline } from '@shared/network'
import { isWebhookSource } from '@shared/webhook'
import { deriveHealth, type Health } from '@shared/status'
import { bridge, ipcErrorMessage } from '@shared/bridge'
import { nav } from './nav.svelte'

const EMPTY: AppState = {
  accounts: [],
  posts: [],
  settings: { ...DEFAULT_SETTINGS },
  unread: [],
  sync: { status: 'idle', lastSyncedAt: null, error: null },
  webhook: {
    state: 'off',
    url: null,
    port: null,
    error: null,
    deliveries: 0,
    lastDeliveryAt: null
  },
  network: {
    health: 'unknown',
    total: 0,
    reachable: 0,
    down: [],
    degraded: [],
    uncounted: [],
    vanished: [],
    running: false,
    lastSweepAt: null,
    restraint: null
  },
  loginItem: { registered: false, error: null },
  shortcut: { registered: false, error: null },
  update: { stage: 'current', version: null },
  version: '0.0.0'
}

/** What a call answered, or why it failed, for a control that reports its own failures. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string }

const EMPTY_SNAPSHOT: NetworkSnapshot = {
  running: false,
  startedAt: null,
  finishedAt: null,
  offline: false,
  restraint: null,
  vanished: [],
  services: []
}

/**
 * The renderer's single source of truth. The main process pushes whole `AppState`
 * snapshots; every mutation here is a request that comes back as another snapshot,
 * so the UI can never drift from what is actually persisted.
 *
 * Each request answers with an `Outcome` rather than throwing or leaving a sentence
 * somewhere shared: a refusal belongs beside the control that asked, and one shared
 * error line ended up saying a failed settings change under the Accounts tab's add
 * field, and was wiped by whatever ran next.
 */
class AppStore {
  // Raw, because both are only ever replaced whole by a push, never edited in place: a
  // deep proxy would wrap five hundred posts on every push, and turn every read of one
  // into a dependency of whatever read it.
  #state = $state.raw<AppState>(EMPTY)
  /** The network dashboard, which arrives on its own channel. */
  #snapshot = $state.raw<NetworkSnapshot>(EMPTY_SNAPSHOT)
  /**
   * Which platform this is running on, as main reports it.
   *
   * Asked once at startup rather than guessed from the user agent, and used for the
   * things whose *wording* differs rather than whose behaviour does — a keyboard
   * shortcut is written `⌘⇧S` on macOS and `Ctrl+Shift+S` everywhere else, and showing
   * either spelling on the wrong machine is a small lie about which key to press. The
   * default is only what the store holds before `init()` answers, and nothing is drawn
   * until `ready`.
   */
  #platform = $state<Platform>('darwin')
  #ready = $state(false)

  get accounts(): Account[] {
    return this.#state.accounts
  }
  get posts(): StatusPost[] {
    return this.#state.posts
  }
  get settings(): Settings {
    return this.#state.settings
  }
  get sync(): AppState['sync'] {
    return this.#state.sync
  }
  get webhook(): WebhookStatus {
    return this.#state.webhook
  }
  /**
   * Why the OS is not doing what the *Launch at login* toggle says, or null when it is.
   *
   * The toggle itself keeps showing the setting rather than the outcome, on purpose: the
   * setting is what the user asked for and it is still what they asked for. This is the
   * sentence that goes underneath it saying the machine disagreed, which is the only
   * chance anybody gets to find out — the alternative is discovering it after a reboot,
   * from an app that is not running.
   */
  get loginItemError(): string | null {
    return this.#state.loginItem.error
  }
  /**
   * Why the global shortcut is not working, or null when it is — or when there is none.
   *
   * The same arrangement as `loginItemError`, for the same reason: the setting says what
   * the user asked for and keeps saying it, and this is the sentence underneath saying
   * the machine disagreed. A shortcut another application already owns produces no other
   * symptom at all — the key press simply goes somewhere else — so if it is not said
   * here it is not said anywhere. See `ShortcutStatus`.
   */
  get shortcutError(): string | null {
    return this.#state.shortcut.error
  }
  /**
   * Whether there is a newer Statusky, and whose job it is to go and get it.
   *
   * Deliberately read here and drawn in Settings rather than announced. This app's OS
   * notifications mean the Atmosphere is broken; a new version is not that, and putting
   * it through the same channel is how the channel stops being believed. See
   * `UpdateStatus` and src/main/update.ts.
   */
  get update(): UpdateStatus {
    return this.#state.update
  }
  get platform(): Platform {
    return this.#platform
  }
  get version(): string {
    return this.#state.version
  }
  get network(): NetworkSummary {
    return this.#state.network
  }
  get snapshot(): NetworkSnapshot {
    return this.#snapshot
  }
  get ready(): boolean {
    return this.#ready
  }

  #unreadSet = $derived(new Set(this.#state.unread))

  get unreadCount(): number {
    return this.#state.unread.length
  }

  /** The unread posts' URIs, newest first, exactly as main ordered them. */
  get unreadUris(): string[] {
    return this.#state.unread
  }

  isUnread(uri: string): boolean {
    return this.#unreadSet.has(uri)
  }

  /**
   * What the Feed tab leaves out.
   *
   * A status account writing a post and a status page pushing an incident are the same
   * kind of thing — somebody telling you what they have noticed — but a relay that
   * stopped answering our own requests is not: nobody said it, we measured it. Feed is
   * where you go to read what people wrote, at the length they wrote it, so what a
   * machine filed stays out of it. The Timeline is where all three meet, which is where
   * a terse entry about one service belongs anyway.
   */
  #isAlert(post: StatusPost): boolean {
    return isWebhookSource(post.authorDid) || isProbeSource(post.authorDid)
  }

  /** Posts polled from AT Protocol status accounts. */
  feedPosts = $derived(this.#state.posts.filter((post) => !this.#isAlert(post)))

  /** Unread across every source, newest first. */
  unreadPosts = $derived(this.#state.posts.filter((post) => this.#unreadSet.has(post.uri)))

  /** The sources behind the Feed tab, for its filter chips. */
  feedAccounts = $derived(this.#state.accounts.filter((a) => a.kind === 'atproto'))

  #countUnread(posts: StatusPost[]): number {
    return posts.reduce((n, post) => (this.#unreadSet.has(post.uri) ? n + 1 : n), 0)
  }

  feedUnreadCount = $derived(this.#countUnread(this.feedPosts))

  /**
   * Per-account health, keyed by DID. The network checks' source is the exception: its
   * entries record what changed, so its health is the live measurement instead.
   */
  healthByAccount = $derived.by(() => {
    const map = new Map<string, Health>()
    for (const account of this.#state.accounts) {
      if (isProbeSource(account.did)) {
        map.set(account.did, networkAsHealth(this.#state.network.health) ?? 'unknown')
        continue
      }
      const posts = this.#state.posts.filter((p) => p.authorDid === account.did)
      map.set(account.did, deriveHealth(posts))
    }
    return map
  })

  /**
   * The status accounts' and the network checks' verdicts, combined into one line.
   *
   * Takes the clock, because half of what the line says is how long ago somebody said
   * it: the same snapshot reads differently an hour later, and the popover's ticking
   * `now` is what makes it do so without waiting for another push from main.
   */
  headlineAt(now: number = Date.now()): Headline {
    return reportHeadline(this.#state.accounts, this.#state.posts, this.#state.network, now)
  }

  /** The worst thing currently believed: the header's dot, and the tray's colour. */
  overallAt(now: number = Date.now()): Health {
    return this.headlineAt(now).health
  }

  /**
   * When the oldest unread post was written, or `Infinity` when nothing is unread.
   *
   * Worked out once per push, so asking `hasUnreadBelow` of every card in the feed is a
   * comparison each rather than another walk of the whole feed each. An undated post is
   * older than nothing, and so never the oldest.
   */
  #oldestUnreadAt = $derived.by(() => {
    let oldest = Infinity
    for (const post of this.#state.posts) {
      if (!this.#unreadSet.has(post.uri)) continue
      const at = Date.parse(post.createdAt)
      if (at < oldest) oldest = at
    }
    return oldest
  })

  /**
   * Whether anything older than this post is still unread, which is what makes
   * "mark read to here" worth offering on it rather than on every post in the feed.
   */
  hasUnreadBelow(post: StatusPost): boolean {
    return Date.parse(post.createdAt) > this.#oldestUnreadAt
  }

  unreadByAccount = $derived.by(() => {
    const counts = new Map<string, number>()
    for (const post of this.#state.posts) {
      if (!this.#unreadSet.has(post.uri)) continue
      counts.set(post.authorDid, (counts.get(post.authorDid) ?? 0) + 1)
    }
    return counts
  })

  /**
   * Forget everything and go back to waiting for a first state.
   *
   * The store is a module singleton, which is right for an app with one window and
   * wrong for a test file with thirty. Without this, a component mounted by the next
   * test reads the last one's settings for the tick before `init()` resolves — and the
   * real popover never sees that, because it does not render the feed until `ready`.
   */
  reset(): void {
    this.#state = EMPTY
    this.#snapshot = EMPTY_SNAPSHOT
    this.#platform = 'darwin'
    this.#ready = false
  }

  /**
   * Load the first state and follow every push after it.
   *
   * Subscribed before asking, and each answer applied the moment it lands. A push that
   * arrives before an answer was sent before it, so the answer is the newer of the two
   * and replaces it; one that arrives after is newer still and replaces the answer. The
   * other way round — asking first and subscribing once all three had answered — lost
   * every push in between, and a first sync finishing in that gap stayed off screen
   * until something else changed.
   *
   * A failure unsubscribes again and rejects, for `App` to say so and offer another go.
   */
  async init(): Promise<() => void> {
    const { State, Network, Popover, Host } = bridge()
    const stops = [
      State.onChanged((next) => {
        this.#state = next
      }),
      Network.onChanged((next) => {
        this.#snapshot = next
      }),
      // Main asking for the dashboard: a notification or the tray menu was clicked.
      Network.onReveal((target) => nav.reveal(target.serviceId)),
      // Main asking to be caught up, which is what the Timeline is for: the one banner
      // raised for everything that happened while nobody was at the machine was clicked.
      Popover.onCatchUp(() => nav.open('timeline'))
    ]
    const stop = (): void => {
      for (const unsubscribe of stops) unsubscribe()
    }
    try {
      await Promise.all([
        State.get().then((state) => {
          this.#state = state
        }),
        Network.get().then((snapshot) => {
          this.#snapshot = snapshot
        }),
        Host.getPlatform().then((platform) => {
          this.#platform = platform
        })
      ])
    } catch (error) {
      stop()
      throw error
    }
    this.#ready = true
    return stop
  }

  /**
   * Run an IPC call, and hand back what it answered or why it failed.
   *
   * Main reports problems by throwing, and the generated client turns that into a
   * rejection, so every refusal arrives here — and goes back to whoever asked, to say
   * beside the control that asked. A call made in the background, where there is no
   * control to say it beside, can leave the outcome alone: the next push puts what is
   * true on screen whether or not the call got through.
   */
  async #ask<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
    try {
      return { ok: true, value: await fn() }
    } catch (error) {
      return { ok: false, error: ipcErrorMessage(error) }
    }
  }

  refresh(): Promise<Outcome<void>> {
    return this.#ask(() => bridge().Feed.refresh())
  }

  addAccount(input: string): Promise<Outcome<Account>> {
    return this.#ask(() => bridge().Accounts.add(input))
  }

  removeAccount(did: string): Promise<Outcome<void>> {
    return this.#ask(() => bridge().Accounts.remove(did))
  }

  patchAccount(did: string, patch: AccountPatch): Promise<Outcome<Account>> {
    return this.#ask(() => bridge().Accounts.patch(did, patch))
  }

  patchSettings(patch: Partial<Settings>): Promise<Outcome<Settings>> {
    return this.#ask(() => bridge().Preferences.patch(patch))
  }

  /** Both halves of an account's identity from either one, without tracking it. */
  lookUpActor(input: string): Promise<Outcome<ResolvedProfile>> {
    return this.#ask(() => bridge().Actors.resolve(input))
  }

  /**
   * Replace what the network checks read, or go back to the defaults with null.
   *
   * Check the document with `validateProbeTargets` first: the IPC boundary refuses an
   * invalid one too, but only with a sentence about the whole patch.
   */
  setProbeTargets(targets: ProbeTargets | null): Promise<Outcome<Settings>> {
    return this.#ask(() => bridge().Preferences.patch({ probeTargets: targets }))
  }

  /** Save the targets in force to a file the user picks: its name, or null if cancelled. */
  exportProbeTargets(): Promise<Outcome<string | null>> {
    return this.#ask(() => bridge().ProbeTargetsFile.save())
  }

  /** Read a file the user picks, unparsed, or null if they cancelled. */
  openProbeTargetsFile(): Promise<Outcome<OpenedFile | null>> {
    return this.#ask(() => bridge().ProbeTargetsFile.open())
  }

  markRead(uris: string[]): Promise<Outcome<void>> {
    return this.#ask(() => bridge().Feed.markRead(uris))
  }

  /** Mark one post, and everything older than it across every source, read. */
  markReadThrough(uri: string): Promise<Outcome<void>> {
    return this.#ask(() => bridge().Feed.markReadThrough(uri))
  }

  markAllRead(): Promise<Outcome<void>> {
    return this.#ask(() => bridge().Feed.markAllRead())
  }

  testNotification(): Promise<Outcome<void>> {
    return this.#ask(() => bridge().Host.sendTestNotification())
  }

  regenerateWebhookSecret(): Promise<Outcome<WebhookStatus>> {
    return this.#ask(() => bridge().Webhook.regenerateSecret())
  }

  /** Copy through main: the popover's own clipboard access dies with its focus. */
  copyText(text: string): Promise<Outcome<void>> {
    return this.#ask(() => bridge().Host.copyText(text))
  }

  /**
   * Sweep the network now. It answers once the sweep has started, not finished: a sweep
   * takes seconds, and the dashboard shows its own progress as it goes.
   */
  runNetworkChecks(): Promise<Outcome<void>> {
    return this.#ask(() => bridge().Network.run())
  }

  /**
   * Sweep only if the last one is older than `maxAgeMs` and none is running.
   *
   * Asked of nobody in particular — the popover coming to the front — so a refusal has
   * no control to be said beside, and the dashboard's own age line says the rest.
   */
  runNetworkChecksIfStale(maxAgeMs: number, now = Date.now()): void {
    const { running, finishedAt } = this.#snapshot
    if (!this.#state.settings.networkChecks || running) return
    if (finishedAt && now - Date.parse(finishedAt) < maxAgeMs) return
    void this.runNetworkChecks()
  }

  /**
   * Pass on what Chromium just told this page about the connection.
   *
   * The `online`/`offline` window events fire the moment the interface changes, where
   * the network checks would otherwise sit out their offline retry before noticing.
   * Main treats it as a hint and confirms it for itself, so there is nothing here to
   * report back and nothing worth interrupting the user over if the call itself fails —
   * the popover is not the reason the checks work.
   */
  reportOnline(online: boolean): void {
    void bridge()
      .Popover.online(online)
      .catch(() => undefined)
  }

  /**
   * Pass on whether the OS has asked for reduced motion.
   *
   * Fire-and-forget for the same reason as `reportOnline`: main has a safe default to
   * fall back on — it assumes reduced motion until told otherwise — so a failed call
   * leaves the tray quieter than the user asked for rather than louder, and there is
   * nothing here worth interrupting anybody with. See `$lib/motion.svelte`.
   */
  reportReducedMotion(reduce: boolean): void {
    void bridge()
      .Popover.reduceMotion(reduce)
      .catch(() => undefined)
  }

  /**
   * Right-click on an update: ask main for a menu the OS drew.
   *
   * Only the URI is sent. Main builds every label from the state it already owns, which
   * is what keeps a context menu from being a way for the page to put words of its own
   * in front of somebody. The one thing that can go wrong — the update having left the
   * feed between the click and the call — arrives as an outcome rather than an
   * unhandled rejection, and there is nothing to say about it: the card has gone too.
   */
  showPostMenu(uri: string): Promise<Outcome<void>> {
    return this.#ask(() => bridge().Popover.postMenu(uri))
  }

  openExternal(url: string): void {
    void bridge().Host.openExternal(url)
  }

  /** Dismiss the popover. Fire-and-forget: the window is going away either way. */
  hide(): void {
    void bridge().Host.hideWindow()
  }
}

export const app = new AppStore()
