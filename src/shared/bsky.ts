import { PUBLIC_APPVIEW } from './defaults'
import { segmentRichText } from './richtext'
import { classifySeverity } from './status'
import type { PostEmbed, ResolvedProfile, StatusPost } from './types'

export class BskyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'BskyError'
  }
}

/** Minimal structural types for the slices of the AppView responses we read. */
interface RawAuthor {
  did?: string
  handle?: string
  displayName?: string
  avatar?: string
  description?: string
  followersCount?: number
  postsCount?: number
}

/**
 * A record as a view carries it. The lexicon types `postView.record` and
 * `embed.record#viewRecord.value` as `unknown` — they are the author's own record, passed
 * through as written — so nothing here is promised, and each field is narrowed where it
 * is read rather than trusted to be what a post's would be.
 */
interface RawRecord {
  $type?: unknown
  text?: unknown
  createdAt?: unknown
  facets?: unknown
  reply?: unknown
}

interface RawPost {
  uri?: string
  cid?: string
  author?: RawAuthor
  record?: RawRecord
  embed?: Record<string, unknown>
  indexedAt?: string
  replyCount?: number
  repostCount?: number
  likeCount?: number
}

interface RawFeedItem {
  post?: RawPost
  /**
   * Present when the item is a repost rather than the author's own post. The union also
   * has `#reasonPin`, but pins only come back when `includePins` is asked for, and this
   * never asks.
   */
  reason?: unknown
  reply?: unknown
}

export interface FetchOptions {
  service?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

async function xrpc<T>(
  method: string,
  params: Record<string, string | number | string[]>,
  options: FetchOptions = {}
): Promise<T> {
  const service = options.service ?? PUBLIC_APPVIEW
  const url = new URL(`/xrpc/${method}`, service)
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v)
    } else {
      url.searchParams.set(key, String(value))
    }
  }

  const doFetch = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: options.signal ?? null
    })
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw cause
    // A rejected fetch is not obliged to hand us an `Error`; anything else still has
    // to read as something, or the sync-error banner says "undefined".
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new BskyError(`Network request failed: ${detail}`, undefined, { cause })
  }

  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = (await response.json()) as { message?: string; error?: string }
      detail = body.message ?? body.error ?? detail
    } catch {
      // Non-JSON error body; the status text is all we have.
    }
    throw new BskyError(detail || `Request failed with ${response.status}`, response.status)
  }

  return (await response.json()) as T
}

function normalizeEmbed(embed: Record<string, unknown> | undefined): PostEmbed | null {
  if (!embed || typeof embed.$type !== 'string') return null

  if (embed.$type === 'app.bsky.embed.external#view') {
    const ext = embed.external as
      { uri?: string; title?: string; description?: string; thumb?: string } | undefined
    if (!ext?.uri) return null
    return {
      kind: 'external',
      uri: ext.uri,
      title: ext.title ?? ext.uri,
      description: ext.description ?? '',
      thumb: ext.thumb ?? null
    }
  }

  if (embed.$type === 'app.bsky.embed.images#view') {
    const images =
      (embed.images as { thumb?: string; fullsize?: string; alt?: string }[] | undefined) ?? []
    const mapped = images
      .filter((i) => i.thumb && i.fullsize)
      .map((i) => ({ thumb: i.thumb!, fullsize: i.fullsize!, alt: i.alt ?? '' }))
    return mapped.length ? { kind: 'images', images: mapped } : null
  }

  if (embed.$type === 'app.bsky.embed.recordWithMedia#view') {
    return normalizeEmbed(embed.media as Record<string, unknown> | undefined)
  }

  if (embed.$type === 'app.bsky.embed.record#view') {
    // `record` is a union, and every member of it has a `uri`: a quote that was deleted
    // (`#viewNotFound`), blocked or detached, and an embedded feed, list, labeler or
    // starter pack, as well as a post. Only `#viewRecord` has an author and text to show.
    const record = embed.record as
      { $type?: string; uri?: string; author?: RawAuthor; value?: RawRecord } | undefined
    if (record?.$type !== 'app.bsky.embed.record#viewRecord' || !record.uri) return null
    const text = record.value?.text
    return {
      kind: 'record',
      uri: record.uri,
      author: record.author?.handle ?? 'unknown',
      text: typeof text === 'string' ? text : ''
    }
  }

  return null
}

/** `at://did:plc:xxx/app.bsky.feed.post/3abc` -> `3abc` */
export function rkeyFromUri(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1)
}

export function postPermalink(handle: string, uri: string): string {
  return `https://bsky.app/profile/${handle}/post/${rkeyFromUri(uri)}`
}

/**
 * Convert an AppView post view into our flat shape.
 * Returns null for anything that is not a first-party `app.bsky.feed.post`.
 */
