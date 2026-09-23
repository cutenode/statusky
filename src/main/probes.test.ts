import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATALOGUE, SERVICES, servicesFor, type ServiceDefinition } from '../shared/network'
import { DEFAULT_PROBE_TARGETS } from '../shared/probe-targets'
import type { ProbeCheck, ProbeTargets } from '../shared/types'
import { commitFrame, errorFrame, frame } from '../test/cbor'
import { FakeNetwork, FakeSocket, jetstreamEvent, spacedustLink, tid } from '../test/network'
import {
  DEFAULT_PROBE_TIMINGS,
  FreshnessPeers,
  describeError,
  newestPostTime,
  probeService,
  readFrame,
  tidToMillis,
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
  firehoseWindowMs: 60
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
    peers: new FreshnessPeers(1, null),
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

  it('passes health, server description, and a real read of one repository', async () => {
    const { checks } = await probe(id)
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['_health', true],
      ['describeServer', true],
      ['listRepos', true],
      ['listRecords', true]
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
      'newest post'
    ])
    expect(checks.every((c) => c.ok)).toBe(true)
    expect(check(checks, 'newest post')).toMatchObject({ kind: 'derived', target: null })
  })

  /**
   * Three lists became one, so every account is now asked about all three ways. Which
   * accounts the defaults hold is src/shared/probe-targets.test.ts's business.
   */
  it('makes three requests per account, plus its health check', async () => {
    await probe(id)
    expect(network.requestsTo(host)).toHaveLength(1 + 3 * DEFAULT_PROBE_TARGETS.accounts.length)
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
    expect(check(checks, 'resolveHandle')).toMatchObject({ ok: false, error: 'HTTP 400' })
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
    const peers = new FreshnessPeers(2, null)
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
    expect(peers.best).toBe(Date.parse(quiet))
  })

  it('remembers the freshest post from an earlier sweep', async () => {
    network.setNewestPost(host, new Date(Date.now() - 3_600_000).toISOString())
    const { checks } = await probe(id, { peers: new FreshnessPeers(1, Date.now()) })
    expect(check(checks, 'newest post').error).toBe('Newest post trails other AppViews by 1 hour')
  })

  it('still reports to its peers when it has nothing to say, so none wait forever', async () => {
    network.setNewestPost('api.bsky.app', null)
    const peers = new FreshnessPeers(2, null)
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

  it('reads pckt’s health, its index lag and its queues from one response', async () => {
    const { checks } = await probe('pckt:pckt.blog')
    expect(checks.map((c) => [c.label, c.kind, c.ok])).toEqual([
      ['up', 'http', true],
      ['index lag', 'derived', true],
      ['queues', 'derived', true]
    ])
    expect(check(checks, 'up').target).toBe('https://pckt.blog/up')
  })

  /** pckt's `/up` with everything well, and then whatever `changes` says. */
  const pcktSays = (changes: Record<string, unknown>): void =>
    answer('pckt.blog', '/up', {
      status: 'ok',
      checks: { database: true, cache: true },
      typesense: true,
      horizon: { running: true },
      jetstream: { cursor: 1, stale_seconds: 1 },
      failed_jobs_last_hour: 0,
      queues: { default: 0, media: 0, search: 0 },
      ...changes
    })

  it.each([
    [{ status: 'maintenance' }, 'Application reports it is not ok'],
    [{ checks: { database: false, cache: true } }, 'Database is unreachable'],
    [{ checks: { database: true, cache: false } }, 'Cache is unreachable'],
    [{ typesense: false }, 'Search index is unreachable'],
    [{ horizon: { running: false } }, 'Queue worker is not running']
  ])('names which of pckt’s dependencies is unwell when /up reads %o', async (changes, error) => {
    pcktSays(changes)
    const { checks } = await probe('pckt:pckt.blog')
    expect(check(checks, 'up')).toMatchObject({ ok: false, error })
    // An application that has said it is not well is not read any further.
    for (const label of ['index lag', 'queues']) {
      expect(check(checks, label)).toMatchObject({ ok: false, error: 'Skipped because up failed' })
    }
  })

  it.each([
    [{ jetstream: { cursor: 1 } }, 'Consumer reported no staleness'],
    [{ jetstream: { cursor: 1, stale_seconds: 20 * 60 } }, 'Index trails by 20 minutes']
  ])('judges pckt’s index lag from %o', async (changes, error) => {
    pcktSays(changes)
    const { checks } = await probe('pckt:pckt.blog')
    expect(check(checks, 'up').ok).toBe(true)
    expect(check(checks, 'index lag')).toMatchObject({ ok: false, error, durationMs: null })
    expect(check(checks, 'queues').ok).toBe(true)
  })

  it.each([
    [{ failed_jobs_last_hour: 1 }, '1 job failed in the last hour'],
    // Failed jobs are the worse news, and say so even with a queue backed up beside them.
    [{ failed_jobs_last_hour: 3, queues: { media: 4000 } }, '3 jobs failed in the last hour'],
    [{ queues: { search: 0, media: 4000 } }, '1 queue backed up: media (4000)'],
    [
      { queues: { default: 501, media: 4000, search: 500 } },
      '2 queues backed up: default (501), media (4000)'
    ]
  ])('reports pckt’s queues from %o', async (changes, error) => {
    pcktSays(changes)
    const { checks } = await probe('pckt:pckt.blog')
    expect(check(checks, 'index lag').ok).toBe(true)
    expect(check(checks, 'queues')).toMatchObject({ ok: false, error, durationMs: null })
  })

  it('holds nothing against pckt that its /up leaves out', async () => {
    pcktSays({ failed_jobs_last_hour: undefined, queues: undefined })
    const { checks } = await probe('pckt:pckt.blog')
    expect(check(checks, 'queues').ok).toBe(true)
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
      ['listRecords', true]
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

  it.each([
    ['leaflet:leaflet.pub', 'newest document'],
    ['offprint:offprint.app', 'newest article']
  ])('runs %s’s expensive feed check hourly, not every sweep', async (id, label) => {
    const counters = memoryCounters()
    let clock = Date.now()
    const now = (): number => clock
    const labels = async (): Promise<string[]> =>
      (await probe(id, { counters, now })).checks.map((c) => c.label)

    expect(await labels()).toContain(label)
    clock += 59 * 60_000
    expect(await labels()).not.toContain(label)
    clock += 60_000
    expect(await labels()).toContain(label)
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
    ],
    [
      'offprint:offprint.app',
      '/feed',
      `<rss><channel><lastBuildDate>${daysAgo(40).toUTCString()}</lastBuildDate></channel></rss>`,
      'newest article',
      'Newest article is 40 days old'
    ],
    [
      'offprint:offprint.app',
      '/feed',
      '<rss><channel></channel></rss>',
      'newest article',
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
      ['publication', true],
      ['newest article', true]
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

  it('reads the Leaflet and Offprint documents it is given', async () => {
    const apps = {
      leaflet: {
        publication: { did: 'did:plc:writer', rkey: '3aaaaaaaaaaaa' },
        feed: { did: 'did:plc:busy', rkey: '3bbbbbbbbbbbb' }
      },
      offprint: {
        publication: 'at://did:plc:writer/site.standard.publication/3cccccccccccc'
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

    const { checks: offprint } = await probe('offprint:offprint.app', {
      targets: targets({ apps })
    })
    expect(check(offprint, 'publication').ok).toBe(true)
  })

  it('fails Offprint when the publication listed is not the one the host serves', async () => {
    const apps = {
      ...structuredClone(DEFAULT_PROBE_TARGETS.apps),
      offprint: { publication: 'at://did:plc:writer/site.standard.publication/3cccccccccccc' }
    }
    const { checks } = await probe('offprint:offprint.app', { targets: targets({ apps }) })
    expect(check(checks, 'publication').error).toBe('Publication did not resolve')
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

describe('FreshnessPeers', () => {
  it('waits for every AppView before answering any', async () => {
    const peers = new FreshnessPeers(2, null)
    let first: number | null | undefined
    const pending = peers.report(100).then((best) => (first = best))
    await Promise.resolve()
    expect(first).toBeUndefined()

    await expect(peers.report(300)).resolves.toBe(300)
    await pending
    expect(first).toBe(300)
  })

  it('keeps an earlier best that nobody beats', async () => {
    const peers = new FreshnessPeers(1, 500)
    await expect(peers.report(null)).resolves.toBe(500)
    expect(peers.best).toBe(500)
  })
})
