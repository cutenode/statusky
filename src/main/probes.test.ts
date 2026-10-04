import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOGUE,
  SERVICES,
  probeState,
  servicesFor,
  type ServiceDefinition
} from '../shared/network'
import { DEFAULT_PROBE_TARGETS } from '../shared/probe-targets'
import type { ProbeCheck, ProbeTargets } from '../shared/types'
import { commitFrame, errorFrame, frame } from '../test/cbor'
import {
  FakeNetwork,
  FakeSocket,
  jetstreamEvent,
  spacedustLink,
  tid,
  type HttpFailure
} from '../test/network'
import {
  DEFAULT_PROBE_TIMINGS,
  FreshnessPeers,
  IndexSample,
  TargetCensus,
  describeError,
  vanishedTargets,
  type Sighting,
  newestPostTime,
  probeService,
  readFrame,
  tidToMillis,
  type NewestPosts,
  type ProbeContext,
  type ProbeCounters,
  type ProbeSocket,
  type ProbeTimings,
  type ProbeTransport
} from './probes'

const network = new FakeNetwork()

afterEach(() => {
  network.reset()
  vi.useRealTimers()
})

/** Short waits, so the firehose's patience does not become the test's. */
const QUICK: ProbeTimings = {
  ...DEFAULT_PROBE_TIMINGS,
  requestTimeoutMs: 2_000,
  firehoseWindowMs: 60,
  indexGraceMs: 0
}

interface Probe {
  checks: ProbeCheck[]
  changes: number
}

/** What the monitor keeps between sweeps, for one test at a time. */
function memoryCounters(): ProbeCounters {
  const tallies = new Map<string, number>()
  return {
    get: (key) => tallies.get(key) ?? null,
    set: (key, value) => {
      tallies.set(key, value)
    }
  }
}

function service(id: string): ServiceDefinition {
  const found = SERVICES.find((s) => s.id === id)
  if (!found) throw new Error(`No service ${id}`)
  return found
}

function context(overrides: Partial<ProbeContext> = {}): ProbeContext & { changes: () => number } {
  let changes = 0
  return {
    transport: network,
    signal: new AbortController().signal,
    timings: QUICK,
    now: Date.now,
    changed: () => {
      changes++
    },
    peers: new FreshnessPeers(1),
    sample: new IndexSample(),
    census: new TargetCensus(1),
    counters: memoryCounters(),
    targets: DEFAULT_PROBE_TARGETS,
    changes: () => changes,
    ...overrides
  }
}

/** The checked-in targets with some part replaced, as a user's override would be. */
function targets(changes: Partial<ProbeTargets>): ProbeTargets {
  return { ...structuredClone(DEFAULT_PROBE_TARGETS), ...changes }
}

async function probe(id: string, overrides: Partial<ProbeContext> = {}): Promise<Probe> {
  const checks: ProbeCheck[] = []
  const ctx = context(overrides)
  await probeService(service(id), checks, ctx)
  return { checks, changes: ctx.changes() }
}

function check(checks: ProbeCheck[], label: string, index = 0): ProbeCheck {
  const found = checks.filter((c) => c.label === label)[index]
  if (!found) throw new Error(`No ${label} check among ${checks.map((c) => c.label).join(', ')}`)
  return found
}

/** Have one path on `host` answer with exactly this JSON. */
function answer(host: string, path: string, body: unknown): void {
  network.fail(
    host,
    { kind: 'respond', body: JSON.stringify(body), contentType: 'application/json' },
    path
  )
}

/** A fresh Spacedust link frame with some of it replaced. */
function link(changes: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(spacedustLink()), ...changes })
}

/** The labels of the checks excused on a row. */
function excused(checks: ProbeCheck[]): string[] {
  return checks.filter((c) => c.excused !== undefined).map((c) => c.label)
}

/** One AppView's sightings, as it reports them to a census. */
function sightings(entries: [string, Sighting][]): Map<string, Sighting> {
  return new Map(entries)
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000)
}

describe('a relay', () => {
  const id = 'relay:bsky.network'

  it('passes its health check, its host list and its firehose', async () => {
    const { checks, changes } = await probe(id)

    expect(checks.map((c) => [c.label, c.kind, c.ok])).toEqual([
      ['_health', 'http', true],
      ['listHosts', 'http', true],
      ['firehose', 'stream', true]
    ])
    expect(check(checks, '_health').target).toBe('https://bsky.network/xrpc/_health')
    expect(check(checks, 'firehose').target).toBe(
      'wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos'
    )
    expect(check(checks, 'firehose').durationMs).toEqual(expect.any(Number))
    // Every check reports when it starts and again when it settles.
    expect(changes).toBe(6)
  })

  it('asks for uncached answers and sends no cookies', async () => {
    await probe(id)
    const requests = network.requestsTo('bsky.network')
    expect(requests.map((r) => r.path)).toEqual([
      '/xrpc/_health',
      '/xrpc/com.atproto.sync.listHosts'
    ])
    for (const request of requests) {
      expect(request.cache).toBe('no-store')
      expect(request.credentials).toBe('omit')
    }
  })

  it('reads the firehose as binary and hangs up once it has its answer', async () => {
    await probe(id)
    const [socket] = network.sockets
    expect(socket!.binaryType).toBe('arraybuffer')
    expect(socket!.closed).toBe(true)
    expect(socket!.listening()).toBe(0)
  })

  it('fails a health check that does not say ok', async () => {
    network.fail(
      'bsky.network',
      { kind: 'respond', body: '{"status":"degraded"}', contentType: 'application/json' },
      '/xrpc/_health'
    )
    const { checks } = await probe(id)
    expect(check(checks, '_health')).toMatchObject({ ok: false, error: 'Invalid response' })
    expect(check(checks, 'listHosts').ok).toBe(true)
  })

  it.each([
    ['stale', 'Newest commit is 2 hours old', null],
    ['silent', 'No commits received', expect.any(Number)],
    ['unopened', 'Firehose connection timed out', expect.any(Number)],
    ['socket-error', 'Firehose connection failed', expect.any(Number)],
    ['close', 'Firehose connection closed (1006)', expect.any(Number)],
    ['error-frame', 'ConsumerTooSlow: Stream consumer too slow', expect.any(Number)],
    ['garbage', 'Failed to decode a firehose frame', expect.any(Number)],
    ['invalid-time', 'Received invalid timestamp', expect.any(Number)],
    ['throws', 'DNS lookup failed', expect.any(Number)]
  ] as const)('fails a %s firehose', async (behaviour, error, durationMs) => {
    network.setFirehose('bsky.network', behaviour)
    const { checks } = await probe(id)
    expect(check(checks, 'firehose')).toMatchObject({ ok: false, error, durationMs })
  })

  it('fails a commit whose time is not a string', async () => {
    network.setFirehose('bsky.network', 'silent')
    const checks: ProbeCheck[] = []
    const done = probeService(service(id), checks, context())
    await vi.waitFor(() => expect(network.sockets).toHaveLength(1))
    network.sockets[0]!.emit(frame({ op: 1, t: '#commit' }, { time: 1_700_000_000 }))
    await done
    expect(check(checks, 'firehose').error).toBe('Received invalid timestamp')
  })

  it('skips events that are not commits', async () => {
    network.setFirehose('bsky.network', 'other-then-fresh')
    const { checks } = await probe(id)
    expect(check(checks, 'firehose').ok).toBe(true)
  })

  /**
   * The two silences a stream check can end in are different news, and the wording is
   * the only thing that tells them apart on the dashboard: a relay that sent nothing,
   * and a socket that never opened to hear it. A frame settles it either way — it is
   * proof the connection came up, whatever the `open` event did or did not do.
   */
  it('counts a frame it skipped as proof the connection came up', async () => {
    network.setFirehose('bsky.network', 'unopened')
    const checks: ProbeCheck[] = []
    const done = probeService(service(id), checks, context())
    await vi.waitFor(() => expect(network.sockets).toHaveLength(1))
    network.sockets[0]!.emit(frame({ op: 1, t: '#identity' }, { seq: 1, did: 'did:plc:someone' }))
    await done
    expect(check(checks, 'firehose').error).toBe('No commits received')
  })

  /**
   * Electron's `net.WebSocket` is typed as a bare `EventTarget`, whose listeners are
   * promised an `Event` and nothing on it. These are the events that promise allows.
   */
  describe('on a socket whose events carry nothing', () => {
    function bare(): { transport: ProbeTransport; dispatch(type: string): void } {
      const events = new EventTarget()
      const socket: ProbeSocket = {
        binaryType: 'blob',
        addEventListener: (type, listener, options) =>
          events.addEventListener(type, listener, options),
        close: () => {}
      }
      return {
        transport: { fetch: (url, init) => network.fetch(url, init), openSocket: () => socket },
        dispatch: (type) => void events.dispatchEvent(new Event(type))
      }
    }

    it.each([
      ['close', 'Firehose connection closed'],
      ['message', 'Failed to decode a firehose frame']
    ])('reads a %s with nothing on it', async (type, error) => {
      const { transport, dispatch } = bare()
      const checks: ProbeCheck[] = []
      const timings = { ...QUICK, firehoseWindowMs: 2_000 }
      const done = probeService(service(id), checks, context({ transport, timings }))
      await vi.waitFor(() => expect(check(checks, 'firehose').ok).toBeNull())
      dispatch(type)
      await done
      expect(check(checks, 'firehose').error).toBe(error)
    })
  })

  it('passes as soon as a fresh commit follows a stale one', async () => {
    network.setFirehose('bsky.network', 'silent')
    const checks: ProbeCheck[] = []
    const done = probeService(
      service(id),
      checks,
      context({ timings: { ...QUICK, firehoseWindowMs: 5_000 } })
    )
    await vi.waitFor(() => expect(network.sockets).toHaveLength(1))
    const socket = network.sockets[0]!
    socket.emit(commitFrame(new Date(Date.now() - 3_600_000).toISOString()))
    expect(check(checks, 'firehose').ok).toBeNull()
    socket.emit(commitFrame())
    await done
    expect(check(checks, 'firehose').ok).toBe(true)
  })

  it('reports the freshest commit it saw when none was fresh enough', async () => {
    network.setFirehose('bsky.network', 'silent')
    const checks: ProbeCheck[] = []
    const done = probeService(service(id), checks, context())
    await vi.waitFor(() => expect(network.sockets).toHaveLength(1))
    const socket = network.sockets[0]!
    socket.emit(commitFrame(new Date(Date.now() - 3 * 3_600_000).toISOString()))
    socket.emit(commitFrame(new Date(Date.now() - 5 * 60_000).toISOString()))
    socket.emit(commitFrame(new Date(Date.now() - 2 * 3_600_000).toISOString()))
    await done
    expect(check(checks, 'firehose').error).toBe('Newest commit is 5 minutes old')
  })

  it('gives up on the firehose when the sweep is abandoned', async () => {
    network.setFirehose('bsky.network', 'silent')
    const controller = new AbortController()
    const checks: ProbeCheck[] = []
    const done = probeService(
      service(id),
      checks,
      context({ signal: controller.signal, timings: { ...QUICK, firehoseWindowMs: 60_000 } })
    )
    await vi.waitFor(() => expect(network.sockets).toHaveLength(1))
    controller.abort()
    await done
    expect(check(checks, 'firehose')).toMatchObject({
      ok: false,
      error: 'Cancelled',
      durationMs: null
    })
    expect(network.sockets[0]!.closed).toBe(true)
  })

  it('does not even connect when the sweep was abandoned before it began', async () => {
    const controller = new AbortController()
    controller.abort()
    const { checks } = await probe(id, { signal: controller.signal })
    expect(check(checks, 'firehose').error).toBe('Cancelled')
    expect(network.sockets).toHaveLength(0)
  })

  it('shrugs off a socket that throws as it closes', async () => {
    const transport: ProbeTransport = {
      fetch: network.fetch,
      openSocket: (url) => {
        const socket = new FakeSocket(url)
        socket.close = () => {
          throw new Error('InvalidStateError')
        }
        queueMicrotask(() => socket.emit(commitFrame()))
        return socket
      }
    }
    const { checks } = await probe(id, { transport })
    expect(check(checks, 'firehose').ok).toBe(true)
  })

  it('describes a socket that could not even be created', async () => {
    const transport: ProbeTransport = {
      fetch: network.fetch,
      openSocket: () => {
        throw 'not an error'
      }
    }
    const { checks } = await probe(id, { transport })
    expect(check(checks, 'firehose').error).toBe('Firehose connection failed')
  })
})