export function normalizePost(raw: RawPost | undefined): StatusPost | null {
  if (!raw?.uri || !raw.cid || !raw.author?.did || !raw.record) return null
  if (raw.record.$type !== 'app.bsky.feed.post') return null

  // One post that is not what its `$type` says must not throw, or it takes every other
  // post from the same account down with it.
  const { text: rawText, createdAt: rawCreatedAt, facets } = raw.record
  const text = typeof rawText === 'string' ? rawText : ''
  const handle = raw.author.handle ?? raw.author.did
  const createdAt =
    typeof rawCreatedAt === 'string' ? rawCreatedAt : (raw.indexedAt ?? new Date(0).toISOString())

  return {
    uri: raw.uri,
    cid: raw.cid,
    rkey: rkeyFromUri(raw.uri),
    authorDid: raw.author.did,
    authorHandle: handle,
    authorDisplayName: raw.author.displayName || handle,
    authorAvatar: raw.author.avatar ?? null,
    text,
    segments: segmentRichText(text, facets),
    embed: normalizeEmbed(raw.embed),
    createdAt,
    indexedAt: raw.indexedAt ?? createdAt,
    severity: classifySeverity(text),
    replyCount: raw.replyCount ?? 0,
    repostCount: raw.repostCount ?? 0,
    likeCount: raw.likeCount ?? 0,
    url: postPermalink(handle, raw.uri)
  }
}

/** Newest first, by record timestamp, with the AppView index time as a tie-breaker. */
export function sortPosts(posts: StatusPost[]): StatusPost[] {
  return posts.toSorted((a, b) => {
    const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt)
    if (delta !== 0 && !Number.isNaN(delta)) return delta
    return Date.parse(b.indexedAt) - Date.parse(a.indexedAt)
  })
}

/** Fetch an account's own top-level posts, excluding replies and reposts. */
export async function fetchAuthorPosts(
  actor: string,
  limit: number,
  options: FetchOptions = {}
): Promise<StatusPost[]> {
  const data = await xrpc<{ feed?: RawFeedItem[] }>(
    'app.bsky.feed.getAuthorFeed',
    { actor, limit: Math.min(Math.max(limit, 1), 100), filter: 'posts_no_replies' },
    options
  )

  const posts: StatusPost[] = []
  for (const item of data.feed ?? []) {
    // `reason` marks a repost of somebody else's post; we only want first-party updates.
    if (item.reason) continue
    if (item.post?.record?.reply) continue
    const post = normalizePost(item.post)
    if (post) posts.push(post)
  }
  return sortPosts(posts)
}

function toResolvedProfile(raw: RawAuthor | undefined): ResolvedProfile | null {
  if (!raw?.did || !raw.handle) return null
  return {
    did: raw.did,
    handle: raw.handle,
    displayName: raw.displayName || raw.handle,
    avatar: raw.avatar ?? null,
    description: raw.description ?? null,
    followersCount: raw.followersCount ?? 0,
    postsCount: raw.postsCount ?? 0
  }
}

/** Accepts a handle, a DID, or a bsky.app profile URL. */
export function parseActorInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''

  const urlMatch = /bsky\.app\/profile\/([^/?#]+)/i.exec(trimmed)
  if (urlMatch?.[1]) return decodeURIComponent(urlMatch[1]).toLowerCase()

  if (trimmed.startsWith('at://')) {
    const rest = trimmed.slice('at://'.length)
    const slash = rest.indexOf('/')
    return (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase()
  }

  return trimmed.replace(/^@/, '').toLowerCase()
}

export async function resolveActor(
  input: string,
  options: FetchOptions = {}
): Promise<ResolvedProfile> {
  const actor = parseActorInput(input)
  if (!actor) throw new BskyError('Enter a handle, DID, or bsky.app profile link.')

  const profile = await xrpc<RawAuthor>('app.bsky.actor.getProfile', { actor }, options)
  const resolved = toResolvedProfile(profile)
  if (!resolved) throw new BskyError(`Could not resolve "${input}".`)
  return resolved
}

/** Batch profile refresh so handle renames and new avatars show up. */
export async function fetchProfiles(
  dids: string[],
  options: FetchOptions = {}
): Promise<ResolvedProfile[]> {
  if (!dids.length) return []

  // getProfiles caps at 25 actors per call.
  const chunks: string[][] = []
  for (let i = 0; i < dids.length; i += 25) chunks.push(dids.slice(i, i + 25))

  const responses = await Promise.all(
    chunks.map((actors) =>
      xrpc<{ profiles?: RawAuthor[] }>('app.bsky.actor.getProfiles', { actors }, options)
    )
  )

  return responses
    .flatMap((data) => data.profiles ?? [])
    .map(toResolvedProfile)
    .filter((p): p is ResolvedProfile => p !== null)
}
