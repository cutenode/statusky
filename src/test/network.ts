/**
 * A fake Internet for the network checks.
 *
 * `src/main/probes.ts` reaches the outside world only through the `ProbeTransport` it is
 * handed, so this stands in for every service in the catalogue at once. Out of the box
 * everything is healthy: each endpoint answers with the smallest body its check accepts,
 * and every relay's firehose delivers a fresh commit. A test then breaks exactly the
 * piece it cares about — one host's HTTP, one relay's stream, the whole connection —
 * and every request and socket is recorded so it can assert on what was asked.
 */
import type { ProbeSocket, ProbeTransport } from '../main/probes'
import { CATALOGUE } from '../shared/network'
import { commitFrame, errorFrame, frame } from './cbor'

/** An atproto TID stamped at `ms`, which is how two of the streams date their events. */
export function tid(ms = Date.now()): string {
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz'
  let value = (BigInt(Math.round(ms)) * 1000n) << 10n
  let out = ''
  for (let index = 0; index < 13; index++) {
    out = alphabet[Number(value % 32n)]! + out
    value /= 32n
  }
  return out
}

/** A Jetstream commit, as it arrives: JSON text with a microsecond timestamp. */
export function jetstreamEvent(at = Date.now()): string {
  return JSON.stringify({
    did: 'did:plc:someone',
    kind: 'commit',
    time_us: Math.round(at * 1000),
    commit: { operation: 'create', collection: 'app.bsky.feed.post', rkey: tid(at) }
  })
}

/** A Spacedust link, which dates itself with the TID of the record that made it. */
export function spacedustLink(at = Date.now()): string {
  return JSON.stringify({
    kind: 'link',
    origin: 'live',
    link: {
      source: 'app.bsky.feed.like:subject.uri',
      source_did: 'did:plc:someone',
      source_rev: tid(at)
    }
  })
}

/** How one host (or one path on it) should answer instead of healthily. */
export type HttpFailure =
  | { kind: 'http'; status: number }
  /** Reject the way Chromium does (`net::ERR_…`), or Node does (a `cause` with a code). */
  | { kind: 'network'; message?: string; code?: string }
  /** Never answer; only an abort ends it. */
  | { kind: 'hang' }
  /** Answer with exactly this. */
  | { kind: 'respond'; body: RequestInit['body']; contentType?: string | null; status?: number }
  /** Answer healthily, but only after this long. */
  | { kind: 'delay'; ms: number }
  /** Send the headers promptly, then never finish the body. */
  | { kind: 'stall'; contentType: string }

export type FirehoseBehaviour =
  | 'fresh'
  | 'stale'
  /** Connected, and then nothing: the failure a health endpoint cannot show you. */
  | 'silent'
  /**
   * The opening request never finishes — no open, no error, no close. What a packaged
   * build did to every stream at once when its cookie store would not load; see the
   * cookie encryption fuse in forge.config.ts.
   */
  | 'unopened'
  | 'socket-error'
  | 'close'
  | 'error-frame'
  | 'garbage'
  | 'throws'
  | 'invalid-time'
  | 'other-then-fresh'

export class FakeSocket implements ProbeSocket {
  binaryType = 'blob'
  closed = false
  private readonly events = new EventTarget()
  private listeners = 0

  constructor(readonly url: string) {}

  addEventListener(
    type: string,
    listener: (event: never) => void,
    { signal }: { signal: AbortSignal }
  ): void {
    this.listeners++
    signal.addEventListener('abort', () => this.listeners--, { once: true })
    this.events.addEventListener(type, (event) => listener(event as never), { signal })
  }

  /** Listeners still attached: none, once the probe is done with the socket. */
  listening(): number {
    return this.listeners
  }

  close(): void {
    this.closed = true
  }

  /** The handshake finished, which is what every behaviour that speaks at all starts with. */
  open(): void {
    this.events.dispatchEvent(new Event('open'))
  }

  emit(data: unknown): void {
    this.events.dispatchEvent(Object.assign(new Event('message'), { data }))
  }