describe('any HTTP check', () => {
  // GitHub's control check is the plainest: one request, any JSON object passes.
  const id = 'internet:github'
  const host = 'api.github.com'

  it.each([
    [{ kind: 'http', status: 503 }, 'HTTP 503'],
    [{ kind: 'respond', body: '{}', contentType: null }, 'Received no content type'],
    [
      { kind: 'respond', body: '<html>', contentType: 'text/html' },
      'Received content type text/html'
    ],
    [{ kind: 'respond', body: '{nope', contentType: 'application/json' }, 'JSON parsing error'],
    [{ kind: 'respond', body: '[]', contentType: 'application/json' }, 'Invalid response'],
    [{ kind: 'network', message: 'net::ERR_CONNECTION_REFUSED' }, 'Connection refused'],
    [{ kind: 'network', message: 'fetch failed', code: 'ENOTFOUND' }, 'DNS lookup failed']
  ] as const)('fails on %o', async (failure, error) => {
    network.fail(host, failure)
    const { checks } = await probe(id)
    expect(checks[0]).toMatchObject({ ok: false, error, durationMs: expect.any(Number) })
  })

  // A body nobody reads holds its request open until it is garbage collected.
  it.each([
    ['a status it never read the body of', { kind: 'http', status: 503 }],
    [
      'a content type it never read past',
      { kind: 'respond', body: '<html>', contentType: 'text/html' }
    ],
    [
      'an answer it read to the end',
      { kind: 'respond', body: '{}', contentType: 'application/json' }
    ]
  ] as const)('hangs up after %s', async (_name, failure) => {
    network.fail(host, failure)
    await probe(id)
    expect(network.requestsTo(host).map((request) => request.signal?.aborted)).toEqual([true])
  })

  it.each([
    [
      'quotes the reason an XRPC error gives',
      { error: 'InvalidRequest', message: 'Profile not found' },
      'application/json; charset=utf-8',
      'HTTP 400 · Profile not found'
    ],
    [
      'folds a reason onto one line',
      { message: '  Upstream\n  timed out  ' },
      'application/json',
      'HTTP 400 · Upstream timed out'
    ],
    [
      'cuts a reason that runs on',
      { message: 'x'.repeat(500) },
      'application/json',
      `HTTP 400 · ${'x'.repeat(119)}…`
    ],
    [
      'says nothing more when there is no message',
      { error: 'InvalidRequest' },
      'application/json',
      'HTTP 400'
    ],
    ['does not quote an error page', { message: 'nope' }, 'text/html', 'HTTP 400']
  ])('%s', async (_name, body, contentType, error) => {
    network.fail(host, { kind: 'respond', status: 400, body: JSON.stringify(body), contentType })
    const { checks } = await probe(id)
    expect(checks[0]).toMatchObject({ ok: false, error })
  })

  it('keeps the status when an error body will not parse', async () => {
    network.fail(host, {
      kind: 'respond',
      status: 502,
      body: '{nope',
      contentType: 'application/json'
    })
    const { checks } = await probe(id)
    expect(checks[0]).toMatchObject({ ok: false, error: 'HTTP 502' })
  })

  it('keeps the status when an error body never finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    network.fail(host, { kind: 'stall', contentType: 'application/json', status: 503 })
    const checks: ProbeCheck[] = []
    const done = probeService(service(id), checks, context({ timings: DEFAULT_PROBE_TIMINGS }))
    await vi.advanceTimersByTimeAsync(30_000)
    await done
    expect(checks[0]).toMatchObject({ ok: false, error: 'HTTP 503' })
  })

  it('gives up after the request timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    network.fail(host, { kind: 'hang' })
    const checks: ProbeCheck[] = []
    const done = probeService(service(id), checks, context({ timings: DEFAULT_PROBE_TIMINGS }))
    await vi.advanceTimersByTimeAsync(30_000)
    await done
    expect(checks[0]).toMatchObject({ ok: false, error: 'Timed out after 30s' })
  })

  it.each([
    ['a JSON body', 'internet:github', 'api.github.com', 'application/json'],
    ['a text body', 'internet:aws', 'checkip.amazonaws.com', 'text/plain'],
    ['an image', 'cdn:cdn.bsky.app', 'cdn.bsky.app', 'image/webp']
  ])(
    'gives up on %s that starts and never finishes',
    async (_name, stalling, from, contentType) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      network.fail(from, { kind: 'stall', contentType })
      const checks: ProbeCheck[] = []
      const done = probeService(
        service(stalling),
        checks,
        context({ timings: DEFAULT_PROBE_TIMINGS })
      )
      await vi.advanceTimersByTimeAsync(30_000)
      await done
      expect(checks[0]).toMatchObject({ ok: false, error: 'Timed out after 30s' })
    }
  )

  it('stops when the sweep is abandoned, without blaming the service', async () => {
    network.fail(host, { kind: 'hang' })
    const controller = new AbortController()
    const checks: ProbeCheck[] = []
    const done = probeService(service(id), checks, context({ signal: controller.signal }))
    await vi.waitFor(() => expect(network.requests).toHaveLength(1))
    controller.abort()
    await done
    expect(checks[0]).toMatchObject({ ok: false, error: 'Cancelled', durationMs: null })
  })

  it('times a slow answer', async () => {
    network.fail(host, { kind: 'delay', ms: 30 })
    const { checks } = await probe(id)
    expect(checks[0]!.ok).toBe(true)
    expect(checks[0]!.durationMs).toBeGreaterThanOrEqual(25)
  })
})

describe('describeError', () => {
  it.each([
    [new Error('net::ERR_NAME_NOT_RESOLVED'), 'DNS lookup failed'],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), 'No internet connection'],
    [new Error('net::ERR_CERT_AUTHORITY_INVALID'), 'Certificate is not trusted'],
    [new Error('net::ERR_BLOCKED_BY_CLIENT'), 'net::ERR_BLOCKED_BY_CLIENT'],
    [new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), 'Connection reset'],
    [new TypeError('fetch failed', { cause: new Error('other side closed') }), 'other side closed'],
    [new TypeError('fetch failed', { cause: { code: 'EWHATEVER' } }), 'fetch failed'],
    [new Error(''), 'Request failed'],
    ['a string', 'Request failed']
  ])('turns %o into %s', (error, expected) => {
    expect(describeError(error)).toBe(expected)
  })

  it('takes a fallback of its own', () => {
    expect(describeError(null, 'Firehose connection failed')).toBe('Firehose connection failed')
  })
})

describe('a PDS', () => {
  const id = 'pds:eurosky.social'
  const host = 'eurosky.social'

  it('passes health, server description, a real read of one repository, and the relay', async () => {
    const { checks } = await probe(id)
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['_health', true],
      ['describeServer', true],
      ['listRepos', true],
      ['listRecords', true],
      ['getHostStatus', true]
    ])
    // The first *active* repository, never an inactive one.
    expect(check(checks, 'listRecords').target).toBe(
      'https://eurosky.social/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Arepo&collection=app.bsky.feed.post&limit=1'
    )
  })

  it('skips the read when listRepos fails', async () => {
    network.fail(host, { kind: 'http', status: 500 }, '/xrpc/com.atproto.sync.listRepos')
    const { checks } = await probe(id)
    expect(check(checks, 'listRecords')).toMatchObject({
      ok: false,
      error: 'Skipped because listRepos failed',
      durationMs: null,
      target: null
    })
  })

  it('skips the read when listRepos answers with nonsense', async () => {
    network.fail(
      host,
      { kind: 'respond', body: '{"repos":"no"}', contentType: 'application/json' },
      '/xrpc/com.atproto.sync.listRepos'
    )
    const { checks } = await probe(id)
    expect(check(checks, 'listRepos').error).toBe('Invalid response')
    expect(check(checks, 'listRecords').error).toBe('Skipped because listRepos failed')
  })

  it('fails the read when no repository is active', async () => {
    network.fail(
      host,
      {
        kind: 'respond',
        body: JSON.stringify({ repos: [{ did: 'did:plc:x', active: false }, 'junk'] }),
        contentType: 'application/json'
      },
      '/xrpc/com.atproto.sync.listRepos'
    )
    const { checks } = await probe(id)
    expect(check(checks, 'listRepos').ok).toBe(true)
    expect(check(checks, 'listRecords').error).toBe('No active repository found')
  })

  // `active` is optional in `com.atproto.sync.listRepos#repo`.
  it('reads a repository whose host does not say whether it is active', async () => {
    network.fail(
      host,
      {
        kind: 'respond',
        body: JSON.stringify({ repos: [{ did: 'did:plc:repo', head: 'bafy', rev: tid(0) }] }),
        contentType: 'application/json'
      },
      '/xrpc/com.atproto.sync.listRepos'
    )
    const { checks } = await probe(id)
    expect(check(checks, 'listRecords')).toMatchObject({
      ok: true,
      target: expect.stringContaining('repo=did%3Aplc%3Arepo')
    })
  })

  describe('as Bluesky’s relay sees it', () => {
    it('asks the relay whether it still carries this host', async () => {
      const { checks } = await probe(id)
      expect(check(checks, 'getHostStatus').target).toBe(
        'https://bsky.network/xrpc/com.atproto.sync.getHostStatus?hostname=eurosky.social'
      )
      // Asked of the relay, not of the PDS.
      expect(network.requestsTo(host).map((r) => r.path)).not.toContain(
        '/xrpc/com.atproto.sync.getHostStatus'
      )
    })

    // A small PDS with nothing to say lately is still being listened to.
    it('takes an idle host as carried', async () => {
      network.setHostStatus(host, 'idle')
      const { checks } = await probe(id)
      expect(check(checks, 'getHostStatus').ok).toBe(true)
    })

    it.each(['throttled', 'banned', 'offline'])(
      'fails a host the relay marks %s',
      async (status) => {
        network.setHostStatus(host, status)
        const { checks } = await probe(id)
        expect(check(checks, 'getHostStatus')).toMatchObject({
          ok: false,
          error: `bsky.network marks this host ${status}`
        })
        // Everything asked of the PDS itself still passed: the row reads as partial.
        expect(probeState(checks)).toBe('partial')
      }
    )

    it('fails a host the relay has never heard of', async () => {
      network.setHostStatus(host, null)
      const { checks } = await probe(id)
      expect(check(checks, 'getHostStatus')).toMatchObject({
        ok: false,
        error: 'bsky.network does not carry this host'
      })
    })

    it.each<[string, HttpFailure]>([
      ['a server error', { kind: 'http', status: 502 }],
      ['a failed connection', { kind: 'network', message: 'net::ERR_CONNECTION_REFUSED' }],
      [
        'a route it does not have',
        {
          kind: 'respond',
          body: '{"error":"MethodNotImplemented"}',
          contentType: 'application/json',
          status: 501
        }
      ],
      ['an answer about nothing', { kind: 'respond', body: '{}', contentType: 'application/json' }]
    ])('leaves the check out when the relay answers with %s', async (_name, failure) => {
      network.fail('bsky.network', failure)
      const { checks } = await probe(id)
      // The relay's own row says what is wrong with it; the PDS is not blamed.
      expect(checks.map((c) => c.label)).toEqual([
        '_health',
        'describeServer',
        'listRepos',
        'listRecords'
      ])
      expect(probeState(checks)).toBe('live')
    })
  })
})

describe('Bluesky’s entryway', () => {
  const id = 'entryway:bsky.social'

  it('checks health, the server’s own description and its OAuth metadata', async () => {
    const { checks } = await probe(id)
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['_health', true],
      ['describeServer', true],
      ['OAuth metadata', true]
    ])
    expect(check(checks, 'OAuth metadata').target).toBe(
      'https://bsky.social/.well-known/oauth-authorization-server'
    )
  })

  it.each([
    [
      '/xrpc/com.atproto.server.describeServer',
      { did: 'did:web:elsewhere.example' },
      'describeServer',
      'Server names a different DID'
    ],
    [
      '/.well-known/oauth-authorization-server',
      { issuer: 'https://elsewhere.example', token_endpoint: 'https://elsewhere.example/t' },
      'OAuth metadata',
      'OAuth metadata names a different issuer'
    ],
    [
      '/.well-known/oauth-authorization-server',
      { issuer: 'https://bsky.social' },
      'OAuth metadata',
      'OAuth metadata has no token endpoint'
    ]
  ])('fails when %s answers %o', async (path, body, label, error) => {
    answer('bsky.social', path, body)
    const { checks } = await probe(id)
    expect(check(checks, label)).toMatchObject({ ok: false, error })
  })
})

