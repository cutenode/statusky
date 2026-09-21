import { DEFAULT_SETTINGS } from '@shared/defaults'
import type {
  AccountPatch,
  Account,
  AppState,
  NetworkSnapshot,
  NetworkSummary,
  Settings,
  StatusPost,
  WebhookStatus
} from '@shared/types'
import {
  headline,
  isProbeSource,
  networkAsHealth,
  networkForHealth,
  type Headline
} from '@shared/network'
import { isWebhookSource } from '@shared/webhook'
import { deriveHealth, overallHealth, type Health } from '@shared/status'
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
    community: [],
    running: false,
    lastSweepAt: null
  },
  version: '0.0.0'
}

const EMPTY_SNAPSHOT: NetworkSnapshot = {
  running: false,
  startedAt: null,
  finishedAt: null,
  offline: false,
  services: []
}

/**
 * The renderer's single source of truth. The main process pushes whole `AppState`
 * snapshots; every mutation here is a request that comes back as another snapshot,
 * so the UI can never drift from what is actually persisted.
 */
class AppStore {
  #state = $state<AppState>(EMPTY)
  /** The network dashboard, which arrives on its own channel. */
  #snapshot = $state<NetworkSnapshot>(EMPTY_SNAPSHOT)
  #ready = $state(false)
  #busy = $state(false)
  /** Non-fatal errors from the last user action, shown inline. */
  #actionError = $state<string | null>(null)

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
  get busy(): boolean {
    return this.#busy
  }
  get actionError(): string | null {
    return this.#actionError
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
   * The feed split by where an update came from, which is what the tabs are.
   *
   * A status account writing a post and a status page pushing an incident are the same
   * kind of thing — somebody telling you what they have noticed — but a relay that
   * stopped answering our own requests is not: nobody said it, we measured it. Mixing
   * the three made one list where scanning for any of them meant reading all of them.
   *
   * `alerts` is everything that arrived unasked: pushed deliveries and the network
   * checks' findings, which share a tab because they share a shape — machine-filed,
   * terse, and about a service rather than about a plan.
   */
  #isAlert(post: StatusPost): boolean {
    return isWebhookSource(post.authorDid) || isProbeSource(post.authorDid)
  }

  /** Posts polled from AT Protocol status accounts. */
  feedPosts = $derived(this.#state.posts.filter((post) => !this.#isAlert(post)))

  /** Pushed status-page deliveries and the network checks' own entries. */
  alertPosts = $derived(this.#state.posts.filter((post) => this.#isAlert(post)))

  /** Unread across every source, newest first — what the Unread tab shows. */
  unreadPosts = $derived(this.#state.posts.filter((post) => this.#unreadSet.has(post.uri)))

  /** The sources behind each tab, for its filter chips. */
  feedAccounts = $derived(this.#state.accounts.filter((a) => a.kind === 'atproto'))
  alertAccounts = $derived(this.#state.accounts.filter((a) => a.kind !== 'atproto'))

  #countUnread(posts: StatusPost[]): number {
    return posts.reduce((n, post) => (this.#unreadSet.has(post.uri) ? n + 1 : n), 0)
  }

  feedUnreadCount = $derived(this.#countUnread(this.feedPosts))
  alertUnreadCount = $derived(this.#countUnread(this.alertPosts))

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

  /** The status accounts' and the network checks' verdicts, combined into one line. */
  headline: Headline = $derived.by(() => {
    const reported = overallHealth(
      this.#state.accounts
        .filter((a) => !a.muted && !isProbeSource(a.did))
        .map((a) => this.healthByAccount.get(a.did) ?? 'unknown')
    )
    return headline(reported, networkForHealth(this.#state.accounts, this.#state.network))
  })

  get overall(): Health {
    return this.headline.health
  }

  /**
   * Whether anything older than this post is still unread, which is what makes
   * "mark read to here" worth offering on it rather than on every post in the feed.
   */
  hasUnreadBelow(post: StatusPost): boolean {
    const through = Date.parse(post.createdAt)
    return this.#state.posts.some(
      (other) => this.#unreadSet.has(other.uri) && Date.parse(other.createdAt) < through
    )
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
    this.#ready = false
    this.#busy = false
    this.#actionError = null
  }

  async init(): Promise<() => void> {
    const { State, Network } = bridge()
    const [state, snapshot] = await Promise.all([State.get(), Network.get()])
    this.#state = state
    this.#snapshot = snapshot
    this.#ready = true
    const stops = [
      State.onChanged((next) => {
        this.#state = next
      }),
      Network.onChanged((next) => {
        this.#snapshot = next
      }),
      // Main asking for the dashboard: a notification or the tray menu was clicked.
      Network.onReveal((target) => nav.reveal(target.serviceId))
    ]
    return () => {
      for (const stop of stops) stop()
    }
  }

  /**
   * Run an IPC call, surfacing failures as `actionError` rather than throwing.
   * Main reports problems by throwing, and the generated client turns that into a
   * rejection, so every user-visible failure arrives here.
   */
  async #run<T>(fn: () => Promise<T>): Promise<T | null> {
    this.#busy = true
    this.#actionError = null
    try {
      return await fn()
    } catch (error) {
      this.#actionError = ipcErrorMessage(error)
      return null
    } finally {
      this.#busy = false
    }
  }

  clearError(): void {
    this.#actionError = null
  }

  refresh(): Promise<void | null> {
    return this.#run(() => bridge().Feed.refresh())
  }

  addAccount(input: string): Promise<Account | null> {
    return this.#run(() => bridge().Accounts.add(input))
  }

  removeAccount(did: string): Promise<void | null> {
    return this.#run(() => bridge().Accounts.remove(did))
  }

  patchAccount(did: string, patch: AccountPatch): Promise<Account | null> {
    return this.#run(() => bridge().Accounts.patch(did, patch))
  }

  patchSettings(patch: Partial<Settings>): Promise<Settings | null> {
    return this.#run(() => bridge().Preferences.patch(patch))
  }

  markRead(uris: string[]): Promise<void | null> {
    return this.#run(() => bridge().Feed.markRead(uris))
  }

  /** Mark one post, and everything older than it across every source, read. */
  markReadThrough(uri: string): Promise<void | null> {
    return this.#run(() => bridge().Feed.markReadThrough(uri))
  }

  markAllRead(): Promise<void | null> {
    return this.#run(() => bridge().Feed.markAllRead())
  }

  testNotification(): Promise<void | null> {
    return this.#run(() => bridge().Host.sendTestNotification())
  }

  regenerateWebhookSecret(): Promise<WebhookStatus | null> {
    return this.#run(() => bridge().Webhook.regenerateSecret())
  }

  /** Copy through main: the popover's own clipboard access dies with its focus. */
  copyText(text: string): Promise<void | null> {
    return this.#run(() => bridge().Host.copyText(text))
  }

  /**
   * Sweep the network now. Not routed through `#run`: a sweep takes seconds, and the
   * dashboard shows its own progress rather than holding the whole UI busy.
   */
  runNetworkChecks(): void {
    void bridge()
      .Network.run()
      .catch((error: unknown) => {
        this.#actionError = ipcErrorMessage(error)
      })
  }

  /** Sweep only if the last one is older than `maxAgeMs` and none is running. */
  runNetworkChecksIfStale(maxAgeMs: number, now = Date.now()): void {
    const { running, finishedAt } = this.#snapshot
    if (!this.#state.settings.networkChecks || running) return
    if (finishedAt && now - Date.parse(finishedAt) < maxAgeMs) return
    this.runNetworkChecks()
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