  fail(): void {
    this.events.dispatchEvent(new Event('error'))
  }

  hangUp(code: number): void {
    this.events.dispatchEvent(Object.assign(new Event('close'), { code }))
  }
}

interface Rule {
  host: string
  path: string | null
  failure: HttpFailure
}

export interface RecordedProbeRequest {
  url: string
  host: string
  path: string
  headers: Record<string, string>
  cache: RequestInit['cache']
  credentials: RequestInit['credentials']
}

function json(body: unknown, contentType = 'application/json; charset=utf-8'): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': contentType }
  })
}

function text(body: string, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError')
}

export class FakeNetwork implements ProbeTransport {
  readonly requests: RecordedProbeRequest[] = []
  readonly sockets: FakeSocket[] = []
  private rules: Rule[] = []
  private readonly firehose = new Map<string, FirehoseBehaviour>()
  private readonly newest = new Map<string, string>()
  private readonly ticks = new Map<string, number>()
  private offline = false

  /** Break `host`, or one path on it (e.g. `/xrpc/_health`). The latest rule wins. */
  fail(host: string, failure: HttpFailure, path: string | null = null): this {
    this.rules.unshift({ host, path, failure })
    return this
  }

  /** Mend one host, or every host. */
  heal(host?: string): this {
    this.rules = host ? this.rules.filter((rule) => rule.host !== host) : []
    if (host) this.firehose.delete(host)
    else this.firehose.clear()
    return this
  }

  setFirehose(host: string, behaviour: FirehoseBehaviour): this {
    this.firehose.set(host, behaviour)
    return this
  }

  /** The newest post an AppView's author feeds contain. Default: now. */
  setNewestPost(host: string, iso: string | null): this {
    if (iso === null) this.newest.set(host, '')
    else this.newest.set(host, iso)
    return this
  }

  /** Every request and socket fails, as with the Wi-Fi off. */
  goOffline(): this {
    this.offline = true
    return this
  }

  goOnline(): this {
    this.offline = false
    return this
  }

  /** Requests made to one host, in order. */
  requestsTo(host: string): RecordedProbeRequest[] {
    return this.requests.filter((request) => request.host === host)
  }

  reset(): void {
    this.requests.length = 0
    this.sockets.length = 0
    this.rules = []
    this.firehose.clear()
    this.newest.clear()
    this.ticks.clear()
    this.offline = false
  }

  // ------------------------------------------------------------ transport

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const parsed = new URL(url)
    this.requests.push({
      url,
      host: parsed.hostname,
      path: parsed.pathname,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      cache: init.cache,
      credentials: init.credentials
    })

    const signal = init.signal ?? undefined
    if (signal?.aborted) throw abortError()
    if (this.offline) throw new Error('net::ERR_INTERNET_DISCONNECTED')

