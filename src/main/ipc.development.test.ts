import { afterEach, describe, expect, it } from 'vitest'
import { FakeWebFrameMain } from '../test/electron'
import { BUILTIN_PROFILES, createHarness, seedFeed, type Harness } from '../test/harness'

/**
 * The development branch of the `PopoverOnly` origin validator, run for real.
 *
 * `npm test` generates production wiring into src/ipc, so src/main/ipc.test.ts only ever
 * meets the production branch. This file belongs to the `node-development` project
 * instead, where `@ipc` is wiring generated from the same schema with EIPC_ENV=development
 * — what `npm run dev` and `npm start` run (see src/test/development-wiring.ts). Calls
 * still go through the real preload, the real handlers and the generated validator; only
 * the branch compiled in differs.
 */

const BSKY = BUILTIN_PROFILES.bsky
const REFUSED = /did not pass origin validation/

let harness: Harness | null = null

/** Running from source, the app is never packaged. */
async function boot(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness({ tray: false, packaged: false, ...options })
  return harness
}

/** The frame the popover's calls appear to come from, which is what gets validated. */
function frame(h: Harness): FakeWebFrameMain {
  const window = h.browserWindow()
  if (!window) throw new Error('This harness has no window.')
  return window.webContents.mainFrame
}

afterEach(() => {
  harness?.dispose()
  harness = null
})

describe('the development origin validator', () => {
  // `npm start` previews the built renderer over the packaged app's own origin, but from
  // an unpackaged build: exactly the case the production branch refuses.
  it('accepts the built popover over app://statusky from an unpackaged app', async () => {
    const h = await boot()
    expect(frame(h).url).toBe('app://statusky/index.html')

    await expect(h.api.State.get()).resolves.toMatchObject({ version: h.state().version })
  })

  // Development wiring has no business in a packaged build; even there it answers nothing.
  it('refuses the same origin once the app is packaged', async () => {
    const h = await boot({ packaged: true })
    expect(frame(h).url).toBe('app://statusky/index.html')

    await expect(h.api.State.get()).rejects.toThrow(REFUSED)
  })

  // `npm run dev`: the popover comes from electron-vite's dev server on loopback.
  it.each(['http://localhost:5173/', 'http://127.0.0.1:5173/'])(
    'accepts the dev server at %s',
    async (url) => {
      const h = await boot()
      frame(h).url = url

      await expect(h.api.State.get()).resolves.toMatchObject({ version: h.state().version })
    }
  )

  it.each([
    // Every local page shares file://'s one opaque origin.
    'file:///Users/someone/statusky/out/renderer/index.html',
    'https://status.example.test/',
    // The loopback allowance is for the dev server, which speaks plain http...
    'https://localhost:5173/',
    // ...and plain http is allowed on loopback only.
    'http://status.example.test:5173/'
  ])('refuses %s', async (url) => {
    const h = await boot()
    frame(h).url = url

    await expect(h.api.State.get()).rejects.toThrow(REFUSED)
  })

  // An iframe inherits the popover's origin but must not inherit its reach.
  it('refuses a sub-frame even on app://statusky', async () => {
    const h = await boot()
    const popover = frame(h)
    popover.parent = new FakeWebFrameMain(popover.webContents, popover.url)

    await expect(h.api.State.get()).rejects.toThrow(REFUSED)
  })

  it('lets a call on another interface through from the popover', async () => {
    const h = await boot()
    seedFeed(h.appview, BSKY, [{ text: 'All clear' }])

    await h.api.Feed.refresh()

    expect(h.state().posts).toHaveLength(1)
  })

  it('refuses that call from another origin before its handler runs', async () => {
    const h = await boot()
    seedFeed(h.appview, BSKY, [{ text: 'All clear' }])
    frame(h).url = 'https://status.example.test/'

    await expect(h.api.Feed.refresh()).rejects.toThrow(REFUSED)
    expect(h.state().posts).toEqual([])
  })
})
