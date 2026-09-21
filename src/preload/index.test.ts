import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatuskyBridge } from '../shared/bridge'
import type { Harness } from '../test/harness'

import type * as ElectronDoubles from '../test/electron'
import type * as RendererDoubles from '../test/electron-renderer'

type Electron = typeof ElectronDoubles
type Renderer = typeof RendererDoubles

/**
 * Load the preload script into a clean module registry.
 *
 * A fresh registry matters here more than usual: the generated preload runs its origin
 * check once, at import time, and only then decides whether to expose anything. Each
 * test therefore has to re-import it against the page identity it wants to try.
 */
async function loadPreload(
  page?: (renderer: Renderer) => void
): Promise<{ api: StatuskyBridge | undefined; electron: Electron }> {
  vi.resetModules()
  const electron = (await import('../test/electron')) as Electron
  const renderer = (await import('../test/electron-renderer')) as Renderer
  const { resetPage } = await import('../test/page')
  electron.resetElectron()
  renderer.resetWebFrame()
  resetPage()
  page?.(renderer)
  await import('./index')
  return { api: electron.exposed.get('statusky') as StatuskyBridge | undefined, electron }
}

let harness: Harness | null = null

afterEach(() => {
  harness?.dispose()
  harness = null
})

describe('the bridge', () => {
  it('exposes exactly one API, under `statusky`', async () => {
    const { electron } = await loadPreload()
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[0]).toBe('statusky')
  })

  it('exposes exactly the interfaces the schema declares', async () => {
    const { api } = await loadPreload()
    expect(Object.keys(api!).toSorted()).toEqual(
      [
        'Accounts',
        'Actors',
        'Feed',
        'Host',
        'Network',
        'Preferences',
        'State',
        'Webhook'
      ].toSorted()
    )
  })

  it('exposes exactly the methods each interface declares', async () => {
    const { api } = await loadPreload()
    expect(Object.keys(api!.State).toSorted()).toEqual(['get', 'onChanged'])
    expect(Object.keys(api!.Accounts).toSorted()).toEqual(['add', 'patch', 'remove'])
    expect(Object.keys(api!.Preferences).toSorted()).toEqual(['patch'])
    expect(Object.keys(api!.Feed).toSorted()).toEqual([
      'markAllRead',
      'markRead',
      'markReadThrough',
      'refresh'
    ])
    expect(Object.keys(api!.Actors).toSorted()).toEqual(['resolve'])
    expect(Object.keys(api!.Webhook).toSorted()).toEqual(['regenerateSecret'])
    expect(Object.keys(api!.Host).toSorted()).toEqual(
      [
        'copyText',
        'getPlatform',
        'hideWindow',
        'openExternal',
        'quit',
        'sendTestNotification'
      ].toSorted()
    )
  })

  it('offers no generic invoke escape hatch', async () => {
    const { api } = await loadPreload()
    const surface = api as unknown as Record<string, unknown>
    expect(surface.invoke).toBeUndefined()
    expect(surface.send).toBeUndefined()
    expect(surface.ipcRenderer).toBeUndefined()
  })
})

describe('what the preload will talk to', () => {
  it('exposes nothing to a page on another origin', async () => {
    vi.resetModules()
    const electron = (await import('../test/electron')) as Electron
    const { setPageUrl } = await import('../test/page')
    electron.resetElectron()
    setPageUrl('https://status.example.test/')

    await import('./index')

    expect(electron.contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
    expect(electron.exposed.get('statusky')).toBeUndefined()
  })

  it('exposes nothing to a file:// page', async () => {
    vi.resetModules()
    const electron = (await import('../test/electron')) as Electron
    const { setPageUrl } = await import('../test/page')
    electron.resetElectron()
    setPageUrl('file:///tmp/anything/index.html')

    await import('./index')

    expect(electron.exposed.get('statusky')).toBeUndefined()
  })

  // An iframe inherits the popover's origin but must not inherit its reach.
  it('exposes nothing to a sub-frame of the popover', async () => {
    const { api, electron } = await loadPreload((renderer) => renderer.subFrame())
    expect(api).toBeUndefined()
    expect(electron.contextBridge.exposeInMainWorld).not.toHaveBeenCalled()
  })
})

describe('state pushes', () => {
  it('delivers pushes, hands over only the state, and unsubscribes cleanly', async () => {
    vi.resetModules()
    const { createHarness } = await import('../test/harness')
    const { ipcRenderer } = (await import('../test/electron')) as Electron
    harness = await createHarness({ tray: false })

    const listener = vi.fn()
    const stop = harness.api.State.onChanged(listener)
    expect(ipcRenderer.totalListeners()).toBe(1)

    await harness.api.Feed.markAllRead()
    await harness.api.Accounts.patch(harness.state().accounts[0]!.did, { muted: true })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]).toHaveLength(1)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ version: harness.state().version })

    stop()
    expect(ipcRenderer.totalListeners()).toBe(0)
  })

  it('supports several independent subscribers', async () => {
    vi.resetModules()
    const { createHarness } = await import('../test/harness')
    harness = await createHarness({ tray: false })
    const first = vi.fn()
    const second = vi.fn()

    const stopFirst = harness.api.State.onChanged(first)
    harness.api.State.onChanged(second)
    stopFirst()

    await harness.api.Accounts.patch(harness.state().accounts[0]!.did, { muted: true })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('against the real main process', () => {
  it('round-trips a full user action through IPC and back as a push', async () => {
    vi.resetModules()
    const { createHarness } = await import('../test/harness')
    harness = await createHarness({ tray: false })

    const seen: unknown[] = []
    const stop = harness.api.State.onChanged((state) => seen.push(state))

    const settings = await harness.api.Preferences.patch({ theme: 'dark', pollIntervalSec: 900 })

    expect(settings).toMatchObject({ theme: 'dark', pollIntervalSec: 900 })
    expect(seen).toHaveLength(1)
    expect(harness.store.get('settings').theme).toBe('dark')
    stop()
  })

  it('surfaces a main-process failure as a rejection the renderer can read', async () => {
    vi.resetModules()
    const { createHarness } = await import('../test/harness')
    const { ipcErrorMessage } = await import('../shared/bridge')
    harness = await createHarness({ tray: false })

    const error = await harness.api.Accounts.add('nobody.invalid').catch((e: unknown) => e)

    expect(ipcErrorMessage(error)).toMatch(/Profile not found/)
    // The channel name carries a per-build random prefix; the user must never see it.
    expect(ipcErrorMessage(error)).not.toMatch(/eipc_message/)
  })
})
