import { describe, expect, it, vi } from 'vitest'
import type { StatuskyBridge } from '../shared/bridge'

import type * as ElectronDoubles from '../test/electron'
import type * as RendererDoubles from '../test/electron-renderer'

type Electron = typeof ElectronDoubles
type Renderer = typeof RendererDoubles

/**
 * The preload half of the development `PopoverOnly` validator.
 *
 * Like src/main/ipc.development.test.ts, this runs only in the `node-development`
 * project, against wiring generated with EIPC_ENV=development. The generated preload
 * checks its page once, at import time, and then exposes `window.statusky` or nothing.
 *
 * The preload cannot ask whether the app is packaged — the generator compiles that
 * condition to `true` on this side — so refusing a packaged build is main's job alone,
 * and is tested there.
 */

const INTERFACES = [
  'Accounts',
  'Actors',
  'Feed',
  'Host',
  'Network',
  'Popover',
  'Preferences',
  'State',
  'Webhook'
]

/** Load the preload script into a clean module registry, as a page served from `url`. */
async function loadPreload(
  url: string,
  page?: (renderer: Renderer) => void
): Promise<{ api: StatuskyBridge | undefined; electron: Electron }> {
  vi.resetModules()
  const electron = (await import('../test/electron')) as Electron
  const renderer = (await import('../test/electron-renderer')) as Renderer
  const { setPageUrl } = await import('../test/page')
  electron.resetElectron()
  renderer.resetWebFrame()
  setPageUrl(url)
  page?.(renderer)
  await import('./index')
  return { api: electron.exposed.get('statusky') as StatuskyBridge | undefined, electron }
}

describe('what the development preload exposes', () => {
  it.each([
    // `npm start`: the built renderer, over the packaged app's origin.
    'app://statusky/index.html',
    // `npm run dev`: electron-vite's dev server on loopback.
    'http://localhost:5173/',
    'http://127.0.0.1:5173/'
  ])('exposes the whole API to %s', async (url) => {
    const { api, electron } = await loadPreload(url)

    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(Object.keys(api ?? {}).toSorted()).toEqual(INTERFACES)
  })

  it.each([
    'file:///Users/someone/statusky/out/renderer/index.html',
    'https://status.example.test/',
    'https://localhost:5173/',
    'http://status.example.test:5173/'
  ])('exposes nothing to %s', async (url) => {
    const { api, electron } = await loadPreload(url)

    expect(api).toBeUndefined()
    expect(electron.contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
  })

  // An iframe inherits the popover's origin but must not inherit its reach.
  it('exposes nothing to a sub-frame on app://statusky', async () => {
    const { api, electron } = await loadPreload('app://statusky/index.html', (renderer) =>
      renderer.subFrame()
    )

    expect(api).toBeUndefined()
    expect(electron.contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
  })
})