describe('the PLC directory', () => {
  const id = 'plc:plc.directory'

  it('checks health, one DID document, and that operations are still being written', async () => {
    const { checks } = await probe(id)
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['_health', true],
      ['resolve', true],
      ['newest operation', true]
    ])
    expect(check(checks, 'resolve').target).toBe(`https://plc.directory/${CATALOGUE.anchor.did}`)
  })

  it('asks for the first operation since five minutes ago', async () => {
    const now = Date.parse('2026-09-30T16:00:00.000Z')
    const { checks } = await probe(id, { now: () => now })
    const url = new URL(check(checks, 'newest operation').target!)
    expect(url.pathname).toBe('/export')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      count: '1',
      after: '2026-09-30T15:55:00.000Z'
    })
  })

  it.each([
    ['nothing at all', '', 'No operations in the last 5 minutes'],
    ['a blank line', '\n', 'No operations in the last 5 minutes'],
    ['something that is not JSON', 'nope\n', 'Export was unreadable'],
    ['an operation with no date', '{"did":"did:plc:x"}\n', 'Export was unreadable']
  ])('fails the export when it answers with %s', async (_name, body, error) => {
    network.fail(
      'plc.directory',
      { kind: 'respond', body, contentType: 'application/jsonlines' },
      '/export'
    )
    const { checks } = await probe(id)
    expect(check(checks, 'newest operation')).toMatchObject({ ok: false, error })
    // Reads still work, which is exactly the failure this check exists for.
    expect(check(checks, 'resolve').ok).toBe(true)
  })

  it.each([
    [
      { id: 'did:plc:somebodyelse', alsoKnownAs: ['at://bsky.app'] },
      'DID document names a different DID'
    ],
    [{ id: CATALOGUE.anchor.did, alsoKnownAs: [] }, 'DID document no longer names its handle']
  ])('fails a DID document that reads %o', async (body, error) => {
    answer('plc.directory', `/${CATALOGUE.anchor.did}`, body)
    const { checks } = await probe(id)
    expect(check(checks, 'resolve')).toMatchObject({ ok: false, error })
  })
})