    const rule = this.rules.find(
      (candidate) =>
        candidate.host === parsed.hostname &&
        (candidate.path === null || candidate.path === parsed.pathname)
    )
    switch (rule?.failure.kind) {
      case 'http':
        return new Response('failure', { status: rule.failure.status })
      case 'network': {
        const { message = 'fetch failed', code } = rule.failure
        throw code ? new TypeError(message, { cause: { code } }) : new Error(message)
      }
      case 'hang':
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => reject(abortError()), { once: true })
        })
      case 'respond': {
        const { body, contentType = null, status = 200 } = rule.failure
        const headers = new Headers()
        if (contentType) headers.set('content-type', contentType)
        // A string body gets `text/plain` for free; bytes stay untyped, as asked.
        const raw =
          contentType === null && typeof body === 'string' ? new TextEncoder().encode(body) : body
        return new Response(raw, { status, headers })
      }
      case 'stall':
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'content-type': rule.failure.contentType }
        })
      case 'delay': {
        const { ms } = rule.failure
        await new Promise<void>((resolve, reject) => {
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
        return this.healthy(parsed)
      }
      default:
        return this.healthy(parsed)
    }
  }

  readonly openSocket = (url: string): FakeSocket => {
    const parsed = new URL(url)
    const host = parsed.hostname
    const behaviour = this.firehose.get(host) ?? 'fresh'
    if (behaviour === 'throws') throw new Error('net::ERR_NAME_NOT_RESOLVED')

    const socket = new FakeSocket(url)
    this.sockets.push(socket)

    // A relay speaks CBOR; Jetstream and Spacedust speak JSON on `/subscribe`. The
    // behaviours below are the same either way, so which stream this is only decides
    // how a message is written.
    const stale = Date.now() - 2 * 3600_000
    const fresh = (): unknown => {
      if (parsed.pathname !== '/subscribe') return commitFrame()
      return host === CATALOGUE.microcosm.spacedust ? spacedustLink() : jetstreamEvent()
    }
    const old = (): unknown => {
      if (parsed.pathname !== '/subscribe') return commitFrame(new Date(stale).toISOString())
      return host === CATALOGUE.microcosm.spacedust ? spacedustLink(stale) : jetstreamEvent(stale)
    }

    // The probe attaches its handlers straight after this returns; speak once it has.
    queueMicrotask(() => {
      if (this.offline) return socket.fail()
      // Everything that gets as far as speaking has an opening handshake behind it. The
      // two that do not are the point of this line: a socket that fails on the way up,
      // and one whose handshake simply never finishes.
      if (behaviour !== 'unopened' && behaviour !== 'socket-error') socket.open()
      switch (behaviour) {
        case 'fresh':
          return socket.emit(fresh())
        case 'stale':
          return socket.emit(old())
        case 'socket-error':
          return socket.fail()
        case 'close':
          return socket.hangUp(1006)
        case 'error-frame':
          return socket.emit(errorFrame('ConsumerTooSlow', 'Stream consumer too slow'))
        case 'garbage':
          return socket.emit(new Uint8Array([0xff, 0x00]).buffer)
        case 'invalid-time':
          return socket.emit(
            parsed.pathname === '/subscribe'
              ? JSON.stringify({ kind: 'commit', time_us: 'soon' })
              : commitFrame('not a timestamp')
          )
        case 'other-then-fresh':
          socket.emit(
            parsed.pathname === '/subscribe'
              ? JSON.stringify({ kind: 'identity', did: 'did:plc:someone' })
              : frame({ op: 1, t: '#identity' }, { seq: 1, did: 'did:plc:someone' })
          )
          return socket.emit(fresh())
        default:
          // 'silent': connected, and nothing ever arrives. 'unopened': not even that.
          return undefined
      }
    })
    return socket
  }

  // ------------------------------------------------------------ answers

  private healthy(url: URL): Response {
    const host = url.hostname
    if (url.pathname.startsWith('/img/')) {
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200,
        headers: { 'content-type': 'image/webp' }
      })
    }
    if (host === 'api.github.com') return json({ current_user_url: 'https://api.github.com/user' })
    if (host === 'cloudflare-dns.com' || host === 'dns.google') {
      return json({ Status: 0, Answer: [{ data: '192.0.2.1' }] }, 'application/dns-json')
    }
    if (host === 'checkip.amazonaws.com') {
      return new Response('192.0.2.1\n', { status: 200, headers: { 'content-type': 'text/plain' } })
    }

    const plain = this.outsideXrpc(url)
    if (plain) return plain

    const nsid = url.pathname.replace(/^\/xrpc\//, '')
    const params = url.searchParams
    switch (nsid) {
      case '_health':
        return json({ status: 'ok', version: '0.4.0' })
      case 'com.atproto.sync.listHosts':
        return json(this.hostPage(params))
      case 'com.atproto.server.describeServer':
        return json({ did: `did:web:${host}` })
      case 'com.atproto.sync.listRepos':
        return json({
          repos: [
            { did: 'did:plc:inactive', active: false },
            { did: 'did:plc:repo', active: true }
          ]
        })
      case 'com.atproto.repo.listRecords':
        return json({ records: [] })
      case 'com.atproto.repo.getRecord':
        return json({
          uri: `at://${params.get('repo')}/${params.get('collection')}/${params.get('rkey')}`,
          cid: 'bafyreiprobe',
          value: { $type: params.get('collection') }
        })
      case 'app.bsky.actor.getProfile':
        return json({ did: params.get('actor') })
      case 'com.atproto.identity.resolveHandle':
        // The anchor identity, which the Slingshot check matches exactly and the
        // AppView check only needs to be a DID at all.
        return json({ did: CATALOGUE.anchor.did })
      case 'blue.microcosm.identity.resolveMiniDoc':
        return json({
          did: params.get('identifier'),
          handle: CATALOGUE.anchor.handle,
          pds: 'https://pds.example',
          signing_key: 'did:key:zProbe'
        })
      case 'app.bsky.feed.getAuthorFeed': {
        const newest = this.newest.get(host) ?? new Date().toISOString()
        return json({ feed: newest ? [{ post: { record: { createdAt: newest } } }] : [] })
      }
      case 'app.bsky.feed.getFeedSkeleton':
        // Unauthenticated, For You's proxy answers by itself with a single canned post
        // rather than reaching the recommender.
        return host === CATALOGUE.forYou.host
          ? json({
              feed: [
                {
                  post: 'at://did:plc:qhyg27lbj3uqsmlyvmsh2bjx/app.bsky.feed.post/3mnqknfvlpk24',
                  reason: { $type: 'app.bsky.feed.defs#skeletonReasonPin' }
                }
              ],
              cursor: ''
            })
          : json({ feed: [] })
      case 'app.bsky.feed.getFeedGenerator':
        return json({
          view: { uri: params.get('feed'), did: CATALOGUE.forYou.did, displayName: 'For You' },
          isOnline: true,
          isValid: true
        })
      case 'blue.microcosm.links.getBacklinks':
        return json({ records: [], total: 0 })
      case 'sh.tangled.bobbin.getCoverage':
        return json({
          ready: true,
          eventsProcessed: this.tick('events'),
          lastCursor: this.tick('cursor')
        })
      case 'sh.tangled.repo.getRepoByRepoDid':
        return json({
          uri: `at://${CATALOGUE.tangled.ownerDid}/sh.tangled.repo/core`,
          value: { $type: 'sh.tangled.repo', knot: CATALOGUE.tangled.knots[0] }
        })
      case 'sh.tangled.knot.version':
        return json({ version: 'v1.15.0', capabilities: ['knot-acl', 'repo-did-input'] })
      case 'sh.tangled.owner':
        return json({ owner: CATALOGUE.tangled.ownerDid })
      case 'sh.tangled.sync.listRepos':
        return json({
          repos: [{ repo: 'did:plc:knotrepo', status: 'active', defaultBranch: { ref: 'main' } }]
        })
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  /**
   * The services that answer outside `/xrpc`, which is most of the ones added after
   * status.feeds.blue: Laravel apps on `/up`, microcosm's own routes, Tangled's HTML.
   */
  private outsideXrpc(url: URL): Response | null {
    const host = url.hostname
    const path = url.pathname
    const { microcosm, tangled, apps, forYou } = CATALOGUE

    if (CATALOGUE.jetstreams.includes(host as never) && path === '/') {
      return text('Welcome to Jetstream')
    }
    if (host === microcosm.ufos) {
      if (path === '/meta') {
        const cursor = Math.round(Date.now() * 1000)
        return json({
          storage: { rollup_cursor: cursor },
          consumer: {
            jetstream: {
              endpoint: 'wss://jetstream1.us-east.fire.hose.cam/subscribe',
              latest_cursor: cursor,
              rollup_cursor: cursor
            }
          }
        })
      }
      if (path === '/collections/stats') {
        return json({ 'app.bsky.feed.post': { creates: 1, updates: 0, deletes: 0 } })
      }
    }
    if (host === forYou.host) {
      if (path === '/.well-known/did.json') {
        return json({
          '@context': ['https://www.w3.org/ns/did/v1'],
          id: forYou.did,
          service: [
            {
              id: '#bsky_fg',
              type: 'BskyFeedGenerator',
              serviceEndpoint: `https://${forYou.host}`
            }
          ]
        })
      }
      if (path === '/') {
        return text(
          `<html><head>${forYou.siteMarker}</head><body>💖 For You</body></html>`,
          'text/html'
        )
      }
    }
    if (CATALOGUE.constellationHosts.includes(host as never) && path === '/') {
      // Climbs on every read: a flat count is what says the index has stopped.
      return json({ stats: { linking_records: this.tick('links'), dids: this.tick('dids') } })
    }
    if (host === tangled.appview) {
      if (path === '/core') {
        return text(
          `<meta name="go-import" content="${tangled.repoPath.slice(1)} git">`,
          'text/html'
        )
      }
      if (path === tangled.repoPath) {
        // Served with the separator as an entity, exactly as the real page does.
        return text(
          `<html><head><title>${tangled.repoTitle} &middot; Tangled</title></head></html>`,
          'text/html'
        )
      }
    }
    if (host === tangled.api && path === '/health') {
      return json({ mode: 'indexer', name: 'hydrant', version: '0.1.0' })
    }
    if (tangled.spindles.includes(host as never) && path === '/_health') {
      return json({ status: 'ok' })
    }
    if (host === apps.pckt && path === '/up') {
      return json({
        status: 'ok',
        uptime: { deployed_at: new Date().toISOString(), seconds: 1 },
        checks: { database: true, cache: true },
        queues: { default: 0, media: 0, search: 0 },
        jetstream: { cursor: this.tick('pckt'), stale_seconds: 0.4 },
        horizon: { running: true, masters: 1 },
        failed_jobs_last_hour: 0,
        typesense: true,
        scheduler: { last_heartbeat_seconds_ago: 5 }
      })
    }
    if (host === apps.leaflet.host) {
      const { publication, feed } = apps.leaflet
      if (
        path ===
        `/lish/${publication.did}/${publication.rkey}/.well-known/site.standard.publication`
      ) {
        return text(`at://${publication.did}/site.standard.publication/${publication.rkey}`)
      }
      if (path === '/api/rpc/search_publication_names') {
        return json({
          result: { publications: [{ uri: 'at://did:plc:pub/x/y', name: 'Leaflet' }] }
        })
      }
      if (path === `/lish/${feed.did}/${feed.rkey}/atom`) {
        return text(
          `<feed><updated>${new Date().toISOString()}</updated></feed>`,
          'application/atom+xml'
        )
      }
    }
    if (host === apps.offprint.host) {
      if (path === '/up') return text('<html><body>Application up</body></html>', 'text/html')
      if (path === '/feed') {
        return text(
          `<rss><channel><lastBuildDate>${new Date().toUTCString()}</lastBuildDate></channel></rss>`,
          'application/rss+xml'
        )
      }
    }
    if (
      host === apps.offprint.publicationHost &&
      path === '/.well-known/site.standard.publication'
    ) {
      return text(apps.offprint.publication)
    }
    return null
  }

  /**
   * A page of `listHosts`, all active.
   */
  private hostPage(params: URLSearchParams): unknown {
    const limit = Number(params.get('limit') ?? 200)
    if (params.get('cursor')) return { hosts: [] }
    const total = Math.min(Number.isFinite(limit) ? limit : 200, 60)
    const hosts = Array.from({ length: Math.max(1, total) }, (_, index) => ({
      hostname: `host${index}.example`,
      seq: 1000 + index,
      accountCount: 1000 - index,
      status: 'active'
    }))
    return { hosts, cursor: 'next' }
  }

  /** A counter that climbs every time it is read, for the checks that watch one. */
  private tick(key: string): number {
    const next = (this.ticks.get(key) ?? 0) + 1000
    this.ticks.set(key, next)
    return next
  }
}
