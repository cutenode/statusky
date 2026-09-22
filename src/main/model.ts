import { EventEmitter } from 'node:events'
import type ElectronStore from 'electron-store'
import { BskyError, fetchAuthorPosts, fetchProfiles, resolveActor } from '../shared/bsky'
import { MAX_WEBHOOK_SOURCES } from '../shared/defaults'
import { PROBE_SOURCE_DID, probeAccount, probePost, type ProbeEvent } from '../shared/network'
import {
  isWebhookSource,
  parseWebhookDelivery,
  webhookAccount,
  type WebhookSource
} from '../shared/webhook'
import type {
  Account,
  AppState,
  LoginItemStatus,
  NetworkSnapshot,
  ResolvedProfile,
  Settings,
  ShortcutStatus,
  StatusPost,
  SweepRestraint,
  SyncStatus,
  UpdateStatus,
  WebhookStatus
} from '../shared/types'
import {
  advanceCursors,
  compactRead,
  forgetSource,
  markAllPostsRead,
  markPostsRead,
  markReadThrough,
  mergePosts,
  patchAccount,
  pollableAccounts,
  sanitizeSettings,
  seedReadCursors,
  selectNotifiable,
  unreadUris,
  upsertAccount,
  visiblePosts,
  type Cursors,
  type ReadState
} from './state'
import { NetworkMonitor, type MonitorTimings } from './network'
import type { ProbeTransport } from './probes'
import { readWebhookSecret, writeWebhookSecret, type PersistedShape } from './store'
import { generateWebhookSecret, WebhookReceiver } from './webhook'

export interface ModelEvents {
  change: [AppState]
  notify: [StatusPost[]]
  /** The network dashboard changed. Frequent while a sweep runs; see `NetworkMonitor`. */
  network: [NetworkSnapshot]
}

export interface ModelOptions {
  /**
   * How the network checks reach the outside world. Without one, nothing is probed and
   * the dashboard stays empty — which is what every test that is not about the checks
   * wants, since the alternative is real traffic.
   */
  network?: {
    transport: ProbeTransport
    timings?: Partial<MonitorTimings>
    now?: () => number
  }
}

/** How long a single account's fetch may take before we give up on it. */
const FETCH_TIMEOUT_MS = 15_000

/**
 * Owns all application state. The renderer never touches the network or disk —
 * it calls into here over IPC and receives whole-state pushes back.
 */
export class Model extends EventEmitter<ModelEvents> {
  private timer: NodeJS.Timeout | null = null
  /** The machine is asleep: both schedules are down until `resume()`. See `pause()`. */
  private paused = false
  private inFlight: Promise<void> | null = null
  private sync: AppState['sync'] = { status: 'idle', lastSyncedAt: null, error: null }
  /**
   * What the OS has actually done with `launchAtLogin`. Owned here rather than derived,
   * because only the startup wiring in src/main/index.ts ever talks to the OS about it;
   * this is where the answer it got is kept so the popover can see it.
   */
  private loginItem: LoginItemStatus = { registered: false, error: null }
  /** And likewise for the global shortcut, which the OS may hand to somebody else. */
  private shortcut: ShortcutStatus = { registered: false, error: null }
  /**
   * And likewise for whether there is a newer Statusky than this one. Starts at
   * `current`, which is also what it stays at when nothing can find out — see
   * `UpdateStatus`, where the two are deliberately the same answer.
   */
  private update: UpdateStatus = { stage: 'current', version: null }
  private readonly receiver: WebhookReceiver
  private readonly monitor: NetworkMonitor

  constructor(
    private readonly store: ElectronStore<PersistedShape>,
    private readonly version: string,
    options: ModelOptions = {}
  ) {
    super()
    this.receiver = new WebhookReceiver({
      // Read through to the store rather than capturing: regenerating the secret has
      // to invalidate the old URL for the very next request. The store answers from
      // memory after the first call, so this costs nothing per request even though the
      // secret is sealed in the OS credential store on disk — and because it is a
      // callback rather than a value, nothing opens that store until a receiver is
      // actually running. Constructing a `Model` with the webhook off never does.
      secret: () => readWebhookSecret(this.store),
      onDelivery: (body) => this.ingestWebhook(body)
    })
    this.monitor = new NetworkMonitor({
      transport: options.network?.transport ?? null,
      timings: options.network?.timings,
      now: options.network?.now,
      onSnapshot: (snapshot) => this.emit('network', snapshot),
      onSummaryChange: () => this.emitChange(),
      onEvents: (events) => this.ingestProbeEvents(events)
    })
  }