describe('an AppView', () => {
  const id = 'appview:api.bsky.app'
  const host = 'api.bsky.app'

  it('asks status.feeds.blue’s questions of every account, filed kind by kind', async () => {
    const { checks } = await probe(id)
    const { accounts } = DEFAULT_PROBE_TARGETS
    const each = (label: string): string[] => accounts.map(() => label)
    expect(checks.map((c) => c.label)).toEqual([
      '_health',
      ...each('getProfile'),
      ...each('resolveHandle'),
      ...each('getAuthorFeed'),
      'newest post',
      'indexing'
    ])
    expect(checks.every((c) => c.ok)).toBe(true)
    expect(check(checks, 'newest post')).toMatchObject({ kind: 'derived', target: null })
  })

  /**
   * Three lists became one, so every account is now asked about all three ways. Which
   * accounts the defaults hold is src/shared/probe-targets.test.ts's business.
   */
  it('makes three requests per account, plus its health and indexing checks', async () => {
    await probe(id)
    expect(network.requestsTo(host)).toHaveLength(2 + 3 * DEFAULT_PROBE_TARGETS.accounts.length)
  })

  describe('asked for posts that are seconds old', () => {
    const { jetstream } = CATALOGUE.indexSample
    const stream = (): FakeSocket[] =>
      network.sockets.filter((socket) => new URL(socket.url).hostname === jetstream)

    it('asks for the posts it took off Bluesky’s Jetstream, in one request', async () => {
      const { checks } = await probe(id)
      expect(stream()).toHaveLength(1)
      expect(stream()[0]!.url).toBe(
        `wss://${jetstream}/subscribe?wantedCollections=app.bsky.feed.post`
      )
      const indexing = check(checks, 'indexing')
      expect(indexing).toMatchObject({ kind: 'http', ok: true })
      const url = new URL(indexing.target!)
      expect(url.pathname).toBe('/xrpc/app.bsky.feed.getPosts')
      expect(url.searchParams.getAll('uris')).toEqual([
        expect.stringMatching(/^at:\/\/did:plc:someone\/app\.bsky\.feed\.post\/[2-7a-z]{13}$/)
      ])
    })

    it('fails an AppView that has not indexed them yet', async () => {
      network.unindex(host, 'did:plc:someone')
      const { checks } = await probe(id)
      expect(check(checks, 'indexing')).toMatchObject({
        ok: false,
        error: 'Found 0 of 1 posts from 0 seconds ago'
      })
      // The accounts it is asked about are all there: the row is behind, not broken.
      expect(probeState(checks)).toBe('partial')
    })

    it('passes with half the sample, since some posts are gone before anybody asks', async () => {
      const posts = [0, 1, 2, 3].map((n) =>
        JSON.stringify({
          did: n % 2 ? 'did:plc:gone' : 'did:plc:someone',
          kind: 'commit',
          time_us: Date.now() * 1000,
          commit: { operation: 'create', collection: 'app.bsky.feed.post', rkey: tid() }
        })
      )
      network.unindex(host, 'did:plc:gone')
      const transport: ProbeTransport = {
        fetch: network.fetch,
        openSocket: (url) => {
          if (new URL(url).hostname !== jetstream) return network.openSocket(url)
          const socket = new FakeSocket(url)
          queueMicrotask(() => {
            socket.open()
            for (const post of posts) socket.emit(post)
          })
          return socket
        }
      }
      const { checks } = await probe(id, { transport })
      expect(new URL(check(checks, 'indexing').target!).searchParams.getAll('uris')).toHaveLength(4)
      expect(check(checks, 'indexing').ok).toBe(true)
    })

    it('does not count the wait as the AppView’s latency', async () => {
      const { checks } = await probe(id, { timings: { ...QUICK, indexGraceMs: 120 } })
      expect(check(checks, 'indexing').ok).toBe(true)
      expect(check(checks, 'indexing').durationMs).toBeLessThan(120)
    })

    it('takes one sample for every AppView in the sweep', async () => {
      const ctx = context({ peers: new FreshnessPeers(2) })
      const views = ['appview:api.bsky.app', 'appview:api.eurosky.network']
      const results = await Promise.all(
        views.map(async (view) => {
          const checks: ProbeCheck[] = []
          await probeService(service(view), checks, ctx)
          return check(checks, 'indexing').target
        })
      )
      expect(stream()).toHaveLength(1)
      const asked = results.map((target) => new URL(target!).searchParams.getAll('uris'))
      expect(asked[0]).toEqual(asked[1])
    })

    it.each<[string, Parameters<FakeNetwork['setFirehose']>[1]]>([
      ['says nothing', 'silent'],
      ['only replays old posts', 'stale'],
      ['cannot be reached', 'socket-error'],
      ['cannot even be opened', 'throws']
    ])('goes without the check when the Jetstream %s', async (_name, behaviour) => {
      network.setFirehose(jetstream, behaviour)
      const { checks } = await probe(id)
      expect(checks.map((c) => c.label)).not.toContain('indexing')
      expect(probeState(checks)).toBe('live')
    })

    it('leaves out an AppView that only indexes part of the network', async () => {
      const { checks } = await probe('appview:appview.wsocial.eu')
      expect(checks.map((c) => c.label)).not.toContain('indexing')
      // Nothing is sampled on its behalf either.
      expect(stream()).toHaveLength(0)
    })

    it('stops waiting when the sweep is abandoned', async () => {
      const controller = new AbortController()
      const checks: ProbeCheck[] = []
      const pending = probeService(
        service(id),
        checks,
        context({ signal: controller.signal, timings: { ...QUICK, indexGraceMs: 60_000 } })
      )
      // The check is filed the moment the sample is in, and then waits out the grace.
      await vi.waitFor(() => expect(checks.map((c) => c.label)).toContain('indexing'))
      controller.abort()
      await pending
      expect(check(checks, 'indexing')).toMatchObject({ ok: false, error: 'Cancelled' })
    })

    it('hangs up as soon as it has the posts it wants', async () => {
      const { size } = CATALOGUE.indexSample
      const transport: ProbeTransport = {
        fetch: network.fetch,
        openSocket: (url) => {
          if (new URL(url).hostname !== jetstream) return network.openSocket(url)
          const socket = new FakeSocket(url)
          queueMicrotask(() => {
            socket.open()
            for (let n = 0; n <= size; n++) socket.emit(jetstreamEvent())
          })
          return socket
        }
      }
      // A window long enough that only having the posts can end it.
      const { checks } = await probe(id, {
        transport,
        timings: { ...QUICK, firehoseWindowMs: 60_000 }
      })
      expect(new URL(check(checks, 'indexing').target!).searchParams.getAll('uris')).toHaveLength(
        size
      )
    })

    it('passes over what it cannot read on the way to a post', async () => {
      const transport: ProbeTransport = {
        fetch: network.fetch,
        openSocket: (url) => {
          if (new URL(url).hostname !== jetstream) return network.openSocket(url)
          const socket = new FakeSocket(url)
          queueMicrotask(() => {
            socket.open()
            socket.emit(new Uint8Array([0xff, 0x00]).buffer)
            socket.emit('{"kind":')
            // Not a commit, not a new record, and a commit with no record key.
            socket.emit(JSON.stringify({ kind: 'identity', did: 'did:plc:someone' }))
            socket.emit(
              JSON.stringify({ ...JSON.parse(jetstreamEvent()), commit: { operation: 'update' } })
            )
            socket.emit(JSON.stringify({ ...JSON.parse(jetstreamEvent()), did: 7 }))
            const event = JSON.parse(jetstreamEvent()) as { commit: Record<string, unknown> }
            socket.emit(JSON.stringify({ ...event, commit: { ...event.commit, rkey: null } }))
            socket.emit(jetstreamEvent())
          })
          return socket
        }
      }
      const { checks } = await probe(id, { transport })
      expect(new URL(check(checks, 'indexing').target!).searchParams.getAll('uris')).toHaveLength(1)
      expect(check(checks, 'indexing').ok).toBe(true)
    })
  })

  it('looks each account up by DID and by handle, and reads its feed by DID', async () => {
    const accounts = [
      { did: 'did:plc:alice', handle: 'alice.test' },
      { did: 'did:plc:bob', handle: 'bob.test' }
    ]
    network.useTargets(targets({ accounts }))
    const { checks } = await probe(id, { targets: targets({ accounts }) })

    const asked = (label: string, param: string): (string | null)[] =>
      checks.filter((c) => c.label === label).map((c) => new URL(c.target!).searchParams.get(param))
    expect(asked('getProfile', 'actor')).toEqual(['did:plc:alice', 'did:plc:bob'])
    expect(asked('resolveHandle', 'handle')).toEqual(['alice.test', 'bob.test'])
    expect(asked('getAuthorFeed', 'actor')).toEqual(['did:plc:alice', 'did:plc:bob'])
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  it('asks for a handful of posts, not a hundred', async () => {
    await probe(id)
    const feeds = network.requestsTo(host).filter((r) => r.path.endsWith('getAuthorFeed'))
    expect(feeds).toHaveLength(DEFAULT_PROBE_TARGETS.accounts.length)
    for (const request of feeds) expect(new URL(request.url).searchParams.get('limit')).toBe('5')
  })

  it('fails a handle that resolves to somebody else’s DID', async () => {
    network.fail(
      host,
      {
        kind: 'respond',
        body: JSON.stringify({ did: 'did:plc:somebodyelse' }),
        contentType: 'application/json'
      },
      '/xrpc/com.atproto.identity.resolveHandle'
    )
    const { checks } = await probe(id)
    const handles = checks.filter((c) => c.label === 'resolveHandle')
    expect(handles).toHaveLength(DEFAULT_PROBE_TARGETS.accounts.length)
    for (const handle of handles) {
      expect(handle).toMatchObject({ ok: false, error: 'Resolved to the wrong DID' })
    }
    // Only the resolution is wrong; the profiles and feeds were read by DID.
    expect(checks.filter((c) => c.label === 'getProfile').every((c) => c.ok)).toBe(true)
  })

  it('holds each handle to its own DID, not just to any DID', async () => {
    // Two accounts whose DIDs are swapped: every answer is a DID, and each is wrong.
    const listed = [
      { did: 'did:plc:alice', handle: 'bob.test' },
      { did: 'did:plc:bob', handle: 'alice.test' }
    ]
    network.useTargets(
      targets({
        accounts: [
          { did: 'did:plc:alice', handle: 'alice.test' },
          { did: 'did:plc:bob', handle: 'bob.test' }
        ]
      })
    )
    const { checks } = await probe(id, { targets: targets({ accounts: listed }) })
    expect(checks.filter((c) => c.label === 'resolveHandle').map((c) => c.error)).toEqual([
      'Resolved to the wrong DID',
      'Resolved to the wrong DID'
    ])
  })

  it('fails a handle the AppView cannot resolve at all', async () => {
    const accounts = [{ did: 'did:plc:gone', handle: 'deleted.test' }]
    const { checks } = await probe(id, { targets: targets({ accounts }) })
    expect(check(checks, 'resolveHandle')).toMatchObject({
      ok: false,
      error: 'HTTP 400 · Unable to resolve handle'
    })
  })

  it('expects a version from the health check', async () => {
    network.fail(
      host,
      { kind: 'respond', body: '{}', contentType: 'application/json' },
      '/xrpc/_health'
    )
    const { checks } = await probe(id)
    expect(check(checks, '_health').error).toBe('Invalid response')
  })

  it.each(['api.blacksky.community', 'appview.wsocial.eu'])(
    'accepts %s’s empty health answer',
    async (appview) => {
      network.fail(
        appview,
        { kind: 'respond', body: '{}', contentType: 'application/json' },
        '/xrpc/_health'
      )
      const { checks } = await probe(`appview:${appview}`)
      expect(check(checks, '_health').ok).toBe(true)
    }
  )

  it('fails a profile or handle lookup that returns no DID', async () => {
    for (const path of [
      '/xrpc/app.bsky.actor.getProfile',
      '/xrpc/com.atproto.identity.resolveHandle'
    ]) {
      network.fail(
        host,
        { kind: 'respond', body: '{"handle":"x"}', contentType: 'application/json' },
        path
      )
    }
    const { checks } = await probe(id)
    const lookups = checks.filter((c) => c.label === 'getProfile' || c.label === 'resolveHandle')
    expect(lookups).toHaveLength(2 * DEFAULT_PROBE_TARGETS.accounts.length)
    // No DID at all is a malformed answer, not a wrong one.
    for (const lookup of lookups) {
      expect(lookup).toMatchObject({ ok: false, error: 'Invalid response' })
    }
    expect(check(checks, 'getAuthorFeed').ok).toBe(true)
  })

  it('fails freshness when no feed returns a timestamp', async () => {
    network.setNewestPost(host, null)
    const { checks } = await probe(id)
    expect(check(checks, 'getAuthorFeed').ok).toBe(true)
    expect(check(checks, 'newest post').error).toBe('No valid post timestamps returned')
  })

  it('fails freshness when every author feed fails', async () => {
    network.fail(host, { kind: 'http', status: 500 }, '/xrpc/app.bsky.feed.getAuthorFeed')
    const { checks } = await probe(id)
    expect(check(checks, 'newest post').error).toBe('No valid post timestamps returned')
  })

  it('judges each AppView against its freshest peer, not against the clock', async () => {
    const quiet = new Date(Date.now() - 3 * 3_600_000).toISOString()
    const behind = new Date(Date.now() - 4 * 3_600_000).toISOString()
    network.setNewestPost('api.bsky.app', quiet)
    network.setNewestPost('public.api.bsky.app', behind)
    const peers = new FreshnessPeers(2)
    const ctx = context({ peers })

    const fresh: ProbeCheck[] = []
    const lagging: ProbeCheck[] = []
    await Promise.all([
      probeService(service('appview:api.bsky.app'), fresh, ctx),
      probeService(service('appview:public.api.bsky.app'), lagging, ctx)
    ])

    // Three hours old is fine when nobody has anything newer: the accounts went quiet.
    expect(check(fresh, 'newest post').ok).toBe(true)
    expect(check(lagging, 'newest post')).toMatchObject({
      ok: false,
      error: 'Newest post trails other AppViews by 1 hour',
      // A judgement, not a request: there is nothing to time.
      durationMs: null
    })
    for (const { did } of DEFAULT_PROBE_TARGETS.accounts) {
      expect(peers.best.get(did)).toBe(Date.parse(quiet))
    }
  })

  it('remembers the freshest post from an earlier sweep', async () => {
    network.setNewestPost(host, new Date(Date.now() - 3_600_000).toISOString())
    const earlier = new Map(DEFAULT_PROBE_TARGETS.accounts.map(({ did }) => [did, Date.now()]))
    const { checks } = await probe(id, { peers: new FreshnessPeers(1, earlier) })
    expect(check(checks, 'newest post').error).toBe('Newest post trails other AppViews by 1 hour')
  })

  /**
   * W Social's AppView indexes only accounts `bsky.app` has verified, so a user's own
   * accounts may not be there. Held to their posts it read as hours behind; on the
   * accounts it has, it is current.
   */
  describe('missing some accounts', () => {
    const [busy, quiet] = [
      DEFAULT_PROBE_TARGETS.accounts.slice(0, 3),
      DEFAULT_PROBE_TARGETS.accounts.slice(3)
    ]
    const partial = 'appview.wsocial.eu'

    async function compare(lastPost: string): Promise<ProbeCheck[]> {
      const hoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString()
      for (const { did } of quiet) {
        network.setNewestPost(host, hoursAgo, did)
        network.setNewestPost(partial, lastPost, did)
      }
      network.unindex(partial, ...busy.map(({ did }) => did))
      const ctx = context({ peers: new FreshnessPeers(2) })
      const whole: ProbeCheck[] = []
      const part: ProbeCheck[] = []
      await Promise.all([
        probeService(service(id), whole, ctx),
        probeService(service(`appview:${partial}`), part, ctx)
      ])
      expect(check(whole, 'newest post').ok).toBe(true)
      return part
    }

    it('says which accounts it lacks, and why', async () => {
      const checks = await compare(new Date(Date.now() - 3 * 3_600_000).toISOString())
      const failed = checks.filter((c) => c.ok === false)
      expect(failed.map((c) => [c.label, c.error])).toEqual([
        ...busy.map(() => ['getProfile', 'HTTP 400 · Profile not found']),
        ...busy.map(() => ['resolveHandle', 'HTTP 400 · Unable to resolve handle']),
        ...busy.map(() => ['getAuthorFeed', 'HTTP 400 · Profile not found'])
      ])
    })

    it('is judged fresh on the accounts it has', async () => {
      const checks = await compare(new Date(Date.now() - 3 * 3_600_000).toISOString())
      expect(check(checks, 'newest post').ok).toBe(true)
    })

    it('is still caught falling behind on them', async () => {
      const checks = await compare(new Date(Date.now() - 4 * 3_600_000).toISOString())
      expect(check(checks, 'newest post').error).toBe('Newest post trails other AppViews by 1 hour')
    })
  })

  describe('asked about an account that has gone', () => {
    const [gone] = DEFAULT_PROBE_TARGETS.accounts
    const both = ['appview:api.bsky.app', 'appview:api.eurosky.network']

    async function sweep(
      views: string[] = both,
      census = new TargetCensus(views.length),
      chosen = DEFAULT_PROBE_TARGETS
    ): Promise<{ rows: ProbeCheck[][]; census: TargetCensus }> {
      const ctx = context({ peers: new FreshnessPeers(views.length), census, targets: chosen })
      const rows = await Promise.all(
        views.map(async (view) => {
          const checks: ProbeCheck[] = []
          await probeService(service(view), checks, ctx)
          return checks
        })
      )
      return { rows, census }
    }

    it('excuses its lookups on every AppView, rather than failing them all', async () => {
      for (const view of both) network.unindex(service(view).host, gone!.did)
      const { rows, census } = await sweep()
      for (const checks of rows) {
        expect(excused(checks)).toEqual(['getProfile', 'resolveHandle', 'getAuthorFeed'])
        expect(checks.find((c) => c.excused)!).toMatchObject({
          ok: false,
          error: 'HTTP 400 · Profile not found',
          excused: expect.stringContaining('No AppView has this account any more')
        })
        expect(probeState(checks)).toBe('live')
      }
      expect(vanishedTargets(census.verdict)).toEqual([
        { part: 'account', did: gone!.did },
        { part: 'handle', did: gone!.did }
      ])
    })

    it('still holds it against the one AppView that lacks what the others have', async () => {
      network.unindex('api.bsky.app', gone!.did)
      const { rows, census } = await sweep()
      expect(excused(rows[0]!)).toEqual([])
      expect(probeState(rows[0]!)).toBe('partial')
      expect(census.verdict.size).toBe(0)
    })

    it('excuses only the handle of an account that is still there under another', async () => {
      const renamed = DEFAULT_PROBE_TARGETS.accounts.map((account) =>
        account.did === gone!.did ? { ...account, handle: 'renamed.example.test' } : account
      )
      network.useTargets(targets({ accounts: renamed }))
      const { rows, census } = await sweep()
      for (const checks of rows) {
        expect(excused(checks)).toEqual(['resolveHandle'])
        expect(checks.find((c) => c.excused)!.excused).toContain('it has changed')
        expect(probeState(checks)).toBe('live')
      }
      expect(vanishedTargets(census.verdict)).toEqual([{ part: 'handle', did: gone!.did }])
    })

    it('excuses nothing an AppView failed to answer for itself', async () => {
      const three = [...both, 'appview:api.blacksky.community']
      for (const view of both) network.unindex(service(view).host, gone!.did)
      network.fail(
        'api.blacksky.community',
        { kind: 'http', status: 502 },
        '/xrpc/app.bsky.actor.getProfile'
      )
      const { rows, census } = await sweep(three)
      // A 502 says nothing about the account either way, so the two that answered decide.
      expect(vanishedTargets(census.verdict)).toContainEqual({ part: 'account', did: gone!.did })
      expect(excused(rows[0]!)).toContain('getProfile')
      const blacksky = rows[2]!.filter((c) => c.label === 'getProfile')
      expect(blacksky.every((c) => c.error === 'HTTP 502' && c.excused === undefined)).toBe(true)
    })

    it('keeps the last full census through a re-check of one AppView, and only then', async () => {
      for (const view of both) network.unindex(service(view).host, gone!.did)
      const { census } = await sweep()

      const recheck = await sweep(['appview:api.bsky.app'], new TargetCensus(1, census.verdict))
      expect(excused(recheck.rows[0]!)).toContain('getProfile')

      // One AppView on its own cannot tell a deleted account from a gap in its own index.
      const alone = await sweep(['appview:api.bsky.app'])
      expect(excused(alone.rows[0]!)).toEqual([])
    })

    it('keeps the account gone through a re-check that cannot reach it', async () => {
      for (const view of both) network.unindex(service(view).host, gone!.did)
      const { census } = await sweep()

      network.fail('api.bsky.app', { kind: 'http', status: 502 }, '/xrpc/app.bsky.actor.getProfile')
      const recheck = await sweep(['appview:api.bsky.app'], new TargetCensus(1, census.verdict))
      // A 502 says nothing about the account, which is no reason to forget it has gone.
      expect(vanishedTargets(recheck.census.verdict)).toContainEqual({
        part: 'account',
        did: gone!.did
      })
    })

    it('hears Bluesky’s two hostnames as the one index they are', async () => {
      const bluesky = ['appview:api.bsky.app', 'appview:public.api.bsky.app']
      for (const view of bluesky) network.unindex(service(view).host, gone!.did)
      const { rows, census } = await sweep(bluesky)
      expect(census.verdict.size).toBe(0)
      for (const checks of rows) expect(excused(checks)).toEqual([])
    })

    it('gives an AppView that leaves accounts out by design no say in what is gone', async () => {
      const views = ['appview:api.bsky.app', 'appview:appview.wsocial.eu']
      for (const view of views) network.unindex(service(view).host, gone!.did)
      const { census } = await sweep(views)
      expect(census.verdict.size).toBe(0)
    })

    it('still excuses that AppView once the others agree the account has gone', async () => {
      const views = [...both, 'appview:appview.wsocial.eu']
      for (const view of views) network.unindex(service(view).host, gone!.did)
      const { rows } = await sweep(views)
      expect(excused(rows[2]!)).toEqual(['getProfile', 'resolveHandle', 'getAuthorFeed'])
      expect(probeState(rows[2]!)).toBe('live')
    })

    it('excuses the newest post too, once every account listed has gone', async () => {
      const alone = targets({ accounts: [gone!] })
      network.useTargets(alone)
      for (const view of both) network.unindex(service(view).host, gone!.did)
      const { rows } = await sweep(both, undefined, alone)
      for (const checks of rows) {
        expect(check(checks, 'newest post')).toMatchObject({
          ok: false,
          error: 'No valid post timestamps returned',
          excused: expect.stringContaining('No AppView has this account any more')
        })
        expect(probeState(checks)).toBe('live')
      }
    })

    it('holds the newest post against an AppView with an account left to read', async () => {
      const [, quiet] = DEFAULT_PROBE_TARGETS.accounts
      const pair = targets({ accounts: [gone!, quiet!] })
      network.useTargets(pair)
      for (const view of both) {
        network.unindex(service(view).host, gone!.did)
        network.setNewestPost(service(view).host, null, quiet!.did)
      }
      const { rows } = await sweep(both, undefined, pair)
      for (const checks of rows) {
        expect(check(checks, 'newest post').excused).toBeUndefined()
        expect(probeState(checks)).toBe('partial')
      }
    })
  })

  it('still reports to its peers when it has nothing to say, so none wait forever', async () => {
    network.setNewestPost('api.bsky.app', null)
    const peers = new FreshnessPeers(2)
    const ctx = context({ peers })
    const a: ProbeCheck[] = []
    const b: ProbeCheck[] = []
    await Promise.all([
      probeService(service('appview:api.bsky.app'), a, ctx),
      probeService(service('appview:api.eurosky.network'), b, ctx)
    ])
    expect(check(a, 'newest post').ok).toBe(false)
    expect(check(b, 'newest post').ok).toBe(true)
  })
})

describe('the other infrastructure', () => {
  it('asks the Discover feed for one post', async () => {
    const { checks } = await probe('feed:discover.bsky.app')
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ label: 'getFeedSkeleton', ok: true })
    const url = new URL(checks[0]!.target!)
    expect(url.searchParams.get('feed')).toBe(
      'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot'
    )
    expect(url.searchParams.get('limit')).toBe('1')
  })

  describe('the For You feed', () => {
    const id = 'foryou:foryou.club'
    const { host, appView } = CATALOGUE.forYou
    const { did, feed } = DEFAULT_PROBE_TARGETS.forYou

    it("checks the identity, the front door, the proxy and Bluesky's verdict", async () => {
      const { checks } = await probe(id)
      expect(checks.map((c) => [c.label, c.kind, c.ok])).toEqual([
        ['did.json', 'http', true],
        ['getFeedSkeleton', 'http', true],
        ['site', 'http', true],
        ['getFeedGenerator', 'http', true]
      ])
      // The skeleton goes to the feed itself; only Bluesky's verdict is asked elsewhere.
      expect(new URL(check(checks, 'getFeedSkeleton').target!).hostname).toBe(host)
      expect(new URL(check(checks, 'getFeedGenerator').target!).hostname).toBe(appView)
      expect(new URL(check(checks, 'getFeedSkeleton').target!).searchParams.get('feed')).toBe(feed)
    })

    it('leaves the Turnstile-gated, robots-disallowed routes alone', async () => {
      await probe(id)
      const paths = network.requests.filter((r) => r.host === host).map((r) => r.path)
      expect(paths).not.toContain('/playground')
      expect(paths).not.toContain('/also-liked')
    })

    it.each([
      [{ feed: [] }, 'Skeleton was empty'],
      [{ cursor: '' }, 'No feed in the skeleton']
    ])('fails a skeleton that reads %o', async (skeleton, error) => {
      network.fail(
        host,
        { kind: 'respond', body: JSON.stringify(skeleton), contentType: 'application/json' },
        '/xrpc/app.bsky.feed.getFeedSkeleton'
      )
      const { checks } = await probe(id)
      expect(check(checks, 'getFeedSkeleton')).toMatchObject({ ok: false, error })
    })

    it('says a busy feed is busy rather than repeating its status', async () => {
      network.fail(
        host,
        { kind: 'respond', status: 503, body: 'server busy\n', contentType: 'text/plain' },
        '/'
      )
      const { checks } = await probe(id)
      expect(check(checks, 'site')).toMatchObject({
        ok: false,
        error: 'Shedding load: server busy'
      })
    })

    // A 503 is allowed through only so its body can say why; it is never forgiven.
    it('fails a 503 even when the page under it is the site', async () => {
      network.fail(
        host,
        {
          kind: 'respond',
          status: 503,
          body: '<html><head><link rel="canonical" href="https://foryou.club/"></head></html>',
          contentType: 'text/html'
        },
        '/'
      )
      const { checks } = await probe(id)
      expect(check(checks, 'site')).toMatchObject({ ok: false, error: 'HTTP 503' })
    })

    it.each([
      [{ id: 'did:web:somewhere.else' }, 'DID document names a different DID'],
      [{ id: did }, 'DID document declares no feed generator here'],
      [{ id: did, service: [] }, 'DID document declares no feed generator here'],
      [
        { id: did, service: [{ type: 'BskyFeedGenerator', serviceEndpoint: 'https://elsewhere' }] },
        'DID document declares no feed generator here'
      ]
    ])('fails a DID document that reads %o', async (document, error) => {
      network.fail(
        host,
        { kind: 'respond', body: JSON.stringify(document), contentType: 'application/json' },
        '/.well-known/did.json'
      )
      const { checks } = await probe(id)
      expect(check(checks, 'did.json')).toMatchObject({ ok: false, error })
    })

    it.each([
      [{ isOnline: false, isValid: true }, 'Bluesky cannot reach the generator'],
      [{ isOnline: true, isValid: false }, 'Bluesky calls the generator invalid']
    ])('passes on what Bluesky says about the generator (%o)', async (verdict, error) => {
      network.fail(
        appView,
        {
          kind: 'respond',
          body: JSON.stringify({ view: { did }, ...verdict }),
          contentType: 'application/json'
        },
        '/xrpc/app.bsky.feed.getFeedGenerator'
      )
      const { checks } = await probe(id)
      expect(check(checks, 'getFeedGenerator')).toMatchObject({ ok: false, error })
    })

    it('does not mistake some other page on the host for the site', async () => {
      network.fail(
        host,
        { kind: 'respond', body: '<html>404</html>', contentType: 'text/html' },
        '/'
      )
      const { checks } = await probe(id)
      expect(check(checks, 'site')).toMatchObject({ ok: false, error: 'Page was not the site' })
    })

    it('reports a skeleton that never arrived', async () => {
      network.fail(host, { kind: 'http', status: 502 }, '/xrpc/app.bsky.feed.getFeedSkeleton')
      const { checks } = await probe(id)
      expect(check(checks, 'getFeedSkeleton')).toMatchObject({ ok: false, error: 'HTTP 502' })
    })
  })

  it('asks Constellation for backlinks, and whether its index is growing', async () => {
    const { checks } = await probe('constellation:constellation.microcosm.blue')
    expect(checks.map((c) => c.label)).toEqual(['index stats', 'index growth', 'getBacklinks'])
    expect(checks.every((c) => c.ok)).toBe(true)
    const backlinks = checks.find((c) => c.label === 'getBacklinks')!
    expect(new URL(backlinks.target!).searchParams.get('source')).toBe(
      'app.bsky.graph.follow:subject'
    )
  })

  it('reports a Constellation whose link count has stopped climbing', async () => {
    const counters = memoryCounters()
    // The first reading has nothing to compare against, and a flat sweep or two is
    // ordinary; three in a row is the index having stopped.
    network.fail('constellation.microcosm.blue', {
      kind: 'respond',
      body: JSON.stringify({ stats: { linking_records: 7 } }),
      contentType: 'application/json'
    })
    let growth: ProbeCheck | undefined
    for (let sweep = 0; sweep < 4; sweep++) {
      // Sequential on purpose: each sweep is judged against the one before it.
      // oxlint-disable-next-line no-await-in-loop
      const { checks } = await probe('constellation:constellation.microcosm.blue', { counters })
      growth = checks.find((c) => c.label === 'index growth')
      if (sweep < 3) expect(growth).toMatchObject({ ok: true })
    }
    expect(growth).toMatchObject({
      ok: false,
      error: 'Link count has not moved for 3 sweeps'
    })
  })

  it('starts the tally over when the link count climbs again', async () => {
    const counters = memoryCounters()
    const growth: (boolean | null)[] = []
    for (const count of [7, 7, 7, 8, 8, 8]) {
      answer('constellation.microcosm.blue', '/', { stats: { linking_records: count } })
      // Sequential on purpose: each sweep is judged against the one before it.
      // oxlint-disable-next-line no-await-in-loop
      const { checks } = await probe('constellation:constellation.microcosm.blue', { counters })
      growth.push(check(checks, 'index growth').ok)
    }
    // Two flat sweeps, a move, two flat sweeps: never three in a row.
    expect(growth).toEqual([true, true, true, true, true, true])
  })

  it('skips the growth check when Constellation publishes no count', async () => {
    answer('constellation.microcosm.blue', '/', { stats: {} })
    const { checks } = await probe('constellation:constellation.microcosm.blue')
    expect(check(checks, 'index stats')).toMatchObject({ ok: false, error: 'No index stats' })
    expect(check(checks, 'index growth')).toMatchObject({
      ok: false,
      error: 'Skipped because index stats failed',
      durationMs: null
    })
    expect(check(checks, 'getBacklinks').ok).toBe(true)
  })

  describe('the CDN', () => {
    const id = 'cdn:cdn.bsky.app'

    it('hangs up after the first chunk, even on a stream that objects', async () => {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
        },
        cancel() {
          cancelled = true
          throw new Error('already gone')
        }
      })
      network.fail('cdn.bsky.app', { kind: 'respond', body, contentType: 'image/webp' })
      const { checks } = await probe(id)
      expect(checks[0]!.ok).toBe(true)
      expect(cancelled).toBe(true)
    })

    it('loads the start of three images', async () => {
      const { checks } = await probe(id)
      expect(checks.map((c) => [c.label, c.ok])).toEqual([
        ['image', true],
        ['image', true],
        ['image', true]
      ])
      expect(checks[0]!.target).toMatch(/^https:\/\/cdn\.bsky\.app\/img\/feed_fullsize\/plain\//)
    })

    it.each([
      [
        { kind: 'respond', body: '<html>', contentType: 'text/html' },
        'Received content type text/html'
      ],
      [{ kind: 'respond', body: 'x', contentType: null }, 'Received no content type'],
      [{ kind: 'respond', body: '', contentType: 'image/png' }, 'Image was empty'],
      [{ kind: 'respond', body: null, contentType: 'image/png' }, 'Image was empty']
    ] as const)('fails on %o', async (failure, error) => {
      network.fail('cdn.bsky.app', failure)
      const { checks } = await probe(id)
      expect(checks[0]).toMatchObject({ ok: false, error })
    })
  })
})

