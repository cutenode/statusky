/**
 * The receiver is tested against a real loopback socket rather than a mocked
 * `http` module: what matters here is what an actual HTTP request gets back, and a
 * double of `createServer` would only ever confirm the shape of the calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import {
  describeListenError,
  generateWebhookSecret,
  MAX_BODY_BYTES,
  WEBHOOK_HOST,
  WebhookReceiver
} from './webhook'

const SECRET = 'test-secret-value'

const live: WebhookReceiver[] = []

afterEach(async () => {
  await Promise.all(live.splice(0).map((receiver) => receiver.stop()))
})

interface Started {
  receiver: WebhookReceiver
  onDelivery: ReturnType<typeof vi.fn>
  secret: () => string
  url: string
  port: number
}

async function start(options: { secret?: () => string; port?: number } = {}): Promise<Started> {
  const secret = options.secret ?? ((): string => SECRET)
  const onDelivery = vi.fn()
  const receiver = new WebhookReceiver({ secret, onDelivery })
  live.push(receiver)

  await receiver.start(options.port ?? 0)
  const status = receiver.status()
  if (status.state !== 'listening' || !status.url || status.port === null) {
    throw new Error(`expected to be listening, got ${status.state}: ${status.error}`)
  }
  return { receiver, onDelivery, secret, url: status.url, port: status.port }
}

function endpoint(port: number, path = `/webhook/${SECRET}`): string {
  return `http://${WEBHOOK_HOST}:${port}${path}`
}

function post(url: string, body: string, contentType = 'application/json'): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body })
}

const PAYLOAD = {
  page: { id: 'pg', url: 'https://status.bsky.app' },
  incident: { id: 'inc', name: 'Down', status: 'INVESTIGATING' }
}

describe('listening', () => {
  it('reports the endpoint a status page should be given', async () => {
    const { receiver, port } = await start()

    expect(receiver.status()).toMatchObject({
      state: 'listening',
      port,
      error: null,
      deliveries: 0,
      lastDeliveryAt: null
    })
    expect(receiver.status().url).toBe(endpoint(port))
  })

  it('binds loopback only, so nothing off this machine can reach it', async () => {
    const { receiver } = await start()
    expect(receiver.status().url).toContain('127.0.0.1')
  })

  it('answers a GET on the endpoint, which is how a tunnel gets checked', async () => {
    const { port } = await start()

    const response = await fetch(endpoint(port))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, app: 'statusky', listening: true })
  })

  it('answers a HEAD with headers and no body', async () => {
    const { port } = await start()

    const response = await fetch(endpoint(port), { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it('stops listening on request', async () => {
    const { receiver, port } = await start()

    await receiver.stop()

    expect(receiver.status()).toMatchObject({ state: 'off', url: null, port: null })
    await expect(fetch(endpoint(port))).rejects.toThrow()
  })

  it('is idempotent: starting on the port it already has changes nothing', async () => {
    const { receiver, port } = await start()

    await receiver.start(port)

    expect(receiver.status().port).toBe(port)
    expect((await fetch(endpoint(port))).status).toBe(200)
  })

  it('moves to a new port and stops answering on the old one', async () => {
    const { receiver, port } = await start()

    await receiver.start(0)
    const moved = receiver.status().port!

    expect(moved).not.toBe(port)
    expect((await fetch(endpoint(moved))).status).toBe(200)
    await expect(fetch(endpoint(port))).rejects.toThrow()
  })

  it('survives being toggled faster than a socket closes', async () => {
    const receiver = new WebhookReceiver({ secret: () => SECRET, onDelivery: vi.fn() })
    live.push(receiver)

    await Promise.all([receiver.start(0), receiver.stop(), receiver.start(0), receiver.stop()])

    expect(receiver.status().state).toBe('off')
  })

  it('reports a port that is already taken instead of failing silently', async () => {
    const { port } = await start()
    const second = new WebhookReceiver({ secret: () => SECRET, onDelivery: vi.fn() })
    live.push(second)

    await second.start(port)

    expect(second.status()).toMatchObject({
      state: 'error',
      url: null,
      error: `Port ${port} is already in use.`
    })
  })

  it('clears a previous failure when it is switched off', async () => {
    const { port } = await start()
    const second = new WebhookReceiver({ secret: () => SECRET, onDelivery: vi.fn() })
    live.push(second)
    await second.start(port)

    await second.stop()

    expect(second.status()).toMatchObject({ state: 'off', error: null })
  })

  it('explains the failures a user can do something about', () => {
    const inUse = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    const denied = Object.assign(new Error('listen EACCES'), { code: 'EACCES' })
    const other = Object.assign(new Error('something else broke'), { code: 'EWAT' })

    expect(describeListenError(inUse, 7385)).toBe('Port 7385 is already in use.')
    expect(describeListenError(denied, 80)).toBe(
      'Port 80 needs elevated privileges. Pick one above 1023.'
    )
    expect(describeListenError(other, 7385)).toBe('something else broke')
    expect(describeListenError(new Error(''), 7385)).toBe('The webhook receiver could not start.')
  })
})

describe('accepting a delivery', () => {
  it('hands the parsed body straight through and counts it', async () => {
    const { receiver, onDelivery, port } = await start()

    const response = await post(endpoint(port), JSON.stringify(PAYLOAD))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(onDelivery).toHaveBeenCalledWith(PAYLOAD)
    expect(receiver.status().deliveries).toBe(1)
    expect(Date.parse(receiver.status().lastDeliveryAt!)).toBeGreaterThan(0)
  })

  it('accepts a body it cannot make sense of, so the provider keeps delivering', async () => {
    const { onDelivery, port } = await start()

    const response = await post(endpoint(port), JSON.stringify({ hello: 'world' }))

    expect(response.status).toBe(200)
    expect(onDelivery).toHaveBeenCalledWith({ hello: 'world' })
  })

  it('accepts a charset on the content type', async () => {
    const { onDelivery, port } = await start()

    const response = await post(
      endpoint(port),
      JSON.stringify(PAYLOAD),
      'application/json; charset=utf-8'
    )

    expect(response.status).toBe(200)
    expect(onDelivery).toHaveBeenCalled()
  })

  it('never lets a delivery be cached or sniffed into something else', async () => {
    const { port } = await start()

    const response = await post(endpoint(port), '{}')

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('ignores a query string on the endpoint', async () => {
    const { onDelivery, port } = await start()

    const response = await post(endpoint(port, `/webhook/${SECRET}?attempt=2`), '{}')

    expect(response.status).toBe(200)
    expect(onDelivery).toHaveBeenCalled()
  })
})

describe('refusing everything else', () => {
  it('gives a wrong secret the same flat 404 as a wrong path', async () => {
    const { onDelivery, port } = await start()

    const wrongSecret = await post(endpoint(port, '/webhook/not-the-secret'), '{}')
    const wrongPath = await post(endpoint(port, '/'), '{}')
    // Same length as the real secret: the compare is constant-time, not a prefix match.
    const sameLength = await post(endpoint(port, `/webhook/${'x'.repeat(SECRET.length)}`), '{}')

    expect([wrongSecret.status, wrongPath.status, sameLength.status]).toEqual([404, 404, 404])
    expect(await wrongSecret.json()).toEqual({ error: 'Not found' })
    expect(onDelivery).not.toHaveBeenCalled()
  })

  it('refuses a method that is neither a check nor a delivery', async () => {
    const { port } = await start()

    const response = await fetch(endpoint(port), {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' }
    })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
  })

  it('refuses a body that is not declared as JSON', async () => {
    const { onDelivery, port } = await start()

    const response = await post(endpoint(port), JSON.stringify(PAYLOAD), 'text/plain')

    expect(response.status).toBe(415)
    expect(onDelivery).not.toHaveBeenCalled()
  })

  it('refuses a body that is not valid JSON', async () => {
    const { onDelivery, port } = await start()

    const response = await post(endpoint(port), 'not json at all')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid JSON' })
    expect(onDelivery).not.toHaveBeenCalled()
    // A refused body is not a delivery.
    expect(live.at(-1)!.status().deliveries).toBe(0)
  })

  it('refuses a body with no content type at all', async () => {
    const { onDelivery, port } = await start()

    const status = await new Promise<number>((resolve) => {
      const req = httpRequest(
        { host: WEBHOOK_HOST, port, path: `/webhook/${SECRET}`, method: 'POST' },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.end('{}')
    })

    expect(status).toBe(415)
    expect(onDelivery).not.toHaveBeenCalled()
  })

  it('gives up on a body the client abandons half way through', async () => {
    const { receiver, onDelivery, port } = await start()

    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: WEBHOOK_HOST,
        port,
        path: `/webhook/${SECRET}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '128' }
      })
      req.on('error', () => resolve())
      // Promise a body, send a fragment of it, then walk away.
      req.write('{"page"')
      setTimeout(() => {
        req.destroy()
        resolve()
      }, 20)
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onDelivery).not.toHaveBeenCalled()
    expect(receiver.status().deliveries).toBe(0)
  })

  it('refuses an oversized body on the declared length alone', async () => {
    const { onDelivery, port } = await start()

    const response = await fetch(endpoint(port), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) },
      body: 'x'.repeat(MAX_BODY_BYTES + 1)
    })

    expect(response.status).toBe(413)
    expect(onDelivery).not.toHaveBeenCalled()
  })

  it('refuses an oversized body that never declared a length', async () => {
    const { onDelivery, port } = await start()

    const status = await new Promise<number | 'aborted'>((resolve) => {
      const req = httpRequest(
        {
          host: WEBHOOK_HOST,
          port,
          path: `/webhook/${SECRET}`,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      // The connection is torn down as soon as the cap is passed, which a client
      // may see as a reset rather than as a response.
      req.on('error', () => resolve('aborted'))
      req.write('x'.repeat(MAX_BODY_BYTES + 1024))
      req.end()
    })

    expect([413, 'aborted']).toContain(status)
    expect(onDelivery).not.toHaveBeenCalled()
  })
})

describe('the secret', () => {
  it('is long and URL-safe, and never repeats', () => {
    const a = generateWebhookSecret()
    const b = generateWebhookSecret()

    expect(a).toMatch(/^[\w-]{32}$/)
    expect(a).not.toBe(b)
  })

  it('is read per request, so a new one invalidates the old URL immediately', async () => {
    let current = 'first-secret'
    const { receiver, port } = await start({ secret: () => current })

    expect((await fetch(endpoint(port, '/webhook/first-secret'))).status).toBe(200)

    current = 'second-secret'

    expect(receiver.status().url).toBe(endpoint(port, '/webhook/second-secret'))
    expect((await fetch(endpoint(port, '/webhook/first-secret'))).status).toBe(404)
    expect((await fetch(endpoint(port, '/webhook/second-secret'))).status).toBe(200)
  })
})