  // ---------------------------------------------------------------- state

  get accounts(): Account[] {
    return this.store.get('accounts')
  }

  get settings(): Settings {
    return this.store.get('settings')
  }

  getState(): AppState {
    const accounts = this.accounts
    const posts = visiblePosts(this.store.get('posts'), accounts)
    return {
      accounts,
      posts,
      settings: this.settings,
      // Unread is derived, not stored: the cursors are the state, and a muted source's
      // posts are not in `posts`, so they drop out of the count without being read.
      unread: unreadUris(posts, this.read),
      sync: this.sync,
      webhook: this.receiver.status(),
      network: this.monitor.summary(this.settings.networkChecks),
      loginItem: this.loginItem,
      shortcut: this.shortcut,
      update: this.update,
      version: this.version
    }
  }

  /** Count of unread posts from accounts that are currently visible. */
  get unreadCount(): number {
    return this.getState().unread.length
  }

  /**
   * Of `posts`, the ones the user has still not dealt with.
   *
   * Asked before a banner held back while nobody was at the machine is finally raised:
   * an update read in the popover in the meantime has been dealt with, and announcing it
   * afterwards would be the notification resurrecting it. A muted source's posts are not
   * in `unread` either, so muting one while its banner was held also settles it.
   */
  stillUnread(posts: StatusPost[]): StatusPost[] {
    const unread = new Set(this.getState().unread)
    return posts.filter((post) => unread.has(post.uri))
  }

  /**
   * Record what the OS said when it was asked to open Statusky at login.
   *
   * Called from the `change` handler in src/main/index.ts, which is where the OS is
   * talked to — so this can re-enter the very event it is being called from. The
   * equality check is what stops that: the second pass finds the same status and
   * emits nothing, and the run terminates one level deep. It is also why a status
   * that has not moved costs nothing, which matters because the settings change on
   * every poll.
   */
  setLoginItem(status: LoginItemStatus): void {
    if (status.registered === this.loginItem.registered && status.error === this.loginItem.error) {
      return
    }
    this.loginItem = status
    this.emitChange()
  }

  /**
   * Record what the OS did with `Settings.globalShortcut`.
   *
   * Exactly `setLoginItem`'s shape and for exactly its reason: called from the `change`
   * handler in src/main/index.ts, so it can re-enter the event it is being called from,
   * and the equality check is what stops that one level deep. See `ShortcutStatus`.
   */
  setShortcut(status: ShortcutStatus): void {
    if (status.registered === this.shortcut.registered && status.error === this.shortcut.error) {
      return
    }
    this.shortcut = status
    this.emitChange()
  }

  /**
   * Record that there is — or is no longer — a newer Statusky to be had.
   *
   * The third of the same shape as `setLoginItem` and `setShortcut`, and it keeps their
   * equality check for a different reason: this one is not called from inside a `change`
   * handler, but it is called from a timer that fires every few hours and almost always
   * finds exactly what it found last time. Without the check, every install would push a
   * whole `AppState` to the popover four times a day to say nothing had happened.
   */
  setUpdate(status: UpdateStatus): void {
    if (status.stage === this.update.stage && status.version === this.update.version) return
    this.update = status
    this.emitChange()
  }

  private emitChange(): void {
    this.emit('change', this.getState())
  }

  private get read(): ReadState {
    return this.store.get('read')
  }

  // ------------------------------------------------------------- mutation

  async addAccount(input: string): Promise<Account> {
    const profile = await resolveActor(input)
    const existing = this.accounts.find((a) => a.did === profile.did)
    if (existing) {
      // Re-adding a muted account is the natural way to say "show this again".
      if (existing.muted) {
        this.store.set('accounts', patchAccount(this.accounts, profile.did, { muted: false }))
        this.emitChange()
        void this.refresh()
        return this.accounts.find((a) => a.did === profile.did)!
      }
      throw new BskyError(`@${existing.handle} is already being tracked.`)
    }

    const account: Account = {
      did: profile.did,
      handle: profile.handle,
      displayName: profile.displayName,
      avatar: profile.avatar,
      description: profile.description,
      notify: true,
      muted: false,
      addedAt: new Date().toISOString(),
      builtin: false,
      kind: 'atproto'
    }

    this.store.set('accounts', upsertAccount(this.accounts, account))
    this.emitChange()
    void this.refresh()
    return account
  }

