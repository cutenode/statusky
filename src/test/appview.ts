/**
 * A fake public AppView.
 *
 * `src/shared/bsky.ts` is the app's only network surface, so a faithful double of
 * the three XRPC methods it calls is enough to drive every layer above it —
 * including the real `Model` — without touching the network. Install it and the
 * global `fetch` answers from in-memory fixtures; every request is recorded, and
 * per-actor failures let a test reproduce partial outages, rate limits and hangs.
 */
import { PUBLIC_APPVIEW } from '../shared/defaults'
import type { RawFacet } from '../shared/richtext'

export interface RawProfile {
  did: string
  handle: string
  displayName?: string
  avatar?: string
  description?: string
  followersCount?: number
  postsCount?: number
}

export interface RawPostView {
  uri: string
  cid: string
  author: RawProfile
  record: {
    $type: string
    text: string
    createdAt: string
    facets?: RawFacet[]
    reply?: unknown
  }
  embed?: Record<string, unknown>
  indexedAt: string
  replyCount?: number
  repostCount?: number
  likeCount?: number
}

export interface RawFeedItem {
  post: RawPostView
  reason?: unknown
  reply?: unknown
}

export interface RecordedRequest {
  method: string
  actor: string | null
  actors: string[]
  params: URLSearchParams
  url: string
}

/** How a given actor should fail, instead of answering normally. */
export type ActorFailure =
  | { kind: 'http'; status: number; body?: unknown }
  | { kind: 'network'; message?: string }
  | { kind: 'hang' }
  | { kind: 'malformed' }
  /** Reject with something that is not an `Error`, as a stray `throw` would. */
  | { kind: 'raw'; value: unknown }

let nextRkey = 0

export interface PostSpec {
  text?: string
  createdAt?: string
  indexedAt?: string
  rkey?: string
  cid?: string
  facets?: RawFacet[]
  embed?: Record<string, unknown>
  reply?: unknown
  replyCount?: number
  repostCount?: number
  likeCount?: number
  /** Override the record type to exercise the "not a feed post" rejection. */
  type?: string
}

/** Build one AppView post view for `author`. */
export function rawPost(author: RawProfile, spec: PostSpec = {}): RawPostView {
  const rkey = spec.rkey ?? `3test${(nextRkey++).toString(36)}`
  const createdAt = spec.createdAt ?? new Date().toISOString()
  return {
    uri: `at://${author.did}/app.bsky.feed.post/${rkey}`,
    cid: spec.cid ?? `bafy-${rkey}`,
    author,
    record: {
      $type: spec.type ?? 'app.bsky.feed.post',
      text: spec.text ?? '',
      createdAt,
      ...(spec.facets ? { facets: spec.facets } : {}),
      ...(spec.reply ? { reply: spec.reply } : {})
    },
    ...(spec.embed ? { embed: spec.embed } : {}),
    indexedAt: spec.indexedAt ?? createdAt,
    replyCount: spec.replyCount ?? 0,
    repostCount: spec.repostCount ?? 0,
    likeCount: spec.likeCount ?? 0
  }
}

/** Ready-made embed views, matching the `#view` shapes the AppView returns. */
export const embeds = {
  external(
    overrides: { uri?: string; title?: string; description?: string; thumb?: string } = {}
  ): Record<string, unknown> {
    return {
      $type: 'app.bsky.embed.external#view',
      external: {
        uri: 'https://status.bsky.app/incidents/1',
        title: 'Incident report',
        description: 'Elevated error rates on the AppView.',
        thumb: 'https://cdn.bsky.app/thumb.jpg',
        ...overrides
      }
    }
  },
  images(count = 1): Record<string, unknown> {
    return {
      $type: 'app.bsky.embed.images#view',
      images: Array.from({ length: count }, (_, i) => ({
        thumb: `https://cdn.bsky.app/thumb-${i}.jpg`,
        fullsize: `https://cdn.bsky.app/full-${i}.jpg`,
        alt: `Graph ${i}`
      }))
    }
  },
  record(text = 'Quoted post', author = 'someone.bsky.social'): Record<string, unknown> {
    return {
      $type: 'app.bsky.embed.record#view',
      record: {
        uri: 'at://did:plc:quoted/app.bsky.feed.post/abc',
        author: { did: 'did:plc:quoted', handle: author },
        value: { $type: 'app.bsky.feed.post', text }
      }
    }
  },
  recordWithMedia(media: Record<string, unknown>): Record<string, unknown> {
    return {
      $type: 'app.bsky.embed.recordWithMedia#view',
      media,
      record: { $type: 'app.bsky.embed.record#view' }
    }
  },
  unsupported(): Record<string, unknown> {
    return { $type: 'app.bsky.embed.video#view', playlist: 'https://video/playlist.m3u8' }
  }
}

export class FakeAppView {
  private readonly profiles = new Map<string, RawProfile>()
  private readonly feeds = new Map<string, RawFeedItem[]>()
  private readonly failures = new Map<string, ActorFailure>()
  private originalFetch: typeof globalThis.fetch | null = null

  /** Every XRPC call made while installed, oldest first. */
  readonly requests: RecordedRequest[] = []
  /** Milliseconds of simulated latency before each response resolves. */
  latencyMs = 0

  /** Register a profile under both its DID and its handle. */
  addProfile(profile: RawProfile): this {
    this.profiles.set(profile.did, profile)
    this.profiles.set(profile.handle.toLowerCase(), profile)
    return this
  }

