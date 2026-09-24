/**
 * The requests behind the network dashboard.
 *
 * Each service kind gets the same checks status.feeds.blue runs against it — a relay's
 * health endpoint, host list and live firehose; a PDS's health, server description and
 * a real read of one repository; an AppView's health, profile lookups, handle resolution
 * and author feeds — each judged by the same rules, down to the error wording. Where
 * this departs from the page it says so and why.
 *
 * Nothing here schedules or remembers anything: `probeService` fills in one service's
 * checks and returns. The transport is injected, which is what lets the app send every
 * request through Chromium's network stack (so the system proxy and certificate store
 * apply, exactly as they would to the page in a browser) and lets the tests send them
 * nowhere at all.
 *
 * What each service is asked about comes from the sweep's `ProbeTargets`, never from a
 * constant: those are other people's accounts and documents, and a user can swap them
 * between sweeps. What the answers are held to, word for word, comes from
 * `EXPECTED_RESPONSES`. What is left in here is the shape of each conversation.
 */
import { decode, decodeFirst, toBytes } from '../shared/cbor'
import { EXPECTED_RESPONSES } from '../shared/expected-responses'
import {
  AUTHOR_FEED_LIMIT,
  CATALOGUE,
  CURSOR_LAG_MS,
  FIREHOSE_FRESH_MS,
  FIREHOSE_WINDOW_MS,
  INDEX_LAG_MS,
  REQUEST_TIMEOUT_MS,
  SLOW_CHECK_EVERY_MS,
  humanDuration,
  type ServiceDefinition
} from '../shared/network'
import type { ProbeCheck, ProbeCheckKind, ProbeTargets } from '../shared/types'

/** Listeners are always added with a signal, which is how they are all removed at once. */
interface ListenerOptions {
  signal: AbortSignal
}

/**
 * The part of a WebSocket the stream checks use, as Electron's `net.WebSocket` and Node's
 * are both typed, so either can be handed over without a cast.
 *
 * Electron's inherits a bare `EventTarget`, which promises a listener an `Event` and
 * nothing more: no `data` on a message, no `code` on a close. Both are there at runtime,
 * but a signature claiming them here would be a promise Electron's type does not make, so
 * they are narrowed where they are read instead.
 */
export interface ProbeSocket {
  binaryType: string
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: Event) => void,
    options: ListenerOptions
  ): void
  close(): void
}

export interface ProbeTransport {
  fetch(url: string, init: RequestInit): Promise<Response>
  openSocket(url: string): ProbeSocket
}

export interface ProbeTimings {
  requestTimeoutMs: number
  firehoseWindowMs: number
  firehoseFreshMs: number
  indexLagMs: number
  /** How far a service's own consumer cursor may trail the clock. */
  cursorLagMs: number
  /** How long a check too expensive for every sweep waits between runs. */
  slowCheckEveryMs: number
}

export const DEFAULT_PROBE_TIMINGS: ProbeTimings = {
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  firehoseWindowMs: FIREHOSE_WINDOW_MS,
  firehoseFreshMs: FIREHOSE_FRESH_MS,
  indexLagMs: INDEX_LAG_MS,
  cursorLagMs: CURSOR_LAG_MS,
  slowCheckEveryMs: SLOW_CHECK_EVERY_MS
}

/**
 * The little that one sweep needs to remember from the last one.
 *
 * Two kinds of check cannot be judged from a single response. A counter that should be
 * climbing — Constellation's `linking_records`, Bobbin's `lastCursor` — only says
 * anything when compared with its previous value; and a check too expensive to run every
 * ten minutes needs to know when it last ran. Both are a number against a key, kept in
 * memory by the monitor and forgotten when the checks are switched off.
 */
export interface ProbeCounters {
  get(key: string): number | null
  set(key: string, value: number): void
}

export interface ProbeContext {
  transport: ProbeTransport
  /** Aborted when the sweep is abandoned: the app quitting, or checks switched off. */
  signal: AbortSignal
  timings: ProbeTimings
  now(): number
  /** Called whenever a check starts or settles, so the dashboard can fill in live. */
  changed(): void
  /** Where AppViews compare their newest posts. */
  peers: FreshnessPeers
  /** What the last sweep left behind: counters to compare against, and clocks. */
  counters: ProbeCounters
  /**
   * What every service in this sweep is asked about. Taken once when the sweep starts,
   * so a change made mid-sweep cannot leave half the dashboard reading one set of
   * accounts and half another. See `effectiveProbeTargets`.
   */
  targets: ProbeTargets
}

/**
 * Whether a check that runs slower than the sweep is due. Records the time when it is,
 * so the next sweep knows to skip it.
 */
function due(ctx: ProbeContext, key: string, everyMs = ctx.timings.slowCheckEveryMs): boolean {
  const last = ctx.counters.get(`due:${key}`)
  const now = ctx.now()
  if (last !== null && now - last < everyMs) return false
  ctx.counters.set(`due:${key}`, now)
  return true
}

// ------------------------------------------------------------------ checks

/** A check in progress. The `ProbeCheck` it wraps is the one the dashboard is showing. */
class Check {
  private startedAt: number | null = null

  constructor(
    readonly record: ProbeCheck,
    private readonly ctx: ProbeContext
  ) {}

  get target(): string | null {
    return this.record.target
  }

  set target(url: string) {
    this.record.target = url
  }

  get passed(): boolean {
    return this.record.ok === true
  }

  start(): void {
    this.startedAt = this.ctx.now()
    this.ctx.changed()
  }

  pass(): void {
    this.settle(true, null, true)
  }

  /** `timed: false` leaves the duration blank when it would only mislead. */
  fail(error: string, { timed = true } = {}): void {
    this.settle(false, error, timed)
  }

  private settle(ok: boolean, error: string | null, timed: boolean): void {
    if (this.record.ok !== null) return
    this.record.ok = ok
    this.record.error = error
    this.record.durationMs =
      timed && this.startedAt !== null ? Math.max(0, this.ctx.now() - this.startedAt) : null
    this.ctx.changed()
  }
}