  removeAccount(did: string): void {
    const account = this.accounts.find((a) => a.did === did)
    if (!account) throw new Error('That account is not being tracked.')
    if (account.builtin) throw new Error('Built-in status accounts can be muted but not removed.')

    this.store.set(
      'accounts',
      this.accounts.filter((a) => a.did !== did)
    )
    this.store.set(
      'posts',
      this.store.get('posts').filter((p) => p.authorDid !== did)
    )
    const cursors = { ...this.store.get('cursors') }
    delete cursors[did]
    this.store.set('cursors', cursors)
    this.store.set('read', forgetSource(this.read, did, this.store.get('posts')))
    this.emitChange()
  }

  patchAccount(did: string, patch: Partial<Pick<Account, 'notify' | 'muted'>>): Account {
    if (!this.accounts.some((a) => a.did === did)) {
      throw new Error('That account is not being tracked.')
    }
    this.store.set('accounts', patchAccount(this.accounts, did, patch))
    this.emitChange()
    return this.accounts.find((a) => a.did === did)!
  }

  patchSettings(patch: Partial<Settings>): Settings {
    const previous = this.settings
    const next = sanitizeSettings({ ...previous, ...patch })
    this.store.set('settings', next)

    if (next.pollIntervalSec !== previous.pollIntervalSec) this.restartTimer()
    if (
      next.networkChecks !== previous.networkChecks ||
      next.networkIntervalSec !== previous.networkIntervalSec
    ) {
      this.configureNetwork()
    }
    if (
      next.webhookEnabled !== previous.webhookEnabled ||
      next.webhookPort !== previous.webhookPort
    ) {
      // Binding a socket is slow enough to outlive this call; it pushes its own
      // state once it knows whether it worked.
      void this.applyWebhookSettings()
    }
    this.emitChange()
    return next
  }

  markRead(uris: string[]): void {
    if (!uris.length) return
    this.store.set('read', markPostsRead(this.read, uris, this.store.get('posts')))
    this.emitChange()
  }

  /** Mark one post, and everything older than it across every source, read. */
  markReadThrough(uri: string): void {
    this.store.set('read', markReadThrough(this.read, uri, this.store.get('posts')))
    this.emitChange()
  }

  markAllRead(): void {
    if (!this.unreadCount) return
    this.store.set('read', markAllPostsRead(this.read, this.store.get('posts')))
    this.emitChange()
  }

  async resolveActor(input: string): Promise<ResolvedProfile> {
    return resolveActor(input)
  }

  // ----------------------------------------------------------------- sync