describe('the control checks', () => {
  it('asks the DNS resolvers for JSON answers', async () => {
    const { checks } = await probe('internet:cloudflare')
    expect(checks[0]).toMatchObject({ label: 'cloudflare-dns.com', ok: true })
    expect(network.requests[0]!.headers.accept).toBe('application/dns-json')
  })

  it('accepts a DNS status with no answers, and refuses a failed lookup', async () => {
    network.fail('dns.google', {
      kind: 'respond',
      body: '{"Status":0}',
      contentType: 'application/json'
    })
    expect((await probe('internet:google')).checks[0]!.ok).toBe(true)

    network.fail('dns.google', {
      kind: 'respond',
      body: '{"Status":2}',
      contentType: 'application/json'
    })
    expect((await probe('internet:google')).checks[0]!.error).toBe('Invalid response')
  })

  it('reads Amazon’s answer as text, and refuses an empty one', async () => {
    expect((await probe('internet:aws')).checks[0]).toMatchObject({
      label: 'checkip.amazonaws.com',
      ok: true
    })

    network.fail('checkip.amazonaws.com', { kind: 'respond', body: '', contentType: 'text/plain' })
    expect((await probe('internet:aws')).checks[0]!.error).toBe('Invalid response')
  })
})

describe('the streams', () => {
  it('reads a Jetstream greeting and a fresh event', async () => {
    const { checks } = await probe('jetstream:jetstream2.fr.hose.cam')
    expect(checks.map((c) => [c.label, c.kind, c.ok])).toEqual([
      ['greeting', 'http', true],
      ['subscribe', 'stream', true]
    ])
    expect(check(checks, 'subscribe').target).toBe(
      'wss://jetstream2.fr.hose.cam/subscribe?wantedCollections=app.bsky.feed.post'
    )
  })

  it('fails a Jetstream that greets you and then says nothing recent', async () => {
    network.setFirehose('jetstream2.fr.hose.cam', 'stale')
    const { checks } = await probe('jetstream:jetstream2.fr.hose.cam')
    expect(check(checks, 'greeting').ok).toBe(true)
    expect(check(checks, 'subscribe')).toMatchObject({
      ok: false,
      error: 'Newest event is 2 hours old'
    })
  })

  it('rejects a greeting that is not the one Jetstream gives', async () => {
    network.fail('jetstream2.fr.hose.cam', { kind: 'respond', body: 'hello' }, '/')
    const { checks } = await probe('jetstream:jetstream2.fr.hose.cam')
    expect(check(checks, 'greeting')).toMatchObject({ ok: false, error: 'Unexpected greeting' })
  })

  it('dates a Spacedust link by the TID of the record that made it', async () => {
    const { checks } = await probe('spacedust:spacedust.microcosm.blue')
    expect(checks.map((c) => [c.label, c.kind, c.ok])).toEqual([['subscribe', 'stream', true]])
    const target = new URL(check(checks, 'subscribe').target!)
    // A high-volume source, and the buffer skipped: a quiet filter would read as down,
    // and the 21-second delay would make every link look stale.
    expect(target.searchParams.get('wantedSources')).toBe('app.bsky.feed.like:subject.uri')
    expect(target.searchParams.get('instant')).toBe('true')
  })

  it('fails a Spacedust whose newest link is old', async () => {
    network.setFirehose('spacedust.microcosm.blue', 'stale')
    const { checks } = await probe('spacedust:spacedust.microcosm.blue')
    expect(check(checks, 'subscribe')).toMatchObject({
      ok: false,
      error: 'Newest link is 2 hours old'
    })
  })

  /** Probe a stream that stays quiet on its own, putting exactly `data` on it once open. */
  async function streamSaying(id: string, data: unknown): Promise<ProbeCheck> {
    const definition = service(id)
    network.setFirehose(definition.host, 'silent')
    const checks: ProbeCheck[] = []
    const done = probeService(definition, checks, context())
    await vi.waitFor(() => expect(network.sockets).toHaveLength(1))
    network.sockets[0]!.emit(data)
    await done
    return check(checks, 'subscribe')
  }

  it.each([
    // A server is free to send its JSON in binary frames rather than text ones.
    ['an event as bytes', new TextEncoder().encode(jetstreamEvent()), true, null],
    ['text that is not JSON', 'not json', false, 'Failed to decode a Jetstream event'],
    ['JSON that is not an event', '[1]', false, 'Failed to decode a Jetstream event'],
    ['neither text nor bytes', 42, false, 'Failed to decode a Jetstream event'],
    ['a commit with no time', '{"kind":"commit"}', false, 'Received invalid timestamp'],
    // Only commits carry the time the check reads; anything else is passed over.
    ['only an identity event', '{"kind":"identity"}', false, 'No events received']
  ])('reads a Jetstream that sends %s', async (_name, data, ok, error) => {
    expect(await streamSaying('jetstream:jetstream2.fr.hose.cam', data)).toMatchObject({
      ok,
      error
    })
  })

  it.each([
    ['text that is not JSON', 'not json', 'Failed to decode a Spacedust frame'],
    ['JSON that is not a frame', 'null', 'Failed to decode a Spacedust frame'],
    // A replayed link dates from whenever it was first seen, so it proves nothing.
    ['only a replayed link', link({ origin: 'replay' }), 'No links received'],
    ['a link with no record behind it', link({ link: null }), 'Received invalid timestamp'],
    [
      'a link whose revision is not a string',
      link({ link: { source_rev: 5 } }),
      'Received invalid timestamp'
    ],
    [
      'a link whose revision is not a TID',
      link({ link: { source_rev: 'yesterday' } }),
      'Received invalid timestamp'
    ]
  ])('fails a Spacedust that sends %s', async (_name, data, error) => {
    expect(await streamSaying('spacedust:spacedust.microcosm.blue', data)).toMatchObject({
      ok: false,
      error
    })
  })
})

