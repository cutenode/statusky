import { MAX_STORED_POSTS } from '../shared/defaults'
import { sortPosts } from '../shared/bsky'
import { wantsBanner } from '../shared/notify'
import { sanitizeProbeTargets } from '../shared/probe-targets'
import type { Account, Settings, StatusPost } from '../shared/types'

/**
 * Pure state transitions for the feed. Kept free of Electron imports so the
 * interesting logic — dedupe, notification cursors, unread bookkeeping — is
 * unit-testable without booting an app.
 */

/** Newest post timestamp we have already notified about, per account DID. */
export type Cursors = Record<string, string>

/**
 * Merge freshly fetched posts into the cache.
 *
 * Incoming copies win on conflict so edits, counter changes and handle renames
 * propagate. Posts from accounts that are no longer tracked are dropped.
 */
export function mergePosts(
  existing: StatusPost[],
  incoming: StatusPost[],
  trackedDids: ReadonlySet<string>,
  cap: number = MAX_STORED_POSTS
): StatusPost[] {
  const byUri = new Map<string, StatusPost>()
  for (const post of existing) {
    if (trackedDids.has(post.authorDid)) byUri.set(post.uri, post)
  }
  for (const post of incoming) {
    if (trackedDids.has(post.authorDid)) byUri.set(post.uri, post)
  }
  return sortPosts([...byUri.values()]).slice(0, cap)
}

/**
 * Posts worth raising a notification for: newer than the account's cursor, and the kind
 * of update the user asked to hear about (see `wantsBanner`). Follow-ups are settled
 * afterwards by `applyFollowUps`, which needs to know which incidents are open.
 *
 * Using a timestamp cursor rather than a "have I seen this URI" set means a cold
 * start after the cache has been trimmed cannot re-notify about old incidents,
 * and an account's first sync never fires a burst of historical notifications.
 */