  /** Refresh every tracked account. Concurrent calls share one in-flight run. */
  async refresh(): Promise<void> {
    this.inFlight ??= this.runSync().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async runSync(): Promise<void> {
    // Pushed sources are tracked like any other, but there is nothing to fetch for
    // one — so they neither trigger a sync nor count towards its failure.
    const accounts = pollableAccounts(this.accounts)
    if (!accounts.length) {
      this.sync = { status: 'idle', lastSyncedAt: new Date().toISOString(), error: null }
      this.emitChange()
      return
    }

    this.sync = { ...this.sync, status: 'syncing', error: null }
    this.emitChange()

    const settings = this.settings
    const results = await Promise.allSettled(
      accounts.map((account) => this.fetchOne(account, settings.postsPerAccount))
    )

    const incoming: StatusPost[] = []
    const failures: string[] = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        incoming.push(...result.value)
      } else {
        const handle = accounts[index]?.handle ?? 'unknown'
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        failures.push(`@${handle}: ${reason}`)
      }
    })

    const cursors: Cursors = this.store.get('cursors')
    const notifiable = selectNotifiable(incoming, cursors, accounts, settings)
    // Seed against the cursors as they were: a source seen for the first time has its
    // read cursor placed exactly where its notification cursor is, so its backlog
    // arrives read and only what comes after it is news.
    const read = seedReadCursors(this.read, cursors)

    // Every tracked source, not just the polled ones: `mergePosts` drops posts whose
    // author is not in this set, which would discard the whole webhook feed.
    const tracked = new Set(this.accounts.map((a) => a.did))
    const posts = mergePosts(this.store.get('posts'), incoming, tracked)

    this.store.set('posts', posts)
    this.store.set('cursors', advanceCursors(cursors, incoming))
    this.store.set('read', compactRead(read, posts))

    // A partial failure still counts as a successful sync for the accounts that worked.
    this.sync = {
      status: failures.length === accounts.length ? 'error' : 'idle',
      lastSyncedAt:
        incoming.length || failures.length < accounts.length
          ? new Date().toISOString()
          : this.sync.lastSyncedAt,
      error: failures.length ? failures.join('\n') : null
    }

    void this.refreshProfiles(accounts)
    this.emitChange()

    if (notifiable.length) this.emit('notify', notifiable)
  }

  private async fetchOne(account: Account, limit: number): Promise<StatusPost[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      return await fetchAuthorPosts(account.did, limit, { signal: controller.signal })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BskyError('Timed out')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Keep handles, display names and avatars current. Best-effort; never fails a sync. */
  private async refreshProfiles(accounts: Account[]): Promise<void> {
    try {
      const profiles = await fetchProfiles(accounts.map((a) => a.did))
      if (!profiles.length) return

      let next = this.accounts
      let changed = false
      for (const profile of profiles) {
        const current = next.find((a) => a.did === profile.did)
        if (!current) continue
        if (
          current.handle === profile.handle &&
          current.displayName === profile.displayName &&
          current.avatar === profile.avatar &&
          current.description === profile.description
        ) {
          continue
        }
        next = patchAccount(next, profile.did, {
          handle: profile.handle,
          displayName: profile.displayName,
          avatar: profile.avatar,
          description: profile.description
        })
        changed = true
      }

      if (changed) {
        this.store.set('accounts', next)
        this.emitChange()
      }
    } catch {
      // Profile metadata is cosmetic; a failure here must not surface as a sync error.
    }
  }

  // -------------------------------------------------------------- webhooks

  get webhookStatus(): WebhookStatus {
    return this.receiver.status()
  }

  /** Start or stop the receiver to match the current settings, then push the result. */
  private async applyWebhookSettings(): Promise<void> {
    const { webhookEnabled, webhookPort } = this.settings
    if (webhookEnabled) await this.receiver.start(webhookPort)
    else await this.receiver.stop()
    this.emitChange()
  }

  /**
   * Mint a new endpoint secret, which immediately invalidates the old URL.
   *
   * The receiver reads the secret per request, so nothing has to be rebound — but
   * every status page subscribed to the old URL now needs the new one, which is the
   * point of the button.
   */
  regenerateWebhookSecret(): WebhookStatus {
    writeWebhookSecret(this.store, generateWebhookSecret())
    this.emitChange()
    return this.receiver.status()
  }

  /**
   * File one delivery into the feed.
   *
   * A status page pushes its whole update history every time, so the work is the same
   * as a sync of one account: register the source if it is new, merge, move the
   * cursor, and notify about whatever the cursor had not already covered. Redeliveries
   * are therefore free — each entry's URI comes from the update's own id, so they land
   * on the posts already stored and fall behind the cursor.
   */
  ingestWebhook(body: unknown): void {
    const delivery = parseWebhookDelivery(body)
    if (!delivery) {
      // Still push: the delivery counter in the settings panel is how a user tells
      // that their tunnel reaches the app at all.
      this.emitChange()
      return
    }

    const registered = this.registerSource(delivery.source, delivery.posts)
    if (!registered) {
      this.emitChange()
      return
    }

    this.fileEntries(delivery.posts)
  }

  /**
   * File entries that arrived on their own — a webhook delivery, or the network checks
   * confirming a change — exactly as a sync files polled posts: merge them, move the
   * source's cursor, and mark and notify whatever the cursor had not already covered.
   */
  private fileEntries(entries: StatusPost[]): void {
    const accounts = this.accounts
    const cursors: Cursors = this.store.get('cursors')
    const notifiable = selectNotifiable(entries, cursors, accounts, this.settings)
    const read = seedReadCursors(this.read, cursors)

    const tracked = new Set(accounts.map((a) => a.did))
    const posts = mergePosts(this.store.get('posts'), entries, tracked)

    this.store.set('posts', posts)
    this.store.set('cursors', advanceCursors(cursors, entries))
    this.store.set('read', compactRead(read, posts))
    this.emitChange()

    if (notifiable.length) this.emit('notify', notifiable)
  }

  /**
   * Make sure the page behind a delivery is a tracked source, and return whether it
   * is one we are willing to accept posts for.
   *
   * The endpoint is protected by an unguessable secret, but anything that has it can
   * claim to be any number of status pages, so registration is capped.
   */
  private registerSource(source: WebhookSource, posts: StatusPost[]): boolean {
    const accounts = this.accounts
    const existing = accounts.find((a) => a.did === source.id)

    if (existing) {
      // A page can be renamed or move host; keep what the user sees current.
      if (existing.handle !== source.host || existing.description !== source.description) {
        this.store.set(
          'accounts',
          patchAccount(accounts, source.id, {
            handle: source.host,
            displayName: source.host,
            description: source.description
          })
        )
      }
      return true
    }

    if (accounts.filter((a) => isWebhookSource(a.did)).length >= MAX_WEBHOOK_SOURCES) return false

    this.store.set(
      'accounts',
      upsertAccount(accounts, webhookAccount(source, new Date().toISOString()))
    )

    // Seed the cursor just under the newest entry in this first delivery. A polled
    // account seeds silently because its whole history arrives at once and none of it
    // is news; a webhook delivery *is* the news, so the newest update announces itself
    // while the incident's backlog behind it stays quiet.
    // `parseWebhookDelivery` never hands back an empty list, and every entry it
    // produces carries a timestamp that parses, so there is always a newest.
    const newest = Math.max(...posts.map((post) => Date.parse(post.createdAt)))
    this.store.set('cursors', {
      ...this.store.get('cursors'),
      [source.id]: new Date(newest - 1).toISOString()
    })
    return true
  }

  // --------------------------------------------------------- network checks

  networkSnapshot(): NetworkSnapshot {
    return this.monitor.snapshot()
  }

  /** Sweep every service now; resolves when the sweep has finished. */
  runNetworkChecks(): Promise<void> {
    return this.monitor.run()
  }

  private configureNetwork(): void {
    const { networkChecks, networkIntervalSec } = this.settings
    this.monitor.configure({ enabled: networkChecks, intervalSec: networkIntervalSec })
  }

  /** Tell the sweep schedule what the machine's own condition is. See `SweepRestraint`. */
  restrainNetwork(restraint: SweepRestraint | null): void {
    this.monitor.restrain(restraint)
  }

  /**
   * Something outside the checks says the connection is back — see `Popover.online` in
   * `schemas/statusky.eipc`. Nothing here trusts the claim; the control checks settle it.
   */
  recheckConnection(): void {
    this.monitor.connectionRestored()
  }

  /**
   * File the checks' confirmed changes as feed entries from their own source, which
   * registers itself the first time there is something to say — as a pushed status
   * page does — so a user who has never seen an outage never sees an empty source.
   */
  private ingestProbeEvents(events: ProbeEvent[]): void {
    const entries = events.map(probePost)
    if (!this.accounts.some((a) => a.did === PROBE_SOURCE_DID)) {
      this.store.set(
        'accounts',
        upsertAccount(this.accounts, probeAccount(new Date().toISOString()))
      )
      // Seed the cursor just under this first batch, which is news in its entirety: a
      // measured outage is never a backlog.
      const oldest = Math.min(...entries.map((entry) => Date.parse(entry.createdAt)))
      this.store.set('cursors', {
        ...this.store.get('cursors'),
        [PROBE_SOURCE_DID]: new Date(oldest - 1).toISOString()
      })
    }
    this.fileEntries(entries)
  }

  // ---------------------------------------------------------------- timer

  start(): void {
    this.restartTimer()
    void this.applyWebhookSettings()
    this.configureNetwork()
    void this.refresh()
  }

  stop(): void {
    this.clearTimer()
    void this.receiver.stop()
    this.monitor.stop()
  }

  /**
   * Put both schedules down while the machine is away, and nothing else.
   *
   * Deliberately not `stop()`: the webhook receiver has to keep its socket, because a
   * status page pushing an update to a machine that is merely asleep should find the
   * port still bound when it wakes — and `stop()` taking the receiver and the network
   * checks down with it is the exact mistake `restartTimer` already exists to avoid.
   * What has to stop is the two `setInterval`s, which do not sleep with the machine.
   */
  pause(): void {
    this.paused = true
    this.clearTimer()
    this.monitor.pause()
  }

  /** Both schedules back. Catching up on what was missed is the caller's to ask for. */
  resume(): void {
    this.paused = false
    this.restartTimer()
    this.monitor.resume()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Only the poll timer: changing how often to poll must not take the webhook receiver
   * or the network checks down with it, as calling `stop()` here once did.
   */
  private restartTimer(): void {
    this.clearTimer()
    // A settings change while the machine is asleep must not start polling again; the
    // new interval is picked up by `resume()`, which is the thing that restarts it.
    if (this.paused) return
    this.timer = setInterval(() => void this.refresh(), this.settings.pollIntervalSec * 1000)
    // Polling should not hold the event loop open on quit.
    this.timer.unref?.()
  }

  get syncStatus(): SyncStatus {
    return this.sync.status
  }
}