  /** Register an actor's author feed. Accepts post views or bare specs. */
  setFeed(actor: RawProfile, posts: (RawPostView | RawFeedItem | PostSpec)[]): this {
    this.addProfile(actor)
    const items = posts.map((entry) => {
      if ('post' in entry) return entry as RawFeedItem
      if ('uri' in entry) return { post: entry as RawPostView }
      return { post: rawPost(actor, entry as PostSpec) }
    })
    this.feeds.set(actor.did, items)
    this.feeds.set(actor.handle.toLowerCase(), items)
    return this
  }

  /** Add a repost of somebody else's post, which the app must skip. */
  addRepost(actor: RawProfile, post: RawPostView): this {
    const items = this.feeds.get(actor.did) ?? []
    const next = [...items, { post, reason: { $type: 'app.bsky.feed.defs#reasonRepost' } }]
    this.feeds.set(actor.did, next)
    this.feeds.set(actor.handle.toLowerCase(), next)
    return this
  }

  /** Make every request for `actor` fail in a specific way. */
  fail(actor: string, failure: ActorFailure): this {
    this.failures.set(actor.toLowerCase(), failure)
    return this
  }

  clearFailures(): this {
    this.failures.clear()
    return this
  }

  /** Requests recorded for one XRPC method. */
  requestsFor(method: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method)
  }

  install(): () => void {
    this.originalFetch = globalThis.fetch
    globalThis.fetch = this.fetch as typeof globalThis.fetch
    return () => this.uninstall()
  }

  uninstall(): void {
    if (this.originalFetch) globalThis.fetch = this.originalFetch
    this.originalFetch = null
  }

  reset(): void {
    this.profiles.clear()
    this.feeds.clear()
    this.failures.clear()
    this.requests.length = 0
    this.latencyMs = 0
  }

  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), PUBLIC_APPVIEW)

    // This double stands in for the AppView, not for the whole network. Anything
    // that is not an XRPC call — a test knocking on the app's own webhook socket,
    // say — goes through to the real `fetch`.
    if (!url.pathname.startsWith('/xrpc/')) {
      return this.originalFetch!(input, init)
    }

    const method = url.pathname.replace(/^\/xrpc\//, '')
    const params = url.searchParams
    const actor = params.get('actor')
    const actors = params.getAll('actors')

    this.requests.push({ method, actor, actors, params, url: url.toString() })

    const failure = this.failureFor([actor, ...actors])
    if (failure?.kind === 'hang') return this.hang(init.signal ?? null)
    if (this.latencyMs > 0) await this.delay(this.latencyMs, init.signal ?? null)
    if (init.signal?.aborted) throw abortError()

    if (failure?.kind === 'network') {
      throw new TypeError(failure.message ?? 'fetch failed')
    }
    if (failure?.kind === 'raw') {
      throw failure.value
    }
    if (failure?.kind === 'malformed') {
      return new Response('<html>gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' }
      })
    }
    if (failure?.kind === 'http') {
      return json(failure.body ?? { error: 'InvalidRequest', message: 'Actor not found' }, {
        status: failure.status
      })
    }

    switch (method) {
      case 'app.bsky.feed.getAuthorFeed': {
        // The lexicon allows 1–100, and the AppView refuses anything else before it
        // looks at the actor at all.
        const limit = Number(params.get('limit') ?? 50)
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return json(
            { error: 'InvalidRequest', message: 'limit must be an integer from 1 to 100' },
            { status: 400 }
          )
        }
        const key = (actor ?? '').toLowerCase()
        const feed = this.feeds.get(actor ?? '') ?? this.feeds.get(key)
        if (!feed) {
          return json({ error: 'InvalidRequest', message: 'Profile not found' }, { status: 400 })
        }
        const filtered =
          params.get('filter') === 'posts_no_replies'
            ? feed.filter((item) => !item.post.record.reply)
            : feed
        // Newest first, as the AppView pages it, so a limit keeps the latest posts rather
        // than whichever a test happened to list first.
        const newestFirst = filtered.toSorted(
          (a, b) => Date.parse(b.post.indexedAt) - Date.parse(a.post.indexedAt)
        )
        return json({ feed: newestFirst.slice(0, limit), cursor: undefined })
      }
      case 'app.bsky.actor.getProfile': {
        const profile = this.lookup(actor)
        if (!profile) {
          return json({ error: 'InvalidRequest', message: 'Profile not found' }, { status: 400 })
        }
        return json(profile)
      }
      case 'app.bsky.actor.getProfiles': {
        if (actors.length > 25) {
          return json(
            { error: 'InvalidRequest', message: 'Too many actors requested' },
            { status: 400 }
          )
        }
        const profiles = actors
          .map((value) => this.lookup(value))
          .filter((profile): profile is RawProfile => profile !== undefined)
        return json({ profiles })
      }
      default:
        return json({ error: 'MethodNotImplemented' }, { status: 501 })
    }
  }

  private lookup(actor: string | null): RawProfile | undefined {
    if (!actor) return undefined
    return this.profiles.get(actor) ?? this.profiles.get(actor.toLowerCase())
  }

  private failureFor(candidates: (string | null)[]): ActorFailure | undefined {
    for (const candidate of candidates) {
      if (!candidate) continue
      const failure = this.failures.get(candidate.toLowerCase())
      if (failure) return failure
    }
    return undefined
  }

  /** Never resolve, so only the caller's own abort signal ends the request. */
  private hang(signal: AbortSignal | null): Promise<Response> {
    return new Promise((_resolve, reject) => {
      if (!signal) return
      if (signal.aborted) reject(abortError())
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
  }

  private delay(ms: number, signal: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(abortError())
        },
        { once: true }
      )
    })
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}