function addCheck(
  checks: ProbeCheck[],
  ctx: ProbeContext,
  label: string,
  target: string | null,
  kind: ProbeCheckKind = 'http'
): Check {
  const record: ProbeCheck = { label, target, kind, ok: null, error: null, durationMs: null }
  checks.push(record)
  return new Check(record, ctx)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function xrpc(host: string, nsid: string, params: Record<string, string | number> = {}): string {
  const url = new URL(`https://${host}/xrpc/${nsid}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  return url.toString()
}

/** A plain path on a host, for the services that answer outside `/xrpc`. */
function http(host: string, path = '/'): string {
  return new URL(path, `https://${host}`).toString()
}

/** A nested JSON property, or undefined if the path does not lead to one. */
function field(body: unknown, ...keys: string[]): unknown {
  let value = body
  for (const key of keys) {
    if (!isObject(value)) return undefined
    value = value[key]
  }
  return value
}

function numberField(body: unknown, ...keys: string[]): number | null {
  const value = field(body, ...keys)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Judge a cursor a service publishes about itself.
 *
 * This is the check a plain health endpoint cannot make. A stalled consumer answers
 * every request correctly from what it has already indexed, so the only thing that gives
 * it away is its own bookkeeping standing still — and a handful of services in the
 * Atmosphere are good enough to publish exactly that. A cursor slightly ahead of this
 * machine's clock is skew between two computers, not news, so only lateness counts.
 */
function judgeCursor(ctx: ProbeContext, check: Check, when: number | null, noun: string): void {
  if (when === null) return check.fail(`${noun} was missing or unreadable`, { timed: false })
  const lag = ctx.now() - when
  if (lag > ctx.timings.cursorLagMs) {
    check.fail(`${noun} trails by ${humanDuration(lag)}`, { timed: false })
  } else {
    check.pass()
  }
}

/** Consecutive sweeps a counter may stand still before it counts as stalled. */
const STALL_SWEEPS = 3

/**
 * Judge a counter that should be climbing.
 *
 * Where a service reports a position rather than a time — Constellation's record count,
 * Bobbin's event cursor — the only reading is whether it moved. One flat sweep proves
 * nothing: Tangled's whole network produces about half an event a minute, so a quiet ten
 * minutes is ordinary. Three in a row is not.
 */
function judgeMovement(
  ctx: ProbeContext,
  check: Check,
  key: string,
  value: number | null,
  noun: string
): void {
  if (value === null) return check.fail(`${noun} was missing or unreadable`, { timed: false })
  const previous = ctx.counters.get(key)
  ctx.counters.set(key, value)
  if (previous === null || value > previous) {
    ctx.counters.set(`${key}:stalls`, 0)
    return check.pass()
  }
  const stalls = (ctx.counters.get(`${key}:stalls`) ?? 0) + 1
  ctx.counters.set(`${key}:stalls`, stalls)
  if (stalls < STALL_SWEEPS) return check.pass()
  check.fail(`${noun} has not moved for ${stalls} sweeps`, { timed: false })
}

// ------------------------------------------------------------------ errors

/**
 * Chromium and Node both describe a failed connection in terms a user cannot act on
 * (`net::ERR_NAME_NOT_RESOLVED`, `fetch failed`). The common ones get plain words.
 */
const NETWORK_ERRORS: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: 'DNS lookup failed',
  ERR_NAME_RESOLUTION_FAILED: 'DNS lookup failed',
  ENOTFOUND: 'DNS lookup failed',
  EAI_AGAIN: 'DNS lookup failed',
  ERR_INTERNET_DISCONNECTED: 'No internet connection',
  ERR_NETWORK_CHANGED: 'The network changed during the request',
  ERR_CONNECTION_REFUSED: 'Connection refused',
  ECONNREFUSED: 'Connection refused',
  ERR_CONNECTION_RESET: 'Connection reset',
  ECONNRESET: 'Connection reset',
  ERR_CONNECTION_CLOSED: 'Connection closed',
  ERR_CONNECTION_TIMED_OUT: 'Connection timed out',
  ERR_TIMED_OUT: 'Connection timed out',
  ETIMEDOUT: 'Connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'Connection timed out',
  ERR_ADDRESS_UNREACHABLE: 'Address unreachable',
  EHOSTUNREACH: 'Address unreachable',
  ENETUNREACH: 'Network unreachable',
  ERR_SSL_PROTOCOL_ERROR: 'TLS handshake failed'
}

/** The most useful sentence to be had from whatever a request rejected with. */
export function describeError(error: unknown, fallback = 'Request failed'): string {
  if (!(error instanceof Error)) return fallback
  const cause = (error as { cause?: unknown }).cause
  const causeCode = isObject(cause) && typeof cause.code === 'string' ? cause.code : null
  const code = /net::(ERR_[A-Z_]+)/.exec(error.message)?.[1] ?? causeCode
  if (code) {
    if (code in NETWORK_ERRORS) return NETWORK_ERRORS[code]!
    if (code.startsWith('ERR_CERT_')) return 'Certificate is not trusted'
  }
  // Node's fetch says only "fetch failed" and keeps the reason on `cause`.
  if (cause instanceof Error && cause.message) return cause.message
  return error.message || fallback
}

// ------------------------------------------------------------------ HTTP

type BodyKind = 'json' | 'text' | 'image'

/**
 * Settle with `work`, or reject as soon as `signal` aborts, whichever comes first.
 *
 * A request's deadline has to cover its body as well as its headers: a server that
 * answers promptly and then stalls mid-body would otherwise hold the whole sweep open
 * for as long as it cares to, and whether aborting the fetch also ends a body already
 * streaming is up to the transport.
 */
function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DOMException('The deadline passed', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * What a validator makes of a body. `true` passes. `false` fails with the generic
 * wording, which is all a shape check can say. A string fails with that sentence
 * instead, which is how a check that measured something — an index five minutes behind,
 * a relay calling a host offline — gets to say so in the dashboard and in the feed entry
 * rather than being reported as an "Invalid response".
 */
export type Verdict = boolean | string

interface RequestOptions {
  as?: BodyKind
  headers?: Record<string, string>
  method?: string
  body?: string
  /**
   * Statuses whose body is still worth reading. The For You feed sheds load with a 503
   * whose body says plainly that it is busy, which is the difference between a feed at
   * its limit and one that has fallen over. The status is never forgiven — it only stops
   * being the last word on why.
   */
  allow?: readonly number[]
}

/** Longest reason a server gets to add to a status, so one cannot flood a row. */
const REASON_LIMIT = 120

/**
 * `HTTP 400`, followed by the server's own reason when it gave one. XRPC errors carry a
 * `message` — "Profile not found", "Unable to resolve handle" — and that is the
 * difference between a service that is broken and one that has not indexed what it was
 * asked about, which a bare status cannot tell apart. `describeFailure` splits the two
 * halves back up for the dashboard.
 */
function statusFailure(status: number, body: unknown): string {
  const message = field(body, 'message')
  const reason = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim() : ''
  if (!reason) return `HTTP ${status}`
  return `HTTP ${status} · ${
    reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT - 1)}…` : reason
  }`
}

/**
 * A refused request's JSON body, for the reason inside it, or null. Only JSON is read —
 * an error page's HTML has nothing to quote — and never past the deadline: the status is
 * already the verdict, so a body that stalls or does not parse just goes unquoted.
 */
async function errorBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('json')) return null
  try {
    return await beforeDeadline(response.json(), signal)
  } catch {
    return null
  }
}

/**
 * Make one request and judge it, with status.feeds.blue's rules and wording: a non-2xx
 * status, a missing or non-JSON content type, a body that does not parse, and a body the
 * validator rejects are each their own failure, and so is running out of time.
 *
 * Resolves with the body when there is one, whatever the verdict, so a check that feeds
 * another (listRepos into listRecords) can look inside it.
 */
async function request(
  ctx: ProbeContext,
  check: Check,
  validate: (body: unknown) => Verdict,
  { as = 'json', headers, method, body: payload, allow }: RequestOptions = {}
): Promise<unknown> {
  const url = check.target!
  check.start()

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ctx.timings.requestTimeoutMs)
  const cancel = (): void => controller.abort()
  ctx.signal.addEventListener('abort', cancel, { once: true })

  try {
    const response = await ctx.transport.fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      headers,
      method,
      body: payload
    })
    if (!response.ok && !allow?.includes(response.status)) {
      check.fail(statusFailure(response.status, await errorBody(response, controller.signal)))
      return null
    }

    const type = response.headers.get('content-type')?.toLowerCase() ?? null
    let body: unknown
    switch (as) {
      case 'json':
        if (!type) {
          check.fail('Received no content type')
          return null
        }
        if (!type.includes('json')) {
          check.fail(`Received content type ${type}`)
          return null
        }
        try {
          body = await beforeDeadline(response.json(), controller.signal)
        } catch (error) {
          // Running out of time mid-body is a timeout, not a malformed answer.
          if (controller.signal.aborted) throw error
          check.fail('JSON parsing error')
          return null
        }
        break
      case 'text':
        body = await beforeDeadline(response.text(), controller.signal)
        break
      case 'image':
        body = await firstChunk(check, response, type, controller.signal)
        if (body === null) return null
        break
    }

    const verdict = validate(body)
    if (verdict === true && response.ok) check.pass()
    else if (typeof verdict === 'string') check.fail(verdict)
    else check.fail(response.ok ? 'Invalid response' : statusFailure(response.status, body))
    return body
  } catch (error) {
    if (timedOut) {
      check.fail(`Timed out after ${Math.round(ctx.timings.requestTimeoutMs / 1000)}s`)
    } else if (ctx.signal.aborted) {
      check.fail('Cancelled', { timed: false })
    } else {
      check.fail(describeError(error))
    }
    return null
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', cancel)
  }
}

/**
 * The page loads the CDN's images into `<img>` tags. What that proves is that the CDN
 * answers with an image and starts sending it; reading the first chunk and hanging up
 * proves the same without downloading every full-size image on every sweep.
 */
async function firstChunk(
  check: Check,
  response: Response,
  type: string | null,
  signal: AbortSignal
): Promise<Uint8Array | null> {
  if (!type?.startsWith('image/')) {
    check.fail(type ? `Received content type ${type}` : 'Received no content type')
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) {
    check.fail('Image was empty')
    return null
  }
  // Hang up however the read ends, a deadline included.
  const { value } = await beforeDeadline(reader.read(), signal).finally(
    () => void reader.cancel().catch(() => {})
  )
  if (!value?.length) {
    check.fail('Image was empty')
    return null
  }
  return value
}

// ------------------------------------------------------------------ firehose

export type FirehoseFrame =
  | { kind: 'commit'; time: unknown }
  | { kind: 'other' }
  | { kind: 'error'; message: string }
  | { kind: 'invalid' }

/**
 * Read one `subscribeRepos` message: a CBOR header (`op` 1 for an event, -1 for an
 * error; `t` naming the event type) followed by a CBOR body.
 */
export function readFrame(data: unknown): FirehoseFrame {
  const { eventOp, errorOp, commitType } = EXPECTED_RESPONSES.firehose
  const bytes = toBytes(data)
  if (!bytes) return { kind: 'invalid' }
  try {
    const [header, rest] = decodeFirst(bytes)
    if (!isObject(header)) return { kind: 'invalid' }
    if (header.op === errorOp) {
      const body = decode(rest)
      const error = isObject(body) && typeof body.error === 'string' ? body.error : 'Error'
      const message = isObject(body) && typeof body.message === 'string' ? body.message : null
      return { kind: 'error', message: message ? `${error}: ${message}` : error }
    }
    if (header.op !== eventOp) return { kind: 'invalid' }
    if (header.t !== commitType) return { kind: 'other' }
    const body = decode(rest)
    return { kind: 'commit', time: isObject(body) ? body.time : undefined }
  } catch {
    return { kind: 'invalid' }
  }
}

/** What one message on a stream turned out to say. */
type StreamMessage =
  /** Something happened at this time, in epoch milliseconds. */
  | { kind: 'time'; at: number }
  /** Nothing of interest: a keepalive, another event type, a replayed frame. */
  | { kind: 'skip' }
  /** The stream itself reported an error. */
  | { kind: 'error'; message: string }
  /** The bytes would not decode. */
  | { kind: 'undecodable' }
  /** It decoded, but its timestamp did not. */
  | { kind: 'badtime' }

/** How to read one kind of stream, and what to call the things on it. */
interface StreamWatch {
  /** Used as `<subject> connection failed`. */
  subject: string
  /** Singular, used as `No <noun>s received` and `Newest <noun> is … old`. */
  noun: string
  /** Wording for bytes that would not decode. */
  undecodable: string
  read(data: unknown): StreamMessage
}

/**
 * Open a stream and wait for something on it stamped within the last minute.
 *
 * A stalled stream is the failure that a health endpoint cannot show you: the process is
 * up, the socket opens, and nothing has moved for an hour. So every stream in the
 * catalogue is judged the same way — connect, read until something recent arrives, hang
 * up — and only the decoding differs between a relay's CBOR, Jetstream's JSON and
 * Spacedust's links.
 */
function watchStream(ctx: ProbeContext, check: Check, watch: StreamWatch): Promise<void> {
  const { firehoseWindowMs, firehoseFreshMs } = ctx.timings

  return new Promise<void>((resolve) => {
    // Aborting this takes down every listener the check added, the socket's included.
    const listening = new AbortController()
    const { signal } = listening
    let socket: ProbeSocket | null = null
    let newestLag: number | null = null
    /** Whether the handshake ever finished. See the timeout below for why it is kept. */
    let connected = false

    const finish = (error: string | null, options?: { timed: boolean }): void => {
      if (signal.aborted) return
      listening.abort()
      clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        // Closing a socket that never opened can throw; it is going away regardless.
      }
      if (error === null) check.pass()
      else check.fail(error, options)
      resolve()
    }

    const timer = setTimeout(() => {
      // A handshake that never finished is this machine's news, not the service's, and
      // saying "no commits received" about it accuses a relay that was talking the whole
      // time. They fail the same check for different reasons and have to read
      // differently: a stalled opening request is how a packaged build appeared to find
      // every firehose in the Atmosphere silent at once, while its HTTP checks — which
      // send `credentials: 'omit'` and so never wait on the cookie store the handshake
      // was stuck behind — all passed. See the cookie encryption fuse in forge.config.ts.
      if (!connected) finish(`${watch.subject} connection timed out`)
      else if (newestLag === null) finish(`No ${watch.noun}s received`)
      // A duration here would only restate the wait, so the page hides it and so do we.
      else finish(`Newest ${watch.noun} is ${humanDuration(newestLag)} old`, { timed: false })
    }, firehoseWindowMs)

    check.start()
    const cancel = (): void => finish('Cancelled', { timed: false })
    if (ctx.signal.aborted) return cancel()
    ctx.signal.addEventListener('abort', cancel, { signal })

    try {
      socket = ctx.transport.openSocket(check.target!)
    } catch (error) {
      return finish(describeError(error, `${watch.subject} connection failed`))
    }

    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', () => (connected = true), { signal })
    socket.addEventListener('error', () => finish(`${watch.subject} connection failed`), { signal })
    socket.addEventListener(
      'close',
      (event) => {
        const code = 'code' in event && typeof event.code === 'number' ? ` (${event.code})` : ''
        finish(`${watch.subject} connection closed${code}`)
      },
      { signal }
    )
    socket.addEventListener(
      'message',
      (event) => {
        // Anything arriving is proof of a connection, whatever the `open` event did.
        connected = true
        // A message with nothing on it reads as bytes that would not decode, which it is.
        const message = watch.read('data' in event ? event.data : undefined)
        if (message.kind === 'undecodable') return finish(watch.undecodable)
        if (message.kind === 'error') return finish(message.message)
        if (message.kind === 'badtime') return finish('Received invalid timestamp')
        if (message.kind === 'skip') return

        const lag = ctx.now() - message.at
        newestLag = newestLag === null ? lag : Math.min(newestLag, lag)
        if (lag < firehoseFreshMs) finish(null)
      },
      { signal }
    )
  })
}

/** Read a stream message as JSON, whether it arrived as text or as bytes. */
function readJsonFrame(data: unknown): unknown {
  const text = typeof data === 'string' ? data : null
  if (text !== null) return JSON.parse(text)
  const bytes = toBytes(data)
  if (!bytes) throw new SyntaxError('Not decodable')
  return JSON.parse(new TextDecoder().decode(bytes))
}

const FIREHOSE_WATCH: StreamWatch = {
  subject: 'Firehose',
  noun: 'commit',
  undecodable: 'Failed to decode a firehose frame',
  read(data) {
    const frame = readFrame(data)
    if (frame.kind === 'invalid') return { kind: 'undecodable' }
    if (frame.kind === 'error') return { kind: 'error', message: frame.message }
    if (frame.kind === 'other') return { kind: 'skip' }
    const time = typeof frame.time === 'string' ? Date.parse(frame.time) : Number.NaN
    return Number.isNaN(time) ? { kind: 'badtime' } : { kind: 'time', at: time }
  }
}

/**
 * Jetstream carries the same commits as the firehose, as JSON, with a top-level
 * `time_us`. No CAR, no CBOR, one integer against the clock.
 */
const JETSTREAM_WATCH: StreamWatch = {
  subject: 'Jetstream',
  noun: 'event',
  undecodable: 'Failed to decode a Jetstream event',
  read(data) {
    let body: unknown
    try {
      body = readJsonFrame(data)
    } catch {
      return { kind: 'undecodable' }
    }
    if (!isObject(body)) return { kind: 'undecodable' }
    if (body.kind !== EXPECTED_RESPONSES.jetstream.commitKind) return { kind: 'skip' }
    const us = body.time_us
    if (typeof us !== 'number' || !Number.isFinite(us)) return { kind: 'badtime' }
    return { kind: 'time', at: us / 1000 }
  }
}

/**
 * Spacedust frames carry no timestamp of their own: the time is in `link.source_rev`,
 * the TID of the record that created the link. Only frames marked `live` count — a
 * replayed one would date from whenever it was first seen.
 */
const SPACEDUST_WATCH: StreamWatch = {
  subject: 'Spacedust',
  noun: 'link',
  undecodable: 'Failed to decode a Spacedust frame',
  read(data) {
    let body: unknown
    try {
      body = readJsonFrame(data)
    } catch {
      return { kind: 'undecodable' }
    }
    if (!isObject(body)) return { kind: 'undecodable' }
    const { linkKind, liveOrigin } = EXPECTED_RESPONSES.spacedust
    if (body.kind !== linkKind || body.origin !== liveOrigin) return { kind: 'skip' }
    const rev = isObject(body.link) ? body.link.source_rev : undefined
    if (typeof rev !== 'string') return { kind: 'badtime' }
    const at = tidToMillis(rev)
    return at === null ? { kind: 'badtime' } : { kind: 'time', at }
  }
}

/**
 * Subscribe to the relay's firehose and wait for a commit stamped within the last
 * minute. That is the one thing a relay exists to do, and a relay whose health endpoint
 * answers while its stream has stalled is exactly the failure worth catching.
 */
function watchFirehose(ctx: ProbeContext, check: Check): Promise<void> {
  return watchStream(ctx, check, FIREHOSE_WATCH)
}

// ------------------------------------------------------------------ TIDs

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz'

/**
 * The time inside an atproto TID, in epoch milliseconds, or null if it is not one.
 *
 * A TID is thirteen base32-sortable characters: microseconds since the epoch in the top
 * 53 bits and a clock identifier in the low ten. Several services stamp their records
 * with nothing else, so reading it is the only way to date what they return.
 */
export function tidToMillis(tid: string): number | null {
  if (tid.length !== 13) return null
  let value = 0n
  for (const character of tid) {
    const index = TID_ALPHABET.indexOf(character)
    if (index < 0) return null
    value = value * 32n + BigInt(index)
  }
  return Number(value >> 10n) / 1000
}

// ------------------------------------------------------------------ AppView freshness

/**
 * Where the AppViews in one sweep compare notes on how fresh their indexes are.
 *
 * status.feeds.blue fails an AppView whose newest post from a few busy accounts is more
 * than fifteen minutes old. From a menu bar that runs all night, that rule pages every
 * AppView at once whenever those accounts go quiet. What actually signals a stuck
 * indexer is one AppView trailing the others, so each is judged against the freshest
 * post any of them returned — in this sweep or the one before — instead of the clock.
 *
 * Kept account by account, because not every AppView has every account. One that has
 * not indexed the busiest of them can only be fairly compared on the ones it has; held
 * to posts it was never going to see, it would read as hours behind when it is current.
 */
export class FreshnessPeers {
  private remaining: number
  private readonly freshest: Map<string, number>
  private readonly waiting: (() => void)[] = []

  constructor(expected: number, previous: NewestPosts = new Map()) {
    this.remaining = expected
    this.freshest = new Map(previous)
  }

  /** The freshest newest-post time seen so far, for each account. */
  get best(): NewestPosts {
    return this.freshest
  }

  /**
   * Report one AppView's newest post for each account it returned any for, and wait for
   * every other AppView in the sweep to do the same. Resolves with the freshest of them
   * all, account by account.
   */
  report(newest: NewestPosts): Promise<NewestPosts> {
    for (const [did, time] of newest) {
      const seen = this.freshest.get(did)
      if (seen === undefined || time > seen) this.freshest.set(did, time)
    }
    this.remaining--
    return new Promise((resolve) => {
      this.waiting.push(() => resolve(this.freshest))
      if (this.remaining <= 0) for (const wake of this.waiting.splice(0)) wake()
    })
  }
}

/** Newest post time for each account, by DID. */
export type NewestPosts = ReadonlyMap<string, number>

/** Newest `createdAt` across a set of `getAuthorFeed` responses, or null if none parse. */
export function newestPostTime(bodies: unknown[]): number | null {
  let newest: number | null = null
  for (const body of bodies) {
    if (!isObject(body) || !Array.isArray(body.feed)) continue
    for (const item of body.feed) {
      if (!isObject(item) || !isObject(item.post) || !isObject(item.post.record)) continue
      const created = item.post.record.createdAt
      if (typeof created !== 'string') continue
      const time = Date.parse(created)
      if (!Number.isNaN(time) && (newest === null || time > newest)) newest = time
    }
  }
  return newest
}

// ------------------------------------------------------------------ per kind

function probeRelay(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const health = addCheck(checks, ctx, '_health', xrpc(host, '_health'))
  // One host is all this asserts — that the route answers with a list. Left unbounded it
  // returns two hundred, which is seventeen kilobytes per relay per sweep for a question
  // answered by a hundred and seventeen bytes. The whole list is worth having, but on the
  // directory's clock rather than this one: see `src/main/directory.ts`.
  const hosts = addCheck(
    checks,
    ctx,
    'listHosts',
    xrpc(host, 'com.atproto.sync.listHosts', { limit: 1 })
  )
  const firehose = addCheck(
    checks,
    ctx,
    'firehose',
    `wss://${host}/xrpc/com.atproto.sync.subscribeRepos`,
    'stream'
  )
  return Promise.all([
    request(
      ctx,
      health,
      (body) => isObject(body) && body.status === EXPECTED_RESPONSES.relay.healthStatus
    ),
    request(ctx, hosts, (body) => isObject(body) && Array.isArray(body.hosts)),
    watchFirehose(ctx, firehose)
  ])
}

function probePds(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const health = addCheck(checks, ctx, '_health', xrpc(host, '_health'))
  const describe = addCheck(
    checks,
    ctx,
    'describeServer',
    xrpc(host, 'com.atproto.server.describeServer')
  )
  const repos = addCheck(
    checks,
    ctx,
    'listRepos',
    xrpc(host, 'com.atproto.sync.listRepos', { limit: 10 })
  )
  // The repository to read from is only known once listRepos has answered.
  const records = addCheck(checks, ctx, 'listRecords', null)

  const readRepository = async (): Promise<void> => {
    const body = await request(ctx, repos, (b) => isObject(b) && Array.isArray(b.repos))
    if (!repos.passed || !isObject(body) || !Array.isArray(body.repos)) {
      return records.fail('Skipped because listRepos failed', { timed: false })
    }
    // `active` is optional in `com.atproto.sync.listRepos#repo`, and a host that leaves it
    // out has said nothing against the repository; only an explicit `false` rules one out.
    const repo = body.repos.find(
      (entry): entry is { did: string } =>
        isObject(entry) && entry.active !== false && typeof entry.did === 'string'
    )
    if (!repo) return records.fail('No active repository found', { timed: false })

    records.target = xrpc(host, 'com.atproto.repo.listRecords', {
      repo: repo.did,
      collection: 'app.bsky.feed.post',
      limit: 1
    })
    await request(ctx, records, (b) => isObject(b) && Array.isArray(b.records))
  }

  return Promise.all([
    request(ctx, health, (body) => isObject(body) && typeof body.version === 'string'),
    request(ctx, describe, (body) => isObject(body) && typeof body.did === 'string'),
    readRepository()
  ])
}

/** AppViews that answer their health check with an empty object rather than a version. */
const VERSIONLESS_APPVIEWS: ReadonlySet<string> = new Set(
  EXPECTED_RESPONSES.appView.versionlessHealth
)

/**
 * status.feeds.blue's AppView checks, over one list of accounts rather than three.
 *
 * Every account is looked up all three ways — its profile by DID, its handle resolved,
 * its newest posts — so each is a complete statement about one identity. The handle has
 * to resolve to exactly the DID it is listed with: an AppView that answers a handle
 * with *a* DID, just not that person's, is as broken as one that answers with none, and
 * knowing both halves of each identity is what makes that checkable. The checks are
 * still filed kind by kind, so the dashboard reads as it always has.
 */
function probeAppView(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const { accounts } = ctx.targets
  const health = addCheck(checks, ctx, '_health', xrpc(host, '_health'))
  const profiles = accounts.map(({ did }) =>
    addCheck(checks, ctx, 'getProfile', xrpc(host, 'app.bsky.actor.getProfile', { actor: did }))
  )
  const handles = accounts.map((account) => ({
    account,
    check: addCheck(
      checks,
      ctx,
      'resolveHandle',
      xrpc(host, 'com.atproto.identity.resolveHandle', { handle: account.handle })
    )
  }))
  const feeds = accounts.map(({ did }) => ({
    did,
    check: addCheck(
      checks,
      ctx,
      'getAuthorFeed',
      xrpc(host, 'app.bsky.feed.getAuthorFeed', { actor: did, limit: AUTHOR_FEED_LIMIT })
    )
  }))
  const freshness = addCheck(checks, ctx, 'newest post', null, 'derived')

  const hasDid = (body: unknown): boolean => isObject(body) && typeof body.did === 'string'

  const judgeFreshness = async (): Promise<void> => {
    // An account this AppView has not indexed answers "Profile not found", which its
    // getAuthorFeed check already reports, and leaves nothing here to compare.
    const mine = new Map<string, number>()
    await Promise.all(
      feeds.map(async ({ did, check }) => {
        const body = await request(ctx, check, (b) => isObject(b) && Array.isArray(b.feed))
        const newest = newestPostTime([body])
        if (newest !== null) mine.set(did, newest)
      })
    )
    if (mine.size === 0) {
      // Every AppView reports, even one with nothing to say, or its peers would wait forever.
      void ctx.peers.report(mine)
      return freshness.fail('No valid post timestamps returned')
    }

    // Judged only on the accounts it returned posts for, against the others' newest from
    // those same accounts. Having reported its own, the freshest can be no older.
    const best = await ctx.peers.report(mine)
    let newest = -Infinity
    let freshest = -Infinity
    for (const [did, time] of mine) {
      newest = Math.max(newest, time)
      freshest = Math.max(freshest, best.get(did) ?? time)
    }
    const lag = freshest - newest
    if (lag > ctx.timings.indexLagMs) {
      freshness.fail(`Newest post trails other AppViews by ${humanDuration(lag)}`)
    } else {
      freshness.pass()
    }
  }

  return Promise.all([
    request(ctx, health, (body) =>
      VERSIONLESS_APPVIEWS.has(host)
        ? isObject(body)
        : isObject(body) && typeof body.version === 'string'
    ),
    ...profiles.map((check) => request(ctx, check, hasDid)),
    ...handles.map(({ account, check }) =>
      request(ctx, check, (body) => {
        const did = field(body, 'did')
        // No DID at all is a malformed answer; somebody else's is a wrong one.
        if (typeof did !== 'string') return false
        return did === account.did || 'Resolved to the wrong DID'
      })
    ),
    judgeFreshness()
  ])
}

function probeFeed(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const feed = ctx.targets.feeds.find((entry) => entry.host === host)
  if (!feed) {
    // The monitor builds the feed rows from these same targets, so this is a row outliving
    // its feed: say so on the row rather than asking the host about nothing.
    const check = addCheck(checks, ctx, 'getFeedSkeleton', null)
    check.fail('No feed is listed for this host', { timed: false })
    return Promise.resolve()
  }
  const check = addCheck(
    checks,
    ctx,
    'getFeedSkeleton',
    xrpc(host, 'app.bsky.feed.getFeedSkeleton', { feed: feed.uri, limit: 1 })
  )
  return request(ctx, check, (body) => isObject(body) && Array.isArray(body.feed))
}

function probeConstellation(
  host: string,
  checks: ProbeCheck[],
  ctx: ProbeContext
): Promise<unknown> {
  const stats = addCheck(checks, ctx, 'index stats', http(host))
  const growth = addCheck(checks, ctx, 'index growth', null, 'derived')

  // Constellation publishes no cursor, but its root page counts the links it holds, and
  // that number climbs by a few hundred a second while it is consuming. A backlink query
  // answers correctly from what is already indexed, so this is the only reading that
  // would notice the index having stopped.
  const judge = async (): Promise<void> => {
    const body = await request(
      ctx,
      stats,
      (b) => numberField(b, 'stats', 'linking_records') !== null || 'No index stats'
    )
    if (!stats.passed) return growth.fail('Skipped because index stats failed', { timed: false })
    judgeMovement(
      ctx,
      growth,
      `constellation:${host}`,
      numberField(body, 'stats', 'linking_records'),
      'Link count'
    )
  }

  return Promise.all([
    judge(),
    ...CATALOGUE.constellationBacklinks.map((params) => {
      const check = addCheck(
        checks,
        ctx,
        'getBacklinks',
        xrpc(host, 'blue.microcosm.links.getBacklinks', params)
      )
      return request(ctx, check, (body) => isObject(body) && Array.isArray(body.records))
    })
  ])
}

function probeCdn(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  return Promise.all(
    ctx.targets.cdnImages.map(({ did, cid }) => {
      const check = addCheck(
        checks,
        ctx,
        'image',
        `https://${host}/img/feed_fullsize/plain/${did}/${cid}`
      )
      return request(ctx, check, () => true, { as: 'image' })
    })
  )
}

function probeInternet(id: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const control = CATALOGUE.internet.find((entry) => `internet:${entry.id}` === id)!
  const check = addCheck(checks, ctx, new URL(control.url).hostname, control.url)
  switch (control.validator) {
    case 'plain-text':
      return request(ctx, check, (body) => typeof body === 'string' && body.length > 0, {
        as: 'text'
      })
    case 'dns-answer':
      return request(
        ctx,
        check,
        (body) =>
          isObject(body) &&
          (Array.isArray(body.Answer) || body.Status === EXPECTED_RESPONSES.dns.noError),
        { headers: { Accept: 'application/dns-json' } }
      )
    default:
      return request(ctx, check, isObject)
  }
}

// ------------------------------------------------------------------ streams

function probeJetstream(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const banner = addCheck(checks, ctx, 'greeting', http(host))
  const stream = addCheck(
    checks,
    ctx,
    'subscribe',
    `wss://${host}/subscribe?wantedCollections=app.bsky.feed.post`,
    'stream'
  )
  return Promise.all([
    // Twenty bytes, and worth almost nothing on its own: a Jetstream with a dead
    // upstream greets you just as warmly. It is here to tell a stalled stream apart
    // from a host that is not answering at all.
    request(
      ctx,
      banner,
      (body) =>
        (typeof body === 'string' && body.trim() === EXPECTED_RESPONSES.jetstream.greeting) ||
        'Unexpected greeting',
      { as: 'text' }
    ),
    watchStream(ctx, stream, JETSTREAM_WATCH)
  ])
}

function probeSpacedust(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<void> {
  // `instant=true` skips the documented 21-second anti-flap buffer, which would
  // otherwise make every link look twenty seconds stale. The source is a high-volume
  // one on purpose: a narrow filter can legitimately go minutes without firing, and
  // would read as an outage.
  const target =
    `wss://${host}/subscribe` +
    `?wantedSources=${encodeURIComponent(EXPECTED_RESPONSES.spacedust.source)}&instant=true`
  return watchStream(ctx, addCheck(checks, ctx, 'subscribe', target, 'stream'), SPACEDUST_WATCH)
}

// ------------------------------------------------------------------ microcosm

function probeUfos(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const { statsCollection } = EXPECTED_RESPONSES.ufos
  const meta = addCheck(checks, ctx, 'meta', http(host, '/meta'))
  const stats = addCheck(
    checks,
    ctx,
    'collections/stats',
    http(host, `/collections/stats?collection=${encodeURIComponent(statsCollection)}`)
  )
  const lag = addCheck(checks, ctx, 'index lag', null, 'derived')

  const judge = async (): Promise<void> => {
    const body = await request(
      ctx,
      meta,
      (b) => numberField(b, 'consumer', 'jetstream', 'latest_cursor') !== null
    )
    if (!meta.passed) return lag.fail('Skipped because meta failed', { timed: false })
    // Microseconds since the epoch, and the plainest freshness signal in the Atmosphere:
    // it runs a tenth of a second behind the clock when it is well.
    const cursor = numberField(body, 'consumer', 'jetstream', 'latest_cursor')
    judgeCursor(ctx, lag, cursor === null ? null : cursor / 1000, 'Index')
  }

  return Promise.all([
    judge(),
    request(
      ctx,
      stats,
      (b) => numberField(b, statsCollection, 'creates') !== null || 'No collection stats'
    )
  ])
}

function probeSlingshot(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const { handle, did } = CATALOGUE.anchor
  const { profileType } = EXPECTED_RESPONSES.slingshot
  const resolve = addCheck(
    checks,
    ctx,
    'resolveHandle',
    xrpc(host, 'com.atproto.identity.resolveHandle', { handle })
  )
  const record = addCheck(
    checks,
    ctx,
    'getRecord',
    xrpc(host, 'com.atproto.repo.getRecord', { repo: did, collection: profileType, rkey: 'self' })
  )
  const mini = addCheck(
    checks,
    ctx,
    'resolveMiniDoc',
    xrpc(host, 'blue.microcosm.identity.resolveMiniDoc', { identifier: did })
  )
  // Identity and records are cached separately, and one can break while the other
  // works. Nothing here is a freshness check: a Slingshot whose consumer has stalled
  // still answers correctly from cache, and it publishes no cursor to catch that with.
  return Promise.all([
    request(ctx, resolve, (b) => field(b, 'did') === did || 'Resolved to the wrong DID'),
    request(
      ctx,
      record,
      (b) =>
        (field(b, 'value', '$type') === profileType && typeof field(b, 'cid') === 'string') ||
        'Record was not a profile'
    ),
    request(
      ctx,
      mini,
      (b) =>
        (field(b, 'handle') === handle && typeof field(b, 'pds') === 'string') ||
        'Mini doc was incomplete'
    )
  ])
}

// ------------------------------------------------------------------ For You

/**
 * The For You feed, which is two machines behind one hostname.
 *
 * Its author runs the feed as a single Go binary on a PC in their living room and rents
 * a small VPS to face the Internet: nginx there hands `getFeedSkeleton` to a proxy that
 * validates the caller's JWT and forwards what is left over Tailscale. Only the near
 * half answers an anonymous request at all, so that is what these checks cover.
 *
 * The recommender itself is not measured at all. The two routes that would exercise it,
 * the playground and the also-liked page, sit behind a Turnstile challenge and are
 * disallowed by the site's `robots.txt`, so they are left alone. What is left still
 * separates four things: the identity an AppView resolves before it calls anything, the
 * front door, what the proxy makes of the request, and what Bluesky makes of the lot.
 */
function probeForYou(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const { did, feed } = ctx.targets.forYou
  const { appView } = CATALOGUE.forYou
  const { siteMarker, busy, generatorServiceType } = EXPECTED_RESPONSES.forYou

  // A `did:web` is only as good as the document at the other end of it, and this one is
  // read by every AppView serving the feed before it calls the generator at all.
  const document = addCheck(checks, ctx, 'did.json', http(host, '/.well-known/did.json'))
  const skeleton = addCheck(
    checks,
    ctx,
    'getFeedSkeleton',
    xrpc(host, 'app.bsky.feed.getFeedSkeleton', { feed, limit: 1 })
  )
  const site = addCheck(checks, ctx, 'site', http(host))
  const generator = addCheck(
    checks,
    ctx,
    'getFeedGenerator',
    xrpc(appView, 'app.bsky.feed.getFeedGenerator', { feed })
  )

  return Promise.all([
    request(ctx, document, (body) => {
      if (field(body, 'id') !== did) return 'DID document names a different DID'
      const services = field(body, 'service')
      const generatorService = Array.isArray(services)
        ? services.find((entry) => field(entry, 'type') === generatorServiceType)
        : undefined
      return (
        field(generatorService, 'serviceEndpoint') === `https://${host}` ||
        'DID document declares no feed generator here'
      )
    }),
    // Nothing here carries a JWT, so the proxy answers this one by itself rather than
    // reaching the PC at home: a skeleton with an entry in it proves the front door and
    // the proxy behind it, and nothing further in.
    request(ctx, skeleton, (b) => {
      const entries = field(b, 'feed')
      if (!Array.isArray(entries)) return 'No feed in the skeleton'
      return entries.length > 0 || 'Skeleton was empty'
    }),
    request(
      ctx,
      site,
      (body) => {
        if (typeof body !== 'string') return 'Site returned no page'
        if (body.includes(siteMarker)) return true
        // Rather than queue requests it cannot afford, the feed sheds them with a bare
        // `server busy` under a 503. That is a feed at its limit, not a broken one, and
        // it deserves better words than the status it arrives with.
        return body.trim() === busy ? 'Shedding load: server busy' : 'Page was not the site'
      },
      { as: 'text', allow: [503] }
    ),
    // Second-hand, the way `probeFleet` reads the relay's opinion of everybody else:
    // whether the feed works in the app is this AppView's verdict and nobody else's, so
    // it is worth one request — at the cost of an AppView outage marking this row too.
    request(ctx, generator, (body) => {
      if (field(body, 'view', 'did') !== did) return 'Generator record points elsewhere'
      if (field(body, 'isValid') !== true) return 'Bluesky calls the generator invalid'
      if (field(body, 'isOnline') !== true) return 'Bluesky cannot reach the generator'
      return true
    })
  ])
}

// ------------------------------------------------------------------ Tangled

function probeTangledAppview(
  host: string,
  checks: ProbeCheck[],
  ctx: ProbeContext
): Promise<unknown> {
  const { goGetPath, repoPath } = ctx.targets.tangled
  const { goImportMarker, notFoundTitle } = EXPECTED_RESPONSES.tangled
  // What the repository page titles itself, which is its path without the leading slash —
  // `tangled.org/core` for `/tangled.org/core` — and what the go-import meta names too.
  // Derived rather than listed beside the path, so the two can never disagree; the schema
  // holds the path to the `/<handle>/<name>` form, since a DID or `@` path redirects to
  // the handle one. Only the name is matched, not the whole title: the separator after it
  // is served as the entity `&middot;` rather than the character, and a check has no
  // business knowing which.
  const repoTitle = repoPath.slice(1)
  const goGet = addCheck(checks, ctx, 'go-get', http(host, goGetPath))
  const page = addCheck(checks, ctx, 'repo page', http(host, repoPath))
  // The appview serves HTML and nothing else — there is no `/xrpc` mount on it at all —
  // so the checks are a string match on a 92-byte static route and one on the real page,
  // which is the only thing that exercises routing, the database, identity resolution
  // and the render together.
  return Promise.all([
    request(
      ctx,
      goGet,
      (body) =>
        typeof body === 'string' && body.includes(goImportMarker) && body.includes(repoTitle)
          ? true
          : 'Unexpected go-import meta',
      { as: 'text' }
    ),
    request(
      ctx,
      page,
      (body) => {
        if (typeof body !== 'string') return 'Unexpected response'
        const title = /<title>([^<]*)<\/title>/.exec(body)?.[1]
        if (title === undefined) return 'Page carried no title'
        if (title.includes(repoTitle)) return true
        return title.includes(notFoundTitle) ? 'Repository did not resolve' : 'Unexpected page'
      },
      { as: 'text' }
    )
  ])
}

function probeBobbin(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const { repoDid } = ctx.targets.tangled
  const { knots } = CATALOGUE.tangled
  const coverage = addCheck(checks, ctx, 'getCoverage', xrpc(host, 'sh.tangled.bobbin.getCoverage'))
  const lookup = addCheck(
    checks,
    ctx,
    'getRepoByRepoDid',
    xrpc(host, 'sh.tangled.repo.getRepoByRepoDid', { repoDid })
  )
  const cursor = addCheck(checks, ctx, 'event cursor', null, 'derived')

  const judge = async (): Promise<void> => {
    const body = await request(ctx, coverage, (b) => {
      if (numberField(b, 'lastCursor') === null) return 'No coverage reported'
      return field(b, 'ready') === true ? true : 'Still backfilling from upstream'
    })
    if (numberField(body, 'lastCursor') === null) {
      return cursor.fail('Skipped because getCoverage failed', { timed: false })
    }
    judgeMovement(ctx, cursor, `bobbin:${host}`, numberField(body, 'lastCursor'), 'Event cursor')
  }

  return Promise.all([
    judge(),
    // Bobbin resolves single records through Slingshot, so a 502 here is a third failure
    // mode: neither the index nor its upstream, but the resolver between them.
    request(
      ctx,
      lookup,
      (b) => field(b, 'value', 'knot') === knots[0] || 'Repo resolved to the wrong knot'
    )
  ])
}

function probeHydrant(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  // Bobbin's upstream. Worth its own row because it is what tells "the index has
  // stalled" apart from "the thing feeding the index has died".
  const health = addCheck(checks, ctx, 'health', http(host, '/health'))
  const { name, mode } = EXPECTED_RESPONSES.hydrant
  return request(
    ctx,
    health,
    (body) =>
      (field(body, 'name') === name && field(body, 'mode') === mode) ||
      'Upstream did not identify itself'
  )
}

async function probeKnot(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<void> {
  const version = addCheck(checks, ctx, 'knot.version', xrpc(host, 'sh.tangled.knot.version'))
  const owner = addCheck(checks, ctx, 'owner', xrpc(host, 'sh.tangled.owner'))
  const [body] = await Promise.all([
    request(
      ctx,
      version,
      (b) =>
        (typeof field(b, 'version') === 'string' && field(b, 'version') !== '') ||
        'No version reported'
    ),
    request(
      ctx,
      owner,
      (b) =>
        (typeof field(b, 'owner') === 'string' && String(field(b, 'owner')).startsWith('did:')) ||
        'No owner DID'
    )
  ])

  // `/xrpc/_health` exists only on knot 2, and most of the knots in the wild run knot 1,
  // where a 404 there is perfectly healthy. The version route's capabilities are the
  // tell, so the extra checks are only asked for once it has named them. Version strings
  // themselves are not comparable between knots: knot 2 hardcodes `v1.15.0` on this
  // route while reporting its real build on `_health`.
  const capabilities = field(body, 'capabilities')
  if (
    !Array.isArray(capabilities) ||
    !capabilities.includes(EXPECTED_RESPONSES.knot.healthCapability)
  ) {
    return
  }

  const health = addCheck(checks, ctx, '_health', xrpc(host, '_health'))
  const repos = addCheck(
    checks,
    ctx,
    'sync.listRepos',
    xrpc(host, 'sh.tangled.sync.listRepos', { limit: 2 })
  )
  await Promise.all([
    // A genuine dependency check rather than a static 200: it answers 503 when the
    // knot's LFS store is unreachable or read-only.
    request(
      ctx,
      health,
      (b) => typeof field(b, 'version') === 'string' || 'Unexpected health response'
    ),
    request(ctx, repos, (b) => Array.isArray(field(b, 'repos')) || 'No repositories listed')
  ])
}

function probeSpindle(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  // A spindle mounts health at bare `/_health`, the reverse of a knot's `/xrpc/_health`.
  const health = addCheck(checks, ctx, '_health', http(host, '/_health'))
  const owner = addCheck(checks, ctx, 'owner', xrpc(host, 'sh.tangled.owner'))
  return Promise.all([
    request(
      ctx,
      health,
      (b) =>
        field(b, 'status') === EXPECTED_RESPONSES.spindle.healthStatus ||
        'Unexpected health response'
    ),
    request(
      ctx,
      owner,
      (b) => field(b, 'owner') === ctx.targets.tangled.ownerDid || 'Unexpected owner DID'
    )
  ])
}

// ------------------------------------------------------------------ apps

/** Jobs queued on one of pckt's nine workers before the backlog is worth reporting. */
const QUEUE_BACKLOG = 500

function probePckt(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<void> {
  const up = addCheck(checks, ctx, 'up', http(host, '/up'))
  const search = addCheck(checks, ctx, 'search', null, 'derived')
  const lag = addCheck(checks, ctx, 'index lag', null, 'derived')
  const work = addCheck(checks, ctx, 'queues', null, 'derived')

  // Four hundred and seventy-nine bytes, and the most generous health endpoint found
  // anywhere: database, cache, search index, queue worker, scheduler heartbeat, failed
  // jobs, nine queue depths and the jetstream cursor. Everything below reads that one
  // response. Note `uptime.seconds` resets on every deploy, so nothing judges it.
  //
  // `up` judges only what serving pages needs. pckt still reports `ok` with its search
  // index or queue worker gone, so those are checks of their own: either failing reads
  // as partial rather than failing `up` and, through the skips below, every check.
  return request(ctx, up, (body) => {
    if (field(body, 'status') !== EXPECTED_RESPONSES.pckt.status) {
      return 'Application reports it is not ok'
    }
    if (field(body, 'checks', 'database') !== true) return 'Database is unreachable'
    if (field(body, 'checks', 'cache') !== true) return 'Cache is unreachable'
    return true
  }).then((body) => {
    // A body that failed the health check is not worth reading further: the numbers in
    // it describe an application that has already said it is not well.
    if (!up.passed) {
      for (const derived of [search, lag, work]) {
        derived.fail('Skipped because up failed', { timed: false })
      }
      return
    }

    if (field(body, 'typesense') === true) search.pass()
    else search.fail('Search index is unreachable', { timed: false })

    // `jetstream.cursor` is relative to the stream, not the epoch, so it is only good
    // for movement; `stale_seconds` is the one that can be read against the clock.
    const stale = numberField(body, 'jetstream', 'stale_seconds')
    if (stale === null) {
      lag.fail('Consumer reported no staleness', { timed: false })
    } else {
      judgeCursor(ctx, lag, ctx.now() - stale * 1000, 'Index')
    }

    if (field(body, 'horizon', 'running') !== true) {
      work.fail('Queue worker is not running', { timed: false })
      return
    }
    const failed = numberField(body, 'failed_jobs_last_hour') ?? 0
    if (failed > 0) {
      work.fail(`${failed} job${failed === 1 ? '' : 's'} failed in the last hour`, { timed: false })
      return
    }
    const queues = field(body, 'queues')
    const backed = isObject(queues)
      ? Object.entries(queues).filter(
          ([, depth]) => typeof depth === 'number' && depth > QUEUE_BACKLOG
        )
      : []
    if (!backed.length) return work.pass()
    work.fail(
      `${backed.length} queue${backed.length === 1 ? '' : 's'} backed up: ` +
        backed.map(([name, depth]) => `${name} (${String(depth)})`).join(', '),
      { timed: false }
    )
  })
}

/**
 * How stale a published document may be before it says something about the index.
 *
 * Neither Leaflet nor Offprint publishes a cursor — Leaflet's consumer has no HTTP
 * server at all and keeps its cursor in a file — so the only thing observable from
 * outside is the newest document each of them will show you. That moves in days, not
 * seconds, so this catches an index that has genuinely stopped and nothing finer.
 */
const PUBLISHED_STALE_MS = 30 * 86_400_000

/** The first date inside an RSS or Atom feed's own header, in epoch milliseconds. */
function feedUpdatedAt(body: unknown): number | null {
  if (typeof body !== 'string') return null
  const match = /<(?:updated|lastBuildDate)>([^<]+)<\/(?:updated|lastBuildDate)>/.exec(body)
  if (!match) return null
  const time = Date.parse(match[1]!.trim())
  return Number.isNaN(time) ? null : time
}

function probeLeaflet(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const { publication, feed } = ctx.targets.apps.leaflet
  const { query } = CATALOGUE.apps.leaflet
  const collection = EXPECTED_RESPONSES.standardSite.publicationCollection
  const expected = `at://${publication.did}/${collection}/${publication.rkey}`
  const lookup = addCheck(
    checks,
    ctx,
    'publication',
    http(host, `/lish/${publication.did}/${publication.rkey}/.well-known/${collection}`)
  )
  const search = addCheck(checks, ctx, 'search', http(host, '/api/rpc/search_publication_names'))

  const work: Promise<unknown>[] = [
    // Seventy-seven bytes, and genuinely database-backed: a made-up document returns an
    // empty 404 rather than echoing back what it was asked.
    request(
      ctx,
      lookup,
      (body) =>
        (typeof body === 'string' && body.trim() === expected) || 'Publication did not resolve',
      {
        as: 'text'
      }
    ),
    request(
      ctx,
      search,
      (body) => {
        const found = field(body, 'result', 'publications') ?? field(body, 'publications')
        return (Array.isArray(found) && found.length > 0) || 'Search returned nothing'
      },
      {
        method: 'POST',
        body: JSON.stringify({ query }),
        headers: { 'content-type': 'application/json' }
      }
    )
  ]

  // Twelve kilobytes for a date that moves in hours: hourly is plenty.
  if (due(ctx, `leaflet:${host}`)) {
    const fresh = addCheck(
      checks,
      ctx,
      'newest document',
      http(host, `/lish/${feed.did}/${feed.rkey}/atom`)
    )
    work.push(
      request(
        ctx,
        fresh,
        (body) => {
          const updated = feedUpdatedAt(body)
          if (updated === null) return 'Feed carried no date'
          const lag = ctx.now() - updated
          return lag > PUBLISHED_STALE_MS ? `Newest document is ${humanDuration(lag)} old` : true
        },
        { as: 'text' }
      )
    )
  }
  return Promise.all(work)
}

function probeOffprint(host: string, checks: ProbeCheck[], ctx: ProbeContext): Promise<unknown> {
  const { publicationHost } = CATALOGUE.apps.offprint
  const { publication } = ctx.targets.apps.offprint
  const { upMarker } = EXPECTED_RESPONSES.offprint
  const collection = EXPECTED_RESPONSES.standardSite.publicationCollection
  const up = addCheck(checks, ctx, 'up', http(host, '/up'))
  const lookup = addCheck(
    checks,
    ctx,
    'publication',
    http(publicationHost, `/.well-known/${collection}`)
  )

  const work: Promise<unknown>[] = [
    // Laravel's own health route, which does not touch the database — process liveness
    // only. Its body also carries the origin's own render time, if that is ever wanted.
    request(
      ctx,
      up,
      (body) => (typeof body === 'string' && body.includes(upMarker)) || 'Application is not up',
      { as: 'text' }
    ),
    // Resolves a custom-domain mapping out of the database: a subdomain it does not know
    // redirects instead of answering.
    request(
      ctx,
      lookup,
      (body) =>
        (typeof body === 'string' && body.trim() === publication) || 'Publication did not resolve',
      { as: 'text' }
    )
  ]

  // The newest article across every publication on the platform, which is the most
  // direct staleness signal either publishing app offers — and sixty-one kilobytes
  // gzipped, with no limit parameter that works. So it runs hourly, not every sweep.
  if (due(ctx, `offprint:${host}`)) {
    const fresh = addCheck(checks, ctx, 'newest article', http(host, '/feed'))
    work.push(
      request(
        ctx,
        fresh,
        (body) => {
          const updated = feedUpdatedAt(body)
          if (updated === null) return 'Feed carried no date'
          const lag = ctx.now() - updated
          return lag > PUBLISHED_STALE_MS ? `Newest article is ${humanDuration(lag)} old` : true
        },
        { as: 'text' }
      )
    )
  }
  return Promise.all(work)
}

/**
 * Run every check for one service, pushing each onto `checks` as it is created so the
 * dashboard can show them filling in. Never rejects: a failure is a check's verdict,
 * not an exception.
 */
export async function probeService(
  service: ServiceDefinition,
  checks: ProbeCheck[],
  ctx: ProbeContext
): Promise<void> {
  switch (service.kind) {
    case 'relay':
      await probeRelay(service.host, checks, ctx)
      break
    case 'pds':
      await probePds(service.host, checks, ctx)
      break
    case 'appview':
      await probeAppView(service.host, checks, ctx)
      break
    case 'feed':
      await probeFeed(service.host, checks, ctx)
      break
    case 'constellation':
      await probeConstellation(service.host, checks, ctx)
      break
    case 'cdn':
      await probeCdn(service.host, checks, ctx)
      break
    case 'internet':
      await probeInternet(service.id, checks, ctx)
      break
    case 'jetstream':
      await probeJetstream(service.host, checks, ctx)
      break
    case 'spacedust':
      await probeSpacedust(service.host, checks, ctx)
      break
    case 'ufos':
      await probeUfos(service.host, checks, ctx)
      break
    case 'slingshot':
      await probeSlingshot(service.host, checks, ctx)
      break
    case 'foryou':
      await probeForYou(service.host, checks, ctx)
      break
    case 'tangled-appview':
      await probeTangledAppview(service.host, checks, ctx)
      break
    case 'bobbin':
      await probeBobbin(service.host, checks, ctx)
      break
    case 'hydrant':
      await probeHydrant(service.host, checks, ctx)
      break
    case 'knot':
      await probeKnot(service.host, checks, ctx)
      break
    case 'spindle':
      await probeSpindle(service.host, checks, ctx)
      break
    case 'pckt':
      await probePckt(service.host, checks, ctx)
      break
    case 'leaflet':
      await probeLeaflet(service.host, checks, ctx)
      break
    case 'offprint':
      await probeOffprint(service.host, checks, ctx)
      break
  }
}