describe('the indexes that report their own cursor', () => {
  it('reads how far behind UFOs is, and its query path', async () => {
    const { checks } = await probe('ufos:ufos-api.microcosm.blue')
    expect(checks.map((c) => [c.label, c.kind, c.ok])).toEqual([
      ['meta', 'http', true],
      ['collections/stats', 'http', true],
      ['index lag', 'derived', true]
    ])
  })

  it('fails UFOs when its consumer has fallen behind the clock', async () => {
    const behind = Math.round((Date.now() - 20 * 60_000) * 1000)
    network.fail(
      'ufos-api.microcosm.blue',
      {
        kind: 'respond',
        body: JSON.stringify({ consumer: { jetstream: { latest_cursor: behind } } }),
        contentType: 'application/json'
      },
      '/meta'
    )
    const { checks } = await probe('ufos:ufos-api.microcosm.blue')
    // The request itself was fine: it is what the body said that failed.
    expect(check(checks, 'meta').ok).toBe(true)
    expect(check(checks, 'index lag')).toMatchObject({
      ok: false,
      error: 'Index trails by 20 minutes',
      durationMs: null
    })
  })

  it('reads pckt’s health and its index lag from one response, and looks up a blog', async () => {
    const { checks } = await probe('pckt:pckt.blog')
    expect(checks.map((c) => [c.label, c.kind, c.ok])).toEqual([
      ['up', 'http', true],
      ['publication', 'http', true],
      ['index lag', 'derived', true]
    ])
    expect(check(checks, 'up').target).toBe('https://pckt.blog/up')
    expect(check(checks, 'publication').target).toBe(
      'https://notes.pckt.blog/.well-known/site.standard.publication'
    )
  })

  it('fails pckt when its blog does not resolve, and reads it as partial', async () => {
    // What a subdomain pckt does not know answers with.
    network.fail(
      'notes.pckt.blog',
      { kind: 'respond', status: 404, body: '<html>Not found</html>', contentType: 'text/html' },
      '/.well-known/site.standard.publication'
    )
    const { checks } = await probe('pckt:pckt.blog')
    expect(check(checks, 'up').ok).toBe(true)
    expect(check(checks, 'publication').ok).toBe(false)
    expect(probeState(checks)).toBe('partial')
  })

  /** pckt's `/up` with everything that is judged well, and then whatever `changes` says. */
  const pcktSays = (changes: Record<string, unknown>): void =>
    answer('pckt.blog', '/up', {
      status: 'ok',
      checks: { database: true, cache: true },
      jetstream: { cursor: 1, stale_seconds: 1 },
      ...changes
    })

  it.each([
    [{ status: 'maintenance' }, 'Application reports it is not ok'],
    [{ checks: { database: false, cache: true } }, 'Database is unreachable'],
    [{ checks: { database: true, cache: false } }, 'Cache is unreachable']
  ])('names which of pckt’s dependencies is unwell when /up reads %o', async (changes, error) => {
    pcktSays(changes)
    const { checks } = await probe('pckt:pckt.blog')
    expect(check(checks, 'up')).toMatchObject({ ok: false, error })
    // An application that has said it is not well is not read any further.
    expect(check(checks, 'index lag')).toMatchObject({
      ok: false,
      error: 'Skipped because up failed'
    })
  })

  it.each([
    [{ jetstream: { cursor: 1 } }, 'Consumer reported no staleness'],
    [{ jetstream: { cursor: 1, stale_seconds: 20 * 60 } }, 'Index trails by 20 minutes']
  ])('judges pckt’s index lag from %o', async (changes, error) => {
    pcktSays(changes)
    const { checks } = await probe('pckt:pckt.blog')
    expect(check(checks, 'up').ok).toBe(true)
    expect(check(checks, 'index lag')).toMatchObject({ ok: false, error, durationMs: null })
  })

  // What pckt said on 30 September 2026, while serving pages and a second behind.
  it('holds nothing against pckt’s search index or its failed jobs', async () => {
    pcktSays({ typesense: false, failed_jobs_last_hour: 112, horizon: { running: true } })
    const { checks } = await probe('pckt:pckt.blog')
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  it('skips UFOs’ index lag when there is no cursor to read it from', async () => {
    answer('ufos-api.microcosm.blue', '/meta', { consumer: {} })
    const { checks } = await probe('ufos:ufos-api.microcosm.blue')
    expect(check(checks, 'meta')).toMatchObject({ ok: false, error: 'Invalid response' })
    expect(check(checks, 'index lag')).toMatchObject({
      ok: false,
      error: 'Skipped because meta failed',
      durationMs: null
    })
    expect(check(checks, 'collections/stats').ok).toBe(true)
  })

  it('fails UFOs’ query path when the collection it asked about is missing', async () => {
    answer('ufos-api.microcosm.blue', '/collections/stats', {
      'app.bsky.feed.like': { creates: 1 }
    })
    const { checks } = await probe('ufos:ufos-api.microcosm.blue')
    expect(check(checks, 'collections/stats')).toMatchObject({
      ok: false,
      error: 'No collection stats'
    })
  })
})

describe('the identity services', () => {
  it('asks Slingshot for an identity and a record', async () => {
    const { checks } = await probe('slingshot:slingshot.microcosm.blue')
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['resolveHandle', true],
      ['getRecord', true],
      ['resolveMiniDoc', true]
    ])
  })

  it('fails a Slingshot that resolves a handle to the wrong DID', async () => {
    network.fail(
      'slingshot.microcosm.blue',
      {
        kind: 'respond',
        body: JSON.stringify({ did: 'did:plc:somebodyelse' }),
        contentType: 'application/json'
      },
      '/xrpc/com.atproto.identity.resolveHandle'
    )
    const { checks } = await probe('slingshot:slingshot.microcosm.blue')
    expect(check(checks, 'resolveHandle')).toMatchObject({
      ok: false,
      error: 'Resolved to the wrong DID'
    })
  })

  // Identity and records are cached separately, and either can break on its own.
  it.each([
    [
      '/xrpc/com.atproto.repo.getRecord',
      { cid: 'bafyreiprobe', value: { $type: 'app.bsky.feed.post' } },
      'getRecord',
      'Record was not a profile'
    ],
    [
      '/xrpc/com.atproto.repo.getRecord',
      { value: { $type: 'app.bsky.actor.profile' } },
      'getRecord',
      'Record was not a profile'
    ],
    [
      '/xrpc/blue.microcosm.identity.resolveMiniDoc',
      { did: CATALOGUE.anchor.did, handle: CATALOGUE.anchor.handle },
      'resolveMiniDoc',
      'Mini doc was incomplete'
    ]
  ])('fails a Slingshot whose %s reads %o', async (path, body, label, error) => {
    answer('slingshot.microcosm.blue', path, body)
    const { checks } = await probe('slingshot:slingshot.microcosm.blue')
    expect(check(checks, label)).toMatchObject({ ok: false, error })
    expect(checks.filter((c) => c.ok)).toHaveLength(2)
  })
})

