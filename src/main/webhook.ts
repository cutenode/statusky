/**
 * The local receiver for pushed status updates.
 *
 * Hosted status pages will POST every incident to a URL you give them — see
 * https://status.bsky.app/subscribe/webhook — so this listens for those deliveries and
 * hands the bodies to the model, which files them into the feed exactly like polled
 * posts. `src/shared/webhook.ts` does the understanding; this file does the sockets.
 *
 * Two things constrain the design:
 *
 * **It binds to loopback only.** A menu bar app has no business listening on a network
 * interface, and a status page cannot reach a laptop directly in any case. Making the
 * endpoint public is the user's decision, taken outside the app with a tunnel pointed
 * at this port, which is also where TLS comes from.
 *
 * **The path is the credential.** Deliveries carry no signature a subscriber can verify
 * — neither Instatus nor Statuspage lets the subscriber choose a signing key — so the
 * endpoint is `/webhook/<secret>` with a 192-bit random secret, compared in constant
 * time, and every other path is a flat 404 that says nothing about which part was
 * wrong. Anything that can read the secret has already read the config file.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WebhookStatus } from '../shared/types'

/** Loopback only. See the note above. */
export const WEBHOOK_HOST = '127.0.0.1'

/** Enough to hold an incident with a long update history, and nothing like enough to hurt. */
export const MAX_BODY_BYTES = 256 * 1024

/** A delivery that has not finished arriving within this is not a delivery. */
const REQUEST_TIMEOUT_MS = 15_000

/** One status page needs one connection; the rest is someone else. */
const MAX_CONNECTIONS = 16

export function generateWebhookSecret(): string {
  return randomBytes(24).toString('base64url')
}

/** Constant-time string compare that does not leak the length either. */
function secretMatches(candidate: string, secret: string): boolean {
  const a = Buffer.from(candidate)
  const b = Buffer.from(secret)
  if (a.length !== b.length) {
    // Still do the work, against `b` itself, so a wrong length is not faster.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

export interface WebhookReceiverDeps {
  /** Read at request time, so regenerating the secret takes effect immediately. */
  secret(): string
  /** Called with the parsed JSON body of an accepted delivery. */
  onDelivery(body: unknown): void
}

interface Listening {
  server: Server
  port: number
}

/**
 * Owns the HTTP server and the counters behind `AppState.webhook`.
 *
 * `start` and `stop` are idempotent and serialised: the settings panel can toggle the
 * switch or retype the port faster than a socket closes, and neither should be able to
 * leave two servers bound or a half-open one behind.
 */
export class WebhookReceiver {
  private listening: Listening | null = null
  private transition: Promise<void> = Promise.resolve()
  private error: string | null = null
  private deliveries = 0
  private lastDeliveryAt: string | null = null

  constructor(private readonly deps: WebhookReceiverDeps) {}

  status(): WebhookStatus {
    return {
      state: this.listening ? 'listening' : this.error ? 'error' : 'off',
      url: this.listening ? this.endpoint(this.listening.port) : null,
      port: this.listening?.port ?? null,
      error: this.error,
      deliveries: this.deliveries,
      lastDeliveryAt: this.lastDeliveryAt
    }
  }

  private endpoint(port: number): string {
    return `http://${WEBHOOK_HOST}:${port}/webhook/${this.deps.secret()}`
  }

  /**
   * Listen on `port`, replacing any server already running on a different one.
   * Port 0 asks the OS for a free port, which is what the tests use.
   */
  start(port: number): Promise<void> {
    return this.serialise(async () => {
      if (this.listening?.port === port) return
      await this.close()
      await this.open(port)
    })
  }

  stop(): Promise<void> {
    return this.serialise(async () => {
      await this.close()
      this.error = null
    })
  }

  /**
   * Run state changes one at a time, so a fast toggle cannot interleave them.
   * Neither `open` nor `close` rejects — a failed bind is reported as state, not
   * thrown — so the chain cannot be broken by one.
   */
  private serialise(work: () => Promise<void>): Promise<void> {
    this.transition = this.transition.then(work)
    return this.transition
  }

  private open(port: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const server = createServer((request, response) => {
        void this.handle(request, response)
      })
      server.maxConnections = MAX_CONNECTIONS
      server.requestTimeout = REQUEST_TIMEOUT_MS
      server.headersTimeout = REQUEST_TIMEOUT_MS

      // One handler for the whole life of the server. Failing to bind and failing
      // later come to the same thing — we are not listening and the user needs to
      // be told why — and resolving a promise that has already settled is a no-op.
      server.on('error', (error: Error) => {
        this.error = describeListenError(error, port)
        this.listening = null
        server.close()
        resolve()
      })

      server.listen(port, WEBHOOK_HOST, () => {
        // Port 0 asked the OS to choose; report back the one it actually gave us.
        // Always an `AddressInfo`: this listens on a host and a port, never a pipe.
        const bound = (server.address() as AddressInfo).port
        this.listening = { server, port: bound }
        this.error = null
        // Listening must never be the reason the process stays alive on quit.
        server.unref()
        resolve()
      })
    })
  }

  private close(): Promise<void> {
    const current = this.listening
    if (!current) return Promise.resolve()
    this.listening = null
    return new Promise<void>((resolve) => {
      // `close` waits for open connections; a status page keeping one alive must not
      // stall the toggle, so drop them.
      current.server.closeAllConnections?.()
      current.server.close(() => resolve())
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '').split('?')[0]!
    const prefix = '/webhook/'

    if (!path.startsWith(prefix) || !secretMatches(path.slice(prefix.length), this.deps.secret())) {
      // Same answer for a wrong path and a wrong secret: neither is worth confirming.
      return send(response, 404, { error: 'Not found' })
    }

    // A plain GET is how a user checks that their tunnel actually reaches the app.
    if (request.method === 'GET' || request.method === 'HEAD') {
      return send(response, 200, { ok: true, app: 'statusky', listening: true })
    }

    if (request.method !== 'POST') {
      response.setHeader('allow', 'GET, POST')
      return send(response, 405, { error: 'Method not allowed' })
    }

    // Only JSON. A browser can send `text/plain` cross-origin without a preflight,
    // and while it could not guess the secret, there is no reason to accept it.
    const contentType = request.headers['content-type'] ?? ''
    if (!/\bjson\b/i.test(contentType)) {
      return send(response, 415, { error: 'Expected a JSON body' })
    }

    let raw: string
    try {
      raw = await readBody(request)
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'too-large'
      return send(response, tooLarge ? 413 : 400, {
        error: tooLarge ? 'Payload too large' : 'Could not read the request body'
      })
    }

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return send(response, 400, { error: 'Invalid JSON' })
    }

    this.deliveries += 1
    this.lastDeliveryAt = new Date().toISOString()
    this.deps.onDelivery(body)

    // Accepted either way: a provider that sees failures eventually stops delivering,
    // and whether the payload was one we understand is not the sender's problem.
    send(response, 200, { ok: true })
  }
}

/** Turn a `listen` failure into something a user can act on. */
export function describeListenError(error: Error, port: number): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') return `Port ${port} is already in use.`
  if (code === 'EACCES') return `Port ${port} needs elevated privileges. Pick one above 1023.`
  return error.message || 'The webhook receiver could not start.'
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // Nothing here is for a browser to read, and nothing should be cached.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(response.req.method === 'HEAD' ? undefined : payload)
}

/** Read the body, refusing anything past the cap without waiting for the rest of it. */
function readBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Promise.reject(new Error('too-large'))
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        request.destroy()
        reject(new Error('too-large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', (error) => reject(error))
  })
}
