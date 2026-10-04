/**
 * Global setup shared by every test project: every double starts each test in the same
 * state, so no test can depend on a neighbour having run first, and no test reaches the
 * network.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { resetElectron } from './electron'
import { resetWebFrame } from './electron-renderer'
import { resetStores } from './electron-store'
import { resetFactories } from './factories'
import { resetPage } from './page'
import { resetUpdateElectronApp } from './update-electron-app'

/**
 * The network, closed.
 *
 * A test that reaches a real server is slow, flaky, and testing somebody else's uptime.
 * Every layer that talks to the network takes its transport from outside — `fetchImpl` in
 * src/shared/bsky.ts, a `ProbeTransport` for the network checks, `net.fetch` from the
 * Electron double — and the fake AppView puts itself in front of the global `fetch` while
 * it is installed. None of that stops a test that forgets: code that falls through to the
 * real global reaches the real internet, and passes or fails on whatever it said.
 *
 * So the real `fetch` and `WebSocket` are wrapped in ones that refuse anything that would
 * leave the machine. Loopback is let through, because the webhook receiver is tested as a
 * real socket on 127.0.0.1 (src/main/webhook.test.ts), and so is anything that is not
 * http(s) or ws(s). A refused `fetch` rejects and a refused `WebSocket` throws, the way
 * an unreachable host would surface — and the attempt is also written down, because app
 * code is entitled to catch a failed request and carry on, as the sync loop does, and a
 * test must not pass on the strength of a request it was never allowed to make.
 * `afterEach` fails whichever test made one.
 *
 * The wrappers are assigned rather than installed with `vi.stubGlobal`, so a test that
 * unstubs its own globals gets them back rather than the real ones. The record lives on
 * `globalThis` rather than in this module, because this file is evaluated once per test
 * file and the global it wraps may outlive one evaluation: a wrapper is never wrapped
 * again, and every one of them writes to the same list.
 */
interface ClosedNetwork {
  /** Every request a test tried to send off the machine since the last test ended. */
  readonly refused: string[]
  /** The wrappers already installed. */
  readonly wrappers: WeakSet<object>
}

const CLOSED_NETWORK = Symbol.for('statusky.test.closed-network')
const network: ClosedNetwork = ((globalThis as { [CLOSED_NETWORK]?: ClosedNetwork })[
  CLOSED_NETWORK
] ??= { refused: [], wrappers: new WeakSet() })

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    hostname === '[::1]'
  )
}

/** The error to fail with, and a note of the attempt, if `target` is off this machine. */
function refusal(api: string, target: unknown): Error | undefined {
  const raw =
    typeof target === 'object' && target !== null && 'url' in target
      ? String(target.url)
      : String(target)
  let url: URL
  try {
    url = new URL(raw, (globalThis as { location?: { href: string } }).location?.href)
  } catch {
    // Not a URL at all; the real API will refuse it in its own words.
    return undefined
  }
  if (!/^(?:https?|wss?):$/.test(url.protocol) || isLoopback(url.hostname)) return undefined

  const attempt = `${api} ${url.href}`
  network.refused.push(attempt)
  return new Error(
    `The test suite does not reach the network, and this tried to: ${attempt}. Install the ` +
      'fake AppView (src/test/appview.ts), or hand the code under test a transport.'
  )
}

if (typeof globalThis.fetch === 'function' && !network.wrappers.has(globalThis.fetch)) {
  const closed = new Proxy(globalThis.fetch, {
    apply(target, thisArg, args: Parameters<typeof fetch>) {
      const refused = refusal('fetch', args[0])
      return refused ? Promise.reject(refused) : Reflect.apply(target, thisArg, args)
    }
  })
  network.wrappers.add(closed)
  globalThis.fetch = closed
}

if (typeof globalThis.WebSocket === 'function' && !network.wrappers.has(globalThis.WebSocket)) {
  const closed = new Proxy(globalThis.WebSocket, {
    construct(target, args: ConstructorParameters<typeof WebSocket>, newTarget) {
      const refused = refusal('WebSocket', args[0])
      if (refused) throw refused
      return Reflect.construct(target, args, newTarget)
    }
  })
  network.wrappers.add(closed)
  globalThis.WebSocket = closed
}

beforeEach(() => {
  resetElectron()
  resetWebFrame()
  resetPage()
  resetStores()
  resetFactories()
  resetUpdateElectronApp()
})

afterEach(() => {
  // A test that fails between faking the clock and restoring it must not hand a frozen
  // one to its neighbour, which would then hang on its first real timeout.
  vi.useRealTimers()
  resetElectron()
  resetWebFrame()
  resetStores()
  resetUpdateElectronApp()
  delete (globalThis as Record<string, unknown>).statusky

  // Last, so a failure here never skips the resets above.
  expect(network.refused.splice(0), 'requests this test tried to send off the machine').toEqual([])
})