describe('Tangled', () => {
  it('probes Tangled’s own PDS as a PDS', async () => {
    const { checks } = await probe('pds:tngl.sh')
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['_health', true],
      ['describeServer', true],
      ['listRepos', true],
      ['listRecords', true],
      ['getHostStatus', true]
    ])
  })

  it('checks the appview’s static route and its real page', async () => {
    const { checks } = await probe('tangled-appview:tangled.org')
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['go-get', true],
      ['repo page', true]
    ])
  })

  it('says when the appview served a 404 instead of the repository', async () => {
    network.fail(
      'tangled.org',
      {
        kind: 'respond',
        body: '<html><head><title>404 · Tangled</title></head></html>',
        contentType: 'text/html'
      },
      DEFAULT_PROBE_TARGETS.tangled.repoPath
    )
    const { checks } = await probe('tangled-appview:tangled.org')
    expect(check(checks, 'repo page')).toMatchObject({
      ok: false,
      error: 'Repository did not resolve'
    })
  })

  it('reads Bobbin’s coverage, its cursor and a record lookup', async () => {
    const { checks } = await probe('bobbin:api.tangled.org')
    expect(checks.map((c) => [c.label, c.kind, c.ok])).toEqual([
      ['getCoverage', 'http', true],
      ['getRepoByRepoDid', 'http', true],
      ['event cursor', 'derived', true]
    ])
  })

  it('says when Bobbin is still backfilling', async () => {
    network.fail(
      'api.tangled.org',
      {
        kind: 'respond',
        body: JSON.stringify({ ready: false, eventsProcessed: 10, lastCursor: 11 }),
        contentType: 'application/json'
      },
      '/xrpc/sh.tangled.bobbin.getCoverage'
    )
    const { checks } = await probe('bobbin:api.tangled.org')
    expect(check(checks, 'getCoverage')).toMatchObject({
      ok: false,
      error: 'Still backfilling from upstream'
    })
    // The cursor is still readable, so it is still judged.
    expect(check(checks, 'event cursor').ok).toBe(true)
  })

  it('identifies Bobbin’s upstream', async () => {
    const { checks } = await probe('hydrant:api.tangled.org')
    expect(checks.map((c) => [c.label, c.ok])).toEqual([['health', true]])
    expect(check(checks, 'health').target).toBe('https://api.tangled.org/health')
  })

  it('asks a knot 2 for its health and its repositories as well', async () => {
    const { checks } = await probe('knot:knot1.tangled.sh')
    expect(checks.map((c) => c.label)).toEqual([
      'knot.version',
      'owner',
      '_health',
      'sync.listRepos'
    ])
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  it('does not ask a knot 1 for an endpoint it does not have', async () => {
    // Knot 1 answers the version route without knot 2's capabilities, and 404s on
    // `/xrpc/_health` — which is perfectly healthy, and must not read as an outage.
    network.fail(
      'knot1.tangled.sh',
      {
        kind: 'respond',
        body: JSON.stringify({ version: 'v1.16.1-alpha' }),
        contentType: 'application/json'
      },
      '/xrpc/sh.tangled.knot.version'
    )
    network.fail('knot1.tangled.sh', { kind: 'http', status: 404 }, '/xrpc/_health')
    const { checks } = await probe('knot:knot1.tangled.sh')
    expect(checks.map((c) => c.label)).toEqual(['knot.version', 'owner'])
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  it('checks a spindle on its bare health route', async () => {
    const { checks } = await probe('spindle:spindle.tangled.sh')
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['_health', true],
      ['owner', true]
    ])
    // A knot's is under /xrpc; a spindle's is not. They do not share a constant.
    expect(check(checks, '_health').target).toBe('https://spindle.tangled.sh/_health')
  })

  it('fails a repository page with no title to read', async () => {
    network.fail(
      'tangled.org',
      { kind: 'respond', body: '<html><body>Tangled</body></html>', contentType: 'text/html' },
      DEFAULT_PROBE_TARGETS.tangled.repoPath
    )
    const { checks } = await probe('tangled-appview:tangled.org')
    expect(check(checks, 'repo page')).toMatchObject({ ok: false, error: 'Page carried no title' })
    expect(check(checks, 'go-get').ok).toBe(true)
  })

  it('fails a go-get route that names some other repository', async () => {
    network.fail(
      'tangled.org',
      {
        kind: 'respond',
        body: '<meta name="go-import" content="tangled.org/else git https://tangled.org/@else">',
        contentType: 'text/html'
      },
      new URL(DEFAULT_PROBE_TARGETS.tangled.goGetPath, 'https://tangled.org').pathname
    )
    const { checks } = await probe('tangled-appview:tangled.org')
    expect(check(checks, 'go-get')).toMatchObject({ ok: false, error: 'Unexpected go-import meta' })
  })

  it('skips Bobbin’s cursor when its coverage reports none', async () => {
    answer('api.tangled.org', '/xrpc/sh.tangled.bobbin.getCoverage', { ready: true })
    const { checks } = await probe('bobbin:api.tangled.org')
    expect(check(checks, 'getCoverage')).toMatchObject({ ok: false, error: 'No coverage reported' })
    expect(check(checks, 'event cursor')).toMatchObject({
      ok: false,
      error: 'Skipped because getCoverage failed',
      durationMs: null
    })
  })

  it.each([
    [
      'bobbin:api.tangled.org',
      '/xrpc/sh.tangled.repo.getRepoByRepoDid',
      { value: { knot: 'knot.elsewhere.test' } },
      'getRepoByRepoDid',
      'Repo resolved to the wrong knot'
    ],
    [
      'hydrant:api.tangled.org',
      '/health',
      { name: 'hydrant', mode: 'backfill' },
      'health',
      'Upstream did not identify itself'
    ],
    [
      'knot:knot1.tangled.sh',
      '/xrpc/sh.tangled.knot.version',
      { version: '' },
      'knot.version',
      'No version reported'
    ],
    [
      'knot:knot1.tangled.sh',
      '/xrpc/sh.tangled.owner',
      { owner: 'tangled.sh' },
      'owner',
      'No owner DID'
    ],
    // Only a knot 2 is asked these two, and it names the capability that says so.
    ['knot:knot1.tangled.sh', '/xrpc/_health', {}, '_health', 'Unexpected health response'],
    [
      'knot:knot1.tangled.sh',
      '/xrpc/sh.tangled.sync.listRepos',
      { cursor: '' },
      'sync.listRepos',
      'No repositories listed'
    ],
    [
      'spindle:spindle.tangled.sh',
      '/_health',
      { status: 'starting' },
      '_health',
      'Unexpected health response'
    ]
  ])('fails %s when %s reads %o', async (id, path, body, label, error) => {
    answer(service(id).host, path, body)
    const { checks } = await probe(id)
    expect(check(checks, label)).toMatchObject({ ok: false, error })
  })
})

describe('the publishing apps', () => {
  it('resolves a Leaflet publication and searches its index', async () => {
    const { checks } = await probe('leaflet:leaflet.pub')
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['publication', true],
      ['search', true],
      ['newest document', true]
    ])
  })

  it('posts the Leaflet search rather than asking for it', async () => {
    const sent: RequestInit[] = []
    const transport: ProbeTransport = {
      fetch: (url, init) => {
        if (new URL(url).pathname === '/api/rpc/search_publication_names') sent.push(init)
        return network.fetch(url, init)
      },
      openSocket: network.openSocket
    }
    await probe('leaflet:leaflet.pub', { transport })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ query: CATALOGUE.apps.leaflet.query }),
      headers: { 'content-type': 'application/json' }
    })
  })

  it('runs Leaflet’s expensive feed check hourly, not every sweep', async () => {
    const counters = memoryCounters()
    let clock = Date.now()
    const now = (): number => clock
    const labels = async (): Promise<string[]> =>
      (await probe('leaflet:leaflet.pub', { counters, now })).checks.map((c) => c.label)

    expect(await labels()).toContain('newest document')
    clock += 59 * 60_000
    expect(await labels()).not.toContain('newest document')
    clock += 60_000
    expect(await labels()).toContain('newest document')
  })

  const { publication, feed } = DEFAULT_PROBE_TARGETS.apps.leaflet

  it.each([
    [
      `/lish/${publication.did}/${publication.rkey}/.well-known/site.standard.publication`,
      'text/plain',
      `at://did:plc:someoneelse/site.standard.publication/${publication.rkey}`,
      'publication',
      'Publication did not resolve'
    ],
    [
      '/api/rpc/search_publication_names',
      'application/json',
      '{"result":{"publications":[]}}',
      'search',
      'Search returned nothing'
    ]
  ])('fails Leaflet when %s answers %s %s', async (path, contentType, body, label, error) => {
    network.fail('leaflet.pub', { kind: 'respond', body, contentType }, path)
    const { checks } = await probe('leaflet:leaflet.pub')
    expect(check(checks, label)).toMatchObject({ ok: false, error })
  })

  it('takes Leaflet’s search results without the envelope as well', async () => {
    answer('leaflet.pub', '/api/rpc/search_publication_names', {
      publications: [{ uri: 'at://did:plc:pub/x/y', name: 'Leaflet' }]
    })
    const { checks } = await probe('leaflet:leaflet.pub')
    expect(check(checks, 'search').ok).toBe(true)
  })

  it.each([
    [
      'leaflet:leaflet.pub',
      `/lish/${feed.did}/${feed.rkey}/atom`,
      `<feed><updated>${daysAgo(40).toISOString()}</updated></feed>`,
      'newest document',
      'Newest document is 40 days old'
    ],
    [
      'leaflet:leaflet.pub',
      `/lish/${feed.did}/${feed.rkey}/atom`,
      '<feed><title>No dates here</title></feed>',
      'newest document',
      'Feed carried no date'
    ],
    [
      'leaflet:leaflet.pub',
      `/lish/${feed.did}/${feed.rkey}/atom`,
      '<feed><updated>last Tuesday</updated></feed>',
      'newest document',
      'Feed carried no date'
    ]
  ])('fails %s when its feed at %s reads %s', async (id, path, body, label, error) => {
    network.fail(service(id).host, { kind: 'respond', body, contentType: 'application/xml' }, path)
    const { checks } = await probe(id)
    expect(check(checks, label)).toMatchObject({ ok: false, error })
  })

  it('checks Offprint’s health and its custom-domain lookup', async () => {
    const { checks } = await probe('offprint:offprint.app')
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['up', true],
      ['publication', true]
    ])
  })

  it('fails an Offprint that is not up', async () => {
    network.fail(
      'offprint.app',
      { kind: 'respond', body: '<html>Down for maintenance</html>', contentType: 'text/html' },
      '/up'
    )
    const { checks } = await probe('offprint:offprint.app')
    expect(check(checks, 'up')).toMatchObject({ ok: false, error: 'Application is not up' })
  })

  it('fails Offprint when its publication does not resolve', async () => {
    network.fail('news.offprint.app', {
      kind: 'respond',
      body: 'at://did:plc:someoneelse/site.standard.publication/nope'
    })
    const { checks } = await probe('offprint:offprint.app')
    expect(check(checks, 'publication')).toMatchObject({
      ok: false,
      error: 'Publication did not resolve'
    })
  })
})

