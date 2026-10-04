/**
 * The closed network from src/test/setup.ts, which every other test relies on without
 * ever seeing: if it quietly let requests through, nothing else in the suite would say so.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'

/** The record setup.ts keeps, read the same way it is written: off `globalThis`. */
function refused(): string[] {
  const network = (globalThis as Record<symbol, { refused: string[] } | undefined>)[
    Symbol.for('statusky.test.closed-network')
  ]
  if (!network) throw new Error('src/test/setup.ts did not close the network')
  return network.refused
}

/**
 * Take the record of what this test was refused, emptied, so that `afterEach` — which
 * fails any test that tried to leave the machine — lets these ones through.
 */
function takeRefused(): string[] {
  return refused().splice(0)
}

describe('the closed network', () => {
  it('refuses a fetch that would leave the machine, and remembers it', async () => {
    await expect(fetch('https://public.api.bsky.app/xrpc/_health')).rejects.toThrow(
      'The test suite does not reach the network'
    )
    await expect(fetch(new Request('https://bsky.network/xrpc/_health'))).rejects.toThrow(
      'does not reach the network'
    )

    expect(takeRefused()).toEqual([
      'fetch https://public.api.bsky.app/xrpc/_health',
      'fetch https://bsky.network/xrpc/_health'
    ])
  })

  it('refuses a WebSocket that would leave the machine, and remembers it', () => {
    expect(() => new WebSocket('wss://jetstream1.us-east.bsky.network/subscribe')).toThrow(
      'does not reach the network'
    )

    expect(takeRefused()).toEqual(['WebSocket wss://jetstream1.us-east.bsky.network/subscribe'])
  })

  it('lets loopback through, because the webhook receiver is tested on a real socket', async () => {
    const server = createServer((_request, response) => response.end('here'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${port}/`)

      expect(await response.text()).toBe('here')
      expect(refused()).toEqual([])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('leaves alone what was never the network', async () => {
    const response = await fetch('data:text/plain,local')

    expect(await response.text()).toBe('local')
    expect(refused()).toEqual([])
  })
})