export function selectNotifiable(
  incoming: StatusPost[],
  cursors: Cursors,
  accounts: Account[],
  settings: Settings
): StatusPost[] {
  if (!settings.notificationsEnabled) return []

  const byDid = new Map(accounts.map((account) => [account.did, account]))

  return incoming
    .filter((post) => {
      const account = byDid.get(post.authorDid)
      if (!account || !wantsBanner(post, account, settings)) return false

      const cursor = cursors[post.authorDid]
      // No cursor means this account has never synced; seed silently instead.
      if (!cursor) return false

      const posted = Date.parse(post.createdAt)
      if (Number.isNaN(posted) || posted <= Date.parse(cursor)) return false

      return true
    })
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/** Move each account's cursor forward to its newest fetched post. Never rewinds. */
export function advanceCursors(cursors: Cursors, incoming: StatusPost[]): Cursors {
  const next: Cursors = { ...cursors }
  for (const post of incoming) {
    const posted = Date.parse(post.createdAt)
    if (Number.isNaN(posted)) continue
    const current = next[post.authorDid]
    if (!current || posted > Date.parse(current)) {
      next[post.authorDid] = post.createdAt
    }
  }
  return next
}

// ------------------------------------------------------------ read cursors

/**
 * How much of the feed has been read.
 *
 * Read state is a cursor per source rather than a list of unread URIs, for the same
 * reason the notification cursor is: a list has to be pruned as the post cache is
 * trimmed, and anything pruned out of it comes back as unread the next time that post
 * is fetched. A timestamp cannot resurrect an incident you dealt with last week.
 *
 * A pure cursor would mean reading one post also reads everything older from that
 * source, which is wrong for a feed you dip into — so posts read on their own, while
 * something older stayed unread, are remembered by URI in `above`. That set only ever
 * holds the ragged edge above each cursor: `compact` folds it back into the cursor the
 * moment the run below it is contiguous, so it stays small and self-clearing.
 */
export interface ReadState {
  /** Per source DID: everything of theirs at or before this timestamp has been read. */
  cursors: Cursors
  /** URIs read on their own, while something older from that source was still unread. */
  above: string[]
}

export const EMPTY_READ: ReadState = { cursors: {}, above: [] }

/**
 * Give any source that has a notification cursor but no read cursor the same one.
 *
 * Both cursors answer "what had we already seen before this batch", and both are seeded
 * at exactly the same moments: a polled account's first sync seeds silently, while a
 * pushed page and the network checks seed just under their first batch so its newest
 * entry announces itself. Deriving one from the other means that rule lives in one
 * place — and a source with no cursor at all has nothing unread, which is what makes
 * adding an account quiet.
 *
 * Call it with the cursors as they were *before* the batch was merged.
 */
export function seedReadCursors(read: ReadState, seen: Cursors): ReadState {
  const missing = Object.entries(seen).filter(([did]) => read.cursors[did] === undefined)
  if (!missing.length) return read
  return { ...read, cursors: { ...read.cursors, ...Object.fromEntries(missing) } }
}

/** Whether a post is still unread, given the cursors and the exceptions above them. */
function isUnread(post: StatusPost, cursors: Cursors, above: ReadonlySet<string>): boolean {
  const cursor = cursors[post.authorDid]
  // No cursor means this source has never been seen; its backlog is not news.
  if (!cursor) return false
  if (above.has(post.uri)) return false
  const posted = Date.parse(post.createdAt)
  return !Number.isNaN(posted) && posted > Date.parse(cursor)
}

/** The unread posts' URIs, in the order the posts were given (newest first). */
export function unreadUris(posts: StatusPost[], read: ReadState): string[] {
  const above = new Set(read.above)
  return posts.filter((post) => isUnread(post, read.cursors, above)).map((post) => post.uri)
}

/**
 * Fold `above` back into the cursors wherever it has become contiguous, and drop
 * whatever it no longer needs to remember.
 *
 * For each source, its posts above the cursor are walked oldest-first: every one that
 * has been read moves the cursor up and leaves the set. The walk stops at the first
 * unread post, because everything past it has to stay an exception. Anything left in
 * the set that is now at or below its cursor, belongs to a source with no cursor, or
 * whose post has aged out of the cache entirely, is dropped — in each case the post is
 * read by the cursor alone, or is not in the feed to be read.
 *
 * The walk moves a whole timestamp at a time rather than a post at a time. A cursor
 * cannot separate two posts stamped the same millisecond, so advancing onto one that
 * an unread post also carries would read that post as a side effect; they stay
 * exceptions instead until every post at that instant has been read.
 */
export function compactRead(read: ReadState, posts: StatusPost[]): ReadState {
  const above = new Set(read.above)
  const cursors: Cursors = { ...read.cursors }

  const bySource = new Map<string, StatusPost[]>()
  for (const post of posts) {
    if (cursors[post.authorDid] === undefined) continue
    const list = bySource.get(post.authorDid)
    if (list) list.push(post)
    else bySource.set(post.authorDid, [post])
  }

  for (const [did, source] of bySource) {
    const cursor = Date.parse(cursors[did]!)
    const pending = source
      .filter((post) => {
        const posted = Date.parse(post.createdAt)
        return !Number.isNaN(posted) && posted > cursor
      })
      .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

    for (let i = 0; i < pending.length;) {
      const at = pending[i]!.createdAt
      let end = i
      while (end < pending.length && pending[end]!.createdAt === at) end++

      const group = pending.slice(i, end)
      if (!group.every((post) => above.has(post.uri))) break

      cursors[did] = at
      for (const post of group) above.delete(post.uri)
      i = end
    }
  }

  const live = new Map(posts.map((post) => [post.uri, post]))
  const kept = [...above].filter((uri) => {
    const post = live.get(uri)
    if (!post) return false
    const cursor = cursors[post.authorDid]
    if (!cursor) return false
    const posted = Date.parse(post.createdAt)
    return !Number.isNaN(posted) && posted > Date.parse(cursor)
  })

  return { cursors, above: kept }
}

/** Mark individual posts read. Unknown URIs are ignored; the feed can be stale. */
export function markPostsRead(read: ReadState, uris: string[], posts: StatusPost[]): ReadState {
  const known = new Set(posts.map((post) => post.uri))
  const above = new Set(read.above)
  for (const uri of uris) {
    if (known.has(uri)) above.add(uri)
  }
  return compactRead({ ...read, above: [...above] }, posts)
}

/**
 * Mark everything read: every source's cursor moves to its newest cached post, and the
 * exceptions go with it.
 *
 * Sources with no cursor are left alone. Giving one a cursor here would pin the seed to
 * this moment, so an account added later would announce its whole backlog at once — the
 * burst the silent first sync exists to prevent.
 */
export function markAllPostsRead(read: ReadState, posts: StatusPost[]): ReadState {
  const cursors: Cursors = { ...read.cursors }
  for (const post of posts) {
    const current = cursors[post.authorDid]
    if (current === undefined) continue
    const posted = Date.parse(post.createdAt)
    if (Number.isNaN(posted) || posted <= Date.parse(current)) continue
    cursors[post.authorDid] = post.createdAt
  }
  return { cursors, above: [] }
}

/**
 * Mark one post and everything older than it read, across every source.
 *
 * The feed is one merged timeline, so "I have read back to here" is a statement about
 * a moment rather than about a source — which is exactly what a cursor per source can
 * express and a list of URIs cannot.
 */
export function markReadThrough(read: ReadState, uri: string, posts: StatusPost[]): ReadState {
  const target = posts.find((post) => post.uri === uri)
  if (!target) return read
  const through = Date.parse(target.createdAt)
  if (Number.isNaN(through)) return read

  const cursors: Cursors = { ...read.cursors }
  for (const [did, at] of Object.entries(cursors)) {
    if (through > Date.parse(at)) cursors[did] = target.createdAt
  }
  return compactRead({ ...read, cursors }, posts)
}

/**
 * Build read state from a flat list of unread URIs — the shape schema 3 persisted.
 *
 * Every source starts just under its oldest cached post, which puts all of them inside
 * the unread window; everything absent from the list is then marked read, and
 * `compactRead` folds what it can back into the cursors. The result badges exactly the
 * posts the list badged, expressed as something the post cache can no longer undo.
 *
 * Sources with no cached posts get no cursor, which is right: there is nothing of
 * theirs to have read, and a cursor invented here would announce their whole backlog
 * the next time they synced.
 */
export function readStateFromUnread(posts: StatusPost[], unread: readonly string[]): ReadState {
  const pending = new Set(unread)
  const cursors: Cursors = {}
  for (const post of posts) {
    const posted = Date.parse(post.createdAt)
    if (Number.isNaN(posted)) continue
    const current = cursors[post.authorDid]
    if (current === undefined || posted <= Date.parse(current)) {
      cursors[post.authorDid] = new Date(posted - 1).toISOString()
    }
  }

  const above = posts.map((post) => post.uri).filter((uri) => !pending.has(uri))
  return compactRead({ cursors, above }, posts)
}

/** Forget a source entirely: its cursor and any exceptions still pointing at it. */
export function forgetSource(read: ReadState, did: string, posts: StatusPost[]): ReadState {
  const cursors = { ...read.cursors }
  delete cursors[did]
  const gone = new Set(posts.filter((post) => post.authorDid === did).map((post) => post.uri))
  return { cursors, above: read.above.filter((uri) => !gone.has(uri)) }
}

export function upsertAccount(accounts: Account[], account: Account): Account[] {
  const index = accounts.findIndex((a) => a.did === account.did)
  if (index === -1) return [...accounts, account]
  const next = [...accounts]
  // Preserve `builtin` so re-adding a shipped account cannot make it removable.
  next[index] = { ...account, builtin: next[index]!.builtin || account.builtin }
  return next
}

export function patchAccount(
  accounts: Account[],
  did: string,
  patch: Partial<
    Pick<Account, 'notify' | 'muted' | 'handle' | 'displayName' | 'avatar' | 'description'>
  >
): Account[] {
  return accounts.map((account) => (account.did === did ? { ...account, ...patch } : account))
}

/**
 * The accounts a refresh should actually reach out for.
 *
 * Pushed sources and the network checks live in the same list and behave the same
 * everywhere else, but there is nothing to fetch for either: their entries arrive on
 * their own.
 */
export function pollableAccounts(accounts: Account[]): Account[] {
  return accounts.filter((account) => account.kind === 'atproto')
}

/** Visible posts for the feed: tracked, unmuted accounts only. */
export function visiblePosts(posts: StatusPost[], accounts: Account[]): StatusPost[] {
  const visible = new Set(accounts.filter((a) => !a.muted).map((a) => a.did))
  return posts.filter((p) => visible.has(p.authorDid))
}

/** Clamp user-supplied settings into supported ranges. */
export function sanitizeSettings(settings: Settings): Settings {
  return {
    ...settings,
    notifyProbeGraceSec: Math.min(Math.max(Math.round(settings.notifyProbeGraceSec) || 0, 0), 3600),
    // Order carries nothing, and duplicates would only make presets fail to match.
    notifySeverities: [...new Set(settings.notifySeverities)],
    notifySources: [...new Set(settings.notifySources)],
    pinnedServices: [...new Set(settings.pinnedServices)],
    pollIntervalSec: Math.min(Math.max(Math.round(settings.pollIntervalSec), 15), 3600),
    postsPerAccount: Math.min(Math.max(Math.round(settings.postsPerAccount), 5), 100),
    webhookPort: sanitizePort(settings.webhookPort),
    // A sweep is a hundred requests: no more often than once a minute.
    networkIntervalSec: Math.min(Math.max(Math.round(settings.networkIntervalSec), 60), 3600),
    // Normalised, or dropped with a warning if it is not valid; see `sanitizeProbeTargets`.
    probeTargets: sanitizeProbeTargets(settings.probeTargets)
  }
}

/**
 * Clamp the receiver's port into the unprivileged range.
 *
 * Zero is kept as-is and means "ask the OS for a free one" — useful in tests, and the
 * only value that is not a literal port number.
 */
function sanitizePort(port: number): number {
  const rounded = Math.round(port)
  if (!Number.isFinite(rounded) || rounded <= 0) return 0
  return Math.min(Math.max(rounded, 1024), 65535)
}