describe('what a sweep is asked to read', () => {
  it('asks each listed feed’s own host for its own feed', async () => {
    const cats = 'at://did:plc:cats/app.bsky.feed.generator/cats'
    const feeds = [
      ...DEFAULT_PROBE_TARGETS.feeds,
      { label: 'Cats', host: 'feeds.example.test', uri: cats }
    ]
    const row = servicesFor(targets({ feeds })).find((s) => s.id === 'feed:feeds.example.test')!
    expect(row).toMatchObject({ kind: 'feed', label: 'Cats', group: 'infrastructure' })

    const checks: ProbeCheck[] = []
    await probeService(row, checks, context({ targets: targets({ feeds }) }))
    expect(checks).toEqual([expect.objectContaining({ label: 'getFeedSkeleton', ok: true })])
    const url = new URL(checks[0]!.target!)
    expect(url.hostname).toBe('feeds.example.test')
    expect(url.searchParams.get('feed')).toBe(cats)
  })

  it('says so, without asking, when a feed row has outlived its feed', async () => {
    const { checks } = await probe('feed:discover.bsky.app', { targets: targets({ feeds: [] }) })
    expect(checks).toEqual([
      expect.objectContaining({
        label: 'getFeedSkeleton',
        target: null,
        ok: false,
        error: 'No feed is listed for this host',
        durationMs: null
      })
    ])
    expect(network.requests).toHaveLength(0)
  })

  it('fetches exactly the images it is given', async () => {
    const image = { did: 'did:plc:someone', cid: 'bafkreiexampleexampleexampleexample' }
    const { checks } = await probe('cdn:cdn.bsky.app', {
      targets: targets({ cdnImages: [image] })
    })
    expect(checks.map((c) => c.target)).toEqual([
      `https://cdn.bsky.app/img/feed_fullsize/plain/${image.did}/${image.cid}`
    ])
  })

  it('holds For You to the DID and feed it is given', async () => {
    const forYou = {
      did: 'did:web:elsewhere.test',
      feed: 'at://did:plc:someone/app.bsky.feed.generator/other'
    }
    const { checks } = await probe('foryou:foryou.club', { targets: targets({ forYou }) })
    expect(new URL(check(checks, 'getFeedSkeleton').target!).searchParams.get('feed')).toBe(
      forYou.feed
    )
    // The real site still names its own DID, which is not the one listed.
    expect(check(checks, 'did.json').error).toBe('DID document names a different DID')
    expect(check(checks, 'getFeedGenerator').error).toBe('Generator record points elsewhere')
  })

  describe('a Tangled repository of the user’s choosing', () => {
    const tangled = {
      goGetPath: '/someone.test/tool?go-get=1',
      repoPath: '/someone.test/tool',
      repoDid: 'did:plc:toolrepo',
      ownerDid: 'did:plc:someone'
    }

    it('finds the page’s title from its path', async () => {
      network.useTargets(targets({ tangled }))
      const { checks } = await probe('tangled-appview:tangled.org', {
        targets: targets({ tangled })
      })
      expect(checks.map((c) => [c.label, c.target, c.ok])).toEqual([
        ['go-get', 'https://tangled.org/someone.test/tool?go-get=1', true],
        ['repo page', 'https://tangled.org/someone.test/tool', true]
      ])
    })

    it('fails a page that titles itself as some other repository', async () => {
      network.fail(
        'tangled.org',
        {
          kind: 'respond',
          body: '<html><head><title>tangled.org/core at master · Tangled</title></head></html>',
          contentType: 'text/html'
        },
        tangled.repoPath
      )
      const { checks } = await probe('tangled-appview:tangled.org', {
        targets: targets({ tangled })
      })
      expect(check(checks, 'repo page')).toMatchObject({ ok: false, error: 'Unexpected page' })
    })

    // The schema refuses these. A document that reached the probes some other way must
    // still not be able to aim a check at another machine.
    it.each([
      ['a second slash', '//127.0.0.1:631/x?go-get=1'],
      ['a backslash', '/\\evil.example/x?go-get=1']
    ])('asks nothing of a host the path names with %s', async (_name, goGetPath) => {
      const { checks } = await probe('tangled-appview:tangled.org', {
        targets: targets({ tangled: { ...tangled, goGetPath } })
      })
      expect(check(checks, 'go-get')).toMatchObject({
        target: null,
        ok: false,
        error: 'Path leads off tangled.org',
        durationMs: null
      })
      expect(network.requests.map((request) => request.host)).toEqual(['tangled.org'])
    })

    it('asks Bobbin for the listed repository, and the spindle for the listed owner', async () => {
      const { checks: bobbin } = await probe('bobbin:api.tangled.org', {
        targets: targets({ tangled })
      })
      expect(new URL(check(bobbin, 'getRepoByRepoDid').target!).searchParams.get('repoDid')).toBe(
        tangled.repoDid
      )

      // The real spindle is still owned by Tangled's own account, not the one listed.
      const { checks: spindle } = await probe('spindle:spindle.tangled.sh', {
        targets: targets({ tangled })
      })
      expect(check(spindle, 'owner')).toMatchObject({ ok: false, error: 'Unexpected owner DID' })
    })
  })

  it('reads the Leaflet documents it is given', async () => {
    const apps = {
      ...structuredClone(DEFAULT_PROBE_TARGETS.apps),
      leaflet: {
        publication: { did: 'did:plc:writer', rkey: '3aaaaaaaaaaaa' },
        feed: { did: 'did:plc:busy', rkey: '3bbbbbbbbbbbb' }
      }
    }
    network.useTargets(targets({ apps }))
    const { checks: leaflet } = await probe('leaflet:leaflet.pub', { targets: targets({ apps }) })
    expect(leaflet.every((c) => c.ok)).toBe(true)
    expect(check(leaflet, 'publication').target).toBe(
      'https://leaflet.pub/lish/did:plc:writer/3aaaaaaaaaaaa/.well-known/site.standard.publication'
    )
    expect(check(leaflet, 'newest document').target).toBe(
      'https://leaflet.pub/lish/did:plc:busy/3bbbbbbbbbbbb/atom'
    )
  })

  /**
   * pckt and Offprint answer a publication's well-known route on the publication's own
   * host, which only the publication's record knows. Asking the catalogue's blog about
   * somebody else's publication could only ever fail.
   */
  describe.each([
    ['pckt', 'pckt:pckt.blog', 'notes.pckt.blog'],
    ['offprint', 'offprint:offprint.app', 'news.offprint.app']
  ] as const)('a %s publication of the user’s choosing', (app, id, catalogued) => {
    const publication = 'at://did:plc:writer/site.standard.publication/3cccccccccccc'
    const chosen = (): ProbeTargets =>
      targets({ apps: { ...structuredClone(DEFAULT_PROBE_TARGETS.apps), [app]: { publication } } })
    const lookups = (): string[] =>
      network.requestsTo(CATALOGUE.microcosm.slingshot).map((request) => request.url)

    it('asks the checked-in one’s host straight away, and Slingshot nothing', async () => {
      const { checks } = await probe(id)
      expect(check(checks, 'publication')).toMatchObject({
        target: `https://${catalogued}/.well-known/site.standard.publication`,
        ok: true
      })
      expect(lookups()).toEqual([])
    })

    it('reads where it is served from its record, and asks there', async () => {
      network.publish(publication, 'https://writer.example')
      const { checks } = await probe(id, { targets: chosen() })
      expect(lookups()).toEqual([
        `https://${CATALOGUE.microcosm.slingshot}/xrpc/com.atproto.repo.getRecord?` +
          'repo=did%3Aplc%3Awriter&collection=site.standard.publication&rkey=3cccccccccccc'
      ])
      expect(check(checks, 'publication')).toMatchObject({
        target: 'https://writer.example/.well-known/site.standard.publication',
        ok: true
      })
    })

    it('follows a publication that lives under a path', async () => {
      network.publish(publication, 'https://writer.example/notes')
      const { checks } = await probe(id, { targets: chosen() })
      expect(check(checks, 'publication')).toMatchObject({
        target: 'https://writer.example/notes/.well-known/site.standard.publication',
        ok: true
      })
    })

    it('fails when the host it names serves some other publication', async () => {
      network.publish(publication, `https://${catalogued}`)
      const { checks } = await probe(id, { targets: chosen() })
      expect(check(checks, 'publication').error).toBe('Publication did not resolve')
    })

    it('fails, untimed, when the record has gone', async () => {
      const { checks } = await probe(id, { targets: chosen() })
      expect(check(checks, 'publication')).toMatchObject({
        target: null,
        ok: false,
        error: 'Publication record is gone',
        durationMs: null
      })
    })

    it('leaves the check out when Slingshot cannot say, rather than blame the app', async () => {
      network.fail(CATALOGUE.microcosm.slingshot, { kind: 'http', status: 502 })
      const { checks } = await probe(id, { targets: chosen() })
      expect(checks.map((c) => c.label)).not.toContain('publication')
      expect(probeState(checks)).toBe('live')
    })

    // Somebody else's record, so somebody else's URL: none of these is followed.
    it.each([
      ['no URL at all', ''],
      ['plain HTTP', 'http://writer.example'],
      ['an address', 'https://127.0.0.1'],
      ['localhost', 'https://localhost'],
      ['a port', 'https://writer.example:8443']
    ])('refuses a record naming %s', async (_name, url) => {
      network.publish(publication, url)
      const { checks } = await probe(id, { targets: chosen() })
      expect(check(checks, 'publication')).toMatchObject({
        target: null,
        ok: false,
        error: 'Publication record names no URL it is served at'
      })
      expect(network.requests.map((request) => request.host)).not.toContain('127.0.0.1')
    })

    it('refuses a record that names no URL at all', async () => {
      answer(CATALOGUE.microcosm.slingshot, '/xrpc/com.atproto.repo.getRecord', {
        uri: publication,
        value: { $type: 'site.standard.publication', name: 'A blog' }
      })
      const { checks } = await probe(id, { targets: chosen() })
      expect(check(checks, 'publication').error).toBe(
        'Publication record names no URL it is served at'
      )
    })
  })
})

describe('tidToMillis', () => {
  it('reads the time back out of a TID', () => {
    const at = 1_758_300_000_000
    expect(tidToMillis(tid(at))).toBeCloseTo(at, 0)
  })

  it('refuses anything that is not one', () => {
    expect(tidToMillis('')).toBeNull()
    expect(tidToMillis('too-short')).toBeNull()
    // `1`, `8`, `9` and `0` are not in the sortable alphabet.
    expect(tidToMillis('3mvvoil7y3t2!')).toBeNull()
    expect(tidToMillis('3mvvoil7y3t21')).toBeNull()
  })
})

describe('readFrame', () => {
  it('reads a commit and its time', () => {
    expect(readFrame(commitFrame('2026-01-01T00:00:00Z'))).toEqual({
      kind: 'commit',
      time: '2026-01-01T00:00:00Z'
    })
  })

  it('reads a commit with no body worth the name', () => {
    expect(readFrame(frame({ op: 1, t: '#commit' }, 'odd'))).toEqual({
      kind: 'commit',
      time: undefined
    })
  })

  it('passes over other events', () => {
    expect(readFrame(frame({ op: 1, t: '#account' }, {}))).toEqual({ kind: 'other' })
  })

  it('reads an error frame, with or without a message', () => {
    expect(readFrame(errorFrame('FutureCursor', 'Cursor in the future'))).toEqual({
      kind: 'error',
      message: 'FutureCursor: Cursor in the future'
    })
    expect(readFrame(errorFrame('FutureCursor'))).toEqual({
      kind: 'error',
      message: 'FutureCursor'
    })
    expect(readFrame(frame({ op: -1 }, 7))).toEqual({ kind: 'error', message: 'Error' })
  })

  it.each([
    ['text', 'hello'],
    ['a header that is not a map', frame([1], {})],
    ['an unknown op', frame({ op: 2 }, {})],
    ['truncated bytes', new Uint8Array([0xa1]).buffer]
  ])('refuses %s', (_name, data) => {
    expect(readFrame(data)).toEqual({ kind: 'invalid' })
  })
})

describe('newestPostTime', () => {
  it('finds the newest parseable createdAt across every feed', () => {
    expect(
      newestPostTime([
        { feed: [{ post: { record: { createdAt: '2026-01-01T00:00:00Z' } } }] },
        {
          feed: [
            { post: { record: { createdAt: '2026-01-02T00:00:00Z' } } },
            { post: { record: { createdAt: 'yesterday' } } },
            { post: { record: { createdAt: 5 } } },
            { post: { record: 'x' } },
            { post: null },
            null
          ]
        },
        { feed: 'no' },
        null
      ])
    ).toBe(Date.parse('2026-01-02T00:00:00Z'))
  })

  it('is null when nothing parses', () => {
    expect(newestPostTime([{ feed: [] }])).toBeNull()
  })
})

describe('TargetCensus', () => {
  it('calls something gone once two indexes say so and none disagree', async () => {
    const census = new TargetCensus(3)
    const [a, b, c] = await Promise.all([
      census.report('one', sightings([['account did:plc:x', 'missing']])),
      census.report('two', sightings([['account did:plc:x', 'missing']])),
      // An AppView that could not answer abstains.
      census.report('three', sightings([]))
    ])
    for (const verdict of [a, b, c]) expect([...verdict]).toEqual(['account did:plc:x'])
  })

  it('believes any AppView that still has it', async () => {
    const census = new TargetCensus(3)
    await Promise.all([
      census.report('one', sightings([['account did:plc:x', 'missing']])),
      census.report('two', sightings([['account did:plc:x', 'missing']])),
      census.report('three', sightings([['account did:plc:x', 'present']]))
    ])
    expect(census.verdict.size).toBe(0)
  })

  it('hears one index once, however many names it answers to', async () => {
    const census = new TargetCensus(2)
    await Promise.all([
      census.report('api.bsky.app', sightings([['account did:plc:x', 'missing']])),
      census.report('api.bsky.app', sightings([['account did:plc:x', 'missing']]))
    ])
    expect(census.verdict.size).toBe(0)
  })

  it('answers with the last verdict until somebody reports', () => {
    const previous = new Set(['handle did:plc:x'])
    expect(new TargetCensus(2, previous).verdict).toBe(previous)
  })

  it('keeps the last verdict through a sweep that cannot say either way', async () => {
    const census = new TargetCensus(1, new Set(['account did:plc:x']))
    // A re-check of one AppView, timing out on the account.
    await census.report('one', sightings([]))
    expect([...census.verdict]).toEqual(['account did:plc:x'])
  })

  it('lets the last verdict go the moment an AppView has the account again', async () => {
    const census = new TargetCensus(1, new Set(['account did:plc:x', 'handle did:plc:y']))
    await census.report('one', sightings([['account did:plc:x', 'present']]))
    expect([...census.verdict]).toEqual(['handle did:plc:y'])
  })

  it('waits for every AppView before answering', async () => {
    const census = new TargetCensus(2)
    let answered = false
    const first = census.report('one', sightings([['account did:plc:x', 'missing']])).then((v) => {
      answered = true
      return v
    })
    await Promise.resolve()
    expect(answered).toBe(false)
    await census.report('two', sightings([['account did:plc:x', 'missing']]))
    expect([...(await first)]).toEqual(['account did:plc:x'])
  })
})

describe('FreshnessPeers', () => {
  it('waits for every AppView before answering any', async () => {
    const peers = new FreshnessPeers(2)
    let first: NewestPosts | undefined
    const pending = peers.report(new Map([['a', 100]])).then((best) => (first = best))
    await Promise.resolve()
    expect(first).toBeUndefined()

    await expect(peers.report(new Map([['a', 300]]))).resolves.toEqual(new Map([['a', 300]]))
    await pending
    expect(first).toEqual(new Map([['a', 300]]))
  })

  it('keeps the freshest of each account apart', async () => {
    const peers = new FreshnessPeers(2)
    void peers.report(
      new Map([
        ['a', 300],
        ['b', 100]
      ])
    )
    await expect(peers.report(new Map([['b', 200]]))).resolves.toEqual(
      new Map([
        ['a', 300],
        ['b', 200]
      ])
    )
  })

  it('keeps an earlier best that nobody beats', async () => {
    const earlier = new Map([['a', 500]])
    const peers = new FreshnessPeers(1, earlier)
    await expect(peers.report(new Map([['a', 400]]))).resolves.toEqual(earlier)
    expect(peers.best).toEqual(earlier)
  })
})
