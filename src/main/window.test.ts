import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow, app, dialog, openedExternally, screen } from '../test/electron'
import { flush, withPlatform } from '../test/harness'
import { followDisplayChanges, PopoverWindow } from './window'

const TRAY_BOUNDS = { x: 900, y: 0, width: 24, height: 24 }

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL
  vi.restoreAllMocks()
})

function popoverWithWindow(): { popover: PopoverWindow; window: BrowserWindow } {
  const popover = new PopoverWindow()
  popover.create()
  return { popover, window: BrowserWindow.instances.at(-1)! }
}

/** Kill the renderer of whatever window the popover is holding, the way Electron reports it. */
function killRenderer(reason = 'crashed'): void {
  BrowserWindow.instances.at(-1)!.webContents.emit('render-process-gone', {}, { reason })
}

/** A second display, to the right of the built-in one. */
const PROJECTOR = {
  id: 2,
  bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1440, y: 0, width: 1920, height: 1050 },
  scaleFactor: 1
}

describe('create', () => {
  it('builds a frameless, always-on-top popover that stays off the taskbar', () => {
    const { window } = popoverWithWindow()

    expect(window.options).toMatchObject({
      width: 440,
      height: 640,
      show: false,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      maximizable: false,
      fullscreenable: false
    })
  })

  it('sandboxes the renderer and isolates its context', () => {
    const { window } = popoverWithWindow()
    const prefs = window.options.webPreferences as Record<string, unknown>

    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(String(prefs.preload)).toMatch(/preload[/\\]index\.cjs$/)
  })

  it('uses a transparent vibrant chrome on macOS only', async () => {
    await withPlatform('darwin', () => {
      const { window } = popoverWithWindow()
      expect(window.options.transparent).toBe(true)
      expect(window.options.vibrancy).toBe('under-window')
      expect(window.options.backgroundMaterial).toBeUndefined()
      expect(window.options.backgroundColor).toBe('#00000000')
    })

    BrowserWindow.instances.length = 0

    await withPlatform('win32', () => {
      const { window } = popoverWithWindow()
      expect(window.options.transparent).toBe(false)
      expect(window.options.vibrancy).toBeUndefined()
      expect(window.options.backgroundColor).toBe('#0b0d12')
    })
  })

  /**
   * Item 21. A popover hanging off the taskbar should be made of the same material as
   * the menus around it, and on Windows 11 that material is acrylic — macOS vibrancy's
   * opposite number. `backgroundMaterial` is win32-only and does nothing on Windows 10,
   * which is why the opaque colour stays put underneath it rather than being made
   * conditional: on 10 it is the whole window, and on 11 it is what acrylic tints.
   */
  it('asks for acrylic on Windows, and keeps the opaque fallback underneath', async () => {
    await withPlatform('win32', () => {
      const { window } = popoverWithWindow()
      expect(window.options.backgroundMaterial).toBe('acrylic')
      expect(window.options.backgroundColor).toBe('#0b0d12')
    })

    BrowserWindow.instances.length = 0

    // Anything that supports neither gets the solid colour and nothing else.
    await withPlatform('linux', () => {
      const { window } = popoverWithWindow()
      expect(window.options.backgroundMaterial).toBeUndefined()
      expect(window.options.vibrancy).toBeUndefined()
      expect(window.options.backgroundColor).toBe('#0b0d12')
    })
  })

  it('shows on every workspace, including over a fullscreen app', () => {
    const { window } = popoverWithWindow()
    expect(window.visibleOnAllWorkspaces).toBe(true)
  })

  it('loads the dev server URL when one is set', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    const { window } = popoverWithWindow()
    expect(window.loaded).toEqual([{ url: 'http://localhost:5173' }])
  })

  // Not file://, which every local page shares: the IPC origin check needs an origin
  // only the popover can be on. See src/main/protocol.ts.
  it('loads the packaged renderer over app://statusky otherwise', () => {
    const { window } = popoverWithWindow()
    expect(window.loaded).toEqual([{ url: 'app://statusky/index.html' }])
  })
})

describe('navigation containment', () => {
  it('sends window.open targets to the real browser and denies the popup', () => {
    const { window } = popoverWithWindow()

    const result = window.webContents.windowOpenHandler?.({ url: 'https://bsky.app/x' })

    expect(result).toEqual({ action: 'deny' })
    expect(openedExternally).toEqual(['https://bsky.app/x'])
  })

  // Blocked, but kept in-app: a route inside the popover's own origin is not an
  // outbound link and must not be handed to the OS.
  it('never hands an app:// URL to the browser', () => {
    const { window } = popoverWithWindow()
    const event = { preventDefault: vi.fn() }

    window.webContents.emit('will-navigate', event, 'app://statusky/settings.html')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(openedExternally).toEqual([])
  })

  it('blocks in-place navigation away from the app', () => {
    const { window } = popoverWithWindow()
    const event = { preventDefault: vi.fn() }

    window.webContents.emit('will-navigate', event, 'https://evil.test/')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(openedExternally).toEqual(['https://evil.test/'])
  })

  it('allows a reload of the page it is already on', () => {
    const { window } = popoverWithWindow()
    window.webContents.url = 'http://localhost:5173/'
    const event = { preventDefault: vi.fn() }

    window.webContents.emit('will-navigate', event, 'http://localhost:5173/')

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(openedExternally).toEqual([])
  })
})

describe('developer diagnostics', () => {
  it('mirrors the renderer’s console to the terminal in development', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { window } = popoverWithWindow()

    window.webContents.emit('console-message', {
      level: 'error',
      message: 'boom',
      sourceId: 'app.js',
      lineNumber: 12
    })
    window.webContents.emit('console-message', { level: 'info', message: 'quiet' })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain('[renderer:error] boom (app.js:12)')
  })

  it('stays silent in a packaged build', () => {
    app.isPackaged = true
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { window } = popoverWithWindow()

    window.webContents.emit('console-message', { level: 'error', message: 'boom' })

    expect(log).not.toHaveBeenCalled()
  })
})

describe('surviving a dead renderer', () => {
  /** Every test here kills a renderer, which is reported on the terminal. */
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  // The failure this exists to prevent: in a packaged build the window used to be
  // left behind as a transparent, empty rectangle that came back on every tray click.
  it('destroys the window in a packaged build, not just in development', () => {
    app.isPackaged = true
    const { popover, window } = popoverWithWindow()

    killRenderer()

    expect(window.isDestroyed()).toBe(true)
    expect(popover.browserWindow).toBeNull()
    expect(error).toHaveBeenCalledWith('[renderer] process gone:', { reason: 'crashed' })
  })

  it('builds a working replacement on the next show, handlers and all', () => {
    app.isPackaged = true
    const popover = new PopoverWindow()
    const attach = vi.fn()
    popover.onCreate(attach)
    popover.create()

    killRenderer()
    popover.show()

    expect(BrowserWindow.instances).toHaveLength(2)
    expect(popover.isVisible()).toBe(true)
    // `onCreate` re-runs against the new window: this is why destroying is safe.
    expect(attach).toHaveBeenCalledTimes(2)
    expect(attach).toHaveBeenLastCalledWith(BrowserWindow.instances.at(-1))
  })

  // Electron can report a page that died inside a window that is already gone, and
  // `destroy()` is not a question to ask a window twice.
  it('does not tear down a window that is already destroyed', () => {
    const { window } = popoverWithWindow()
    const closed = vi.fn()
    window.on('closed', closed)

    killRenderer()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(closed).toHaveBeenCalledTimes(1)
  })

  // A preload failure leaves the page running, and a new window would load the same
  // broken preload — so it is reported and nothing is torn down.
  it('reports a failed preload without destroying anything', () => {
    app.isPackaged = true
    const { window } = popoverWithWindow()

    window.webContents.emit('preload-error', {}, '/preload.cjs', new Error('nope'))

    expect(error).toHaveBeenCalledWith('[preload] failed:', '/preload.cjs', expect.any(Error))
    expect(window.isDestroyed()).toBe(false)
  })

  it('keeps rebuilding for as long as the page dies during use', async () => {
    vi.useFakeTimers()
    try {
      const { popover } = popoverWithWindow()

      // Four deaths, each after the page had been up for a quarter of an hour.
      for (let attempt = 0; attempt < 4; attempt++) {
        vi.advanceTimersByTime(15 * 60_000)
        killRenderer()
        popover.show()
      }

      expect(BrowserWindow.instances).toHaveLength(5)
      expect(popover.isVisible()).toBe(true)
      expect(dialog.showMessageBox).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // Three *in a row*: a page that ran for a while in between proves the renderer can
  // start, so the deaths before it say nothing about the ones after it.
  it('starts counting again after a page that ran for a while', () => {
    vi.useFakeTimers()
    try {
      const { popover } = popoverWithWindow()

      killRenderer()
      popover.show()
      killRenderer()
      popover.show()
      vi.advanceTimersByTime(15 * 60_000)
      killRenderer()
      popover.show()
      killRenderer()
      popover.show()
      killRenderer()
      popover.show()

      expect(BrowserWindow.instances).toHaveLength(6)
      expect(popover.isVisible()).toBe(true)
      expect(dialog.showMessageBox).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops rebuilding after three deaths on load, and explains itself once', async () => {
    const { popover } = popoverWithWindow()

    killRenderer()
    popover.show()
    killRenderer()
    popover.show()
    killRenderer()

    // No fourth window: another attempt would only produce another crash.
    popover.show()
    expect(BrowserWindow.instances).toHaveLength(3)
    expect(popover.isVisible()).toBe(false)

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'Statusky’s popover keeps crashing',
        detail: expect.stringContaining('menu bar icon still works')
      })
    )
    await flush()
  })

  // The tray icon toggles the popover, so somebody watching nothing happen clicks
  // again — and a stack of identical modal message boxes is its own kind of broken.
  it('never stacks the warning, but does repeat it once it has been dismissed', async () => {
    const { popover } = popoverWithWindow()

    killRenderer()
    popover.show()
    killRenderer()
    popover.show()
    killRenderer()

    popover.show()
    popover.show()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)

    await flush()
    popover.show()

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
    await flush()
  })
})

describe('following the displays', () => {
  it('brings an open popover back onto a display that still exists', () => {
    screen.displays.push({ ...PROJECTOR })
    const { popover, window } = popoverWithWindow()
    let tray = { x: 2000, y: 0, width: 24, height: 24 }
    followDisplayChanges(popover, () => tray)

    popover.show(tray)
    expect(window.getPosition()[0]).toBeGreaterThanOrEqual(1440)

    // The projector is unplugged, and the menu bar — and the icon in it — move back.
    screen.displays.pop()
    tray = TRAY_BOUNDS
    screen.emit('display-removed', {}, { id: 2 })

    expect(window.getPosition()[0]).toBe(Math.round(900 + 12 - 440 / 2))
  })

  it('follows a work area that changes under an open popover', () => {
    const { popover, window } = popoverWithWindow()
    followDisplayChanges(popover, () => TRAY_BOUNDS)
    popover.show(TRAY_BOUNDS)

    // A menu bar that grew, or a dock that moved to the top.
    screen.displays[0]!.workArea = { x: 0, y: 120, width: 1440, height: 780 }
    screen.emit('display-metrics-changed', {}, screen.displays[0], ['workArea'])

    expect(window.getPosition()[1]).toBe(128)
  })

  it('places the popover on a display that has just appeared', () => {
    const { popover, window } = popoverWithWindow()
    let tray = TRAY_BOUNDS
    followDisplayChanges(popover, () => tray)
    popover.show(tray)

    screen.displays.push({ ...PROJECTOR })
    tray = { x: 2000, y: 0, width: 24, height: 24 }
    screen.emit('display-added', {}, PROJECTOR)

    expect(window.getPosition()[0]).toBeGreaterThanOrEqual(1440)
  })

  // A hidden popover is positioned by `show()`, which runs against the arrangement as
  // it is then. Moving it now would only be guesswork about where it will be opened.
  it('leaves a hidden popover where it is', () => {
    const { popover, window } = popoverWithWindow()
    followDisplayChanges(popover, () => TRAY_BOUNDS)

    screen.emit('display-metrics-changed', {}, screen.displays[0], ['bounds'])

    expect(window.getPosition()).toEqual([0, 0])
  })

  it('shrugs off a change that arrives with no window, or a destroyed one', () => {
    const popover = new PopoverWindow()
    followDisplayChanges(popover, () => undefined)

    expect(() => screen.emit('display-removed', {}, PROJECTOR)).not.toThrow()

    popover.create()
    const window = BrowserWindow.instances.at(-1)!
    window.show()
    window.destroyed = true
    // Electron throws from every method of a destroyed window bar `isDestroyed`, which
    // the double does not model; without this, nothing here could fail.
    vi.spyOn(window, 'isVisible').mockImplementation(() => {
      throw new TypeError('Object has been destroyed')
    })

    expect(() => screen.emit('display-removed', {}, PROJECTOR)).not.toThrow()
  })
})

describe('show, hide and toggle', () => {
  it('shows and focuses the popover', () => {
    const { popover, window } = popoverWithWindow()
    popover.show(TRAY_BOUNDS)

    expect(popover.isVisible()).toBe(true)
    expect(window.focused).toBe(true)
  })

  it('recreates the window if it was closed', () => {
    const { popover, window } = popoverWithWindow()
    window.close()

    popover.show(TRAY_BOUNDS)

    expect(BrowserWindow.instances).toHaveLength(2)
    expect(popover.isVisible()).toBe(true)
  })

  it('reports not visible before it has been created', () => {
    expect(new PopoverWindow().isVisible()).toBe(false)
  })

  it('hides without error when there is no window', () => {
    expect(() => new PopoverWindow().hide()).not.toThrow()
  })

  it('toggles between shown and hidden', () => {
    const { popover } = popoverWithWindow()

    popover.toggle(TRAY_BOUNDS)
    expect(popover.isVisible()).toBe(true)

    popover.toggle(TRAY_BOUNDS)
    expect(popover.isVisible()).toBe(false)
  })

  it('exposes the underlying BrowserWindow, and forgets it once closed', () => {
    const { popover, window } = popoverWithWindow()
    expect(popover.browserWindow).not.toBeNull()

    window.close()

    expect(popover.browserWindow).toBeNull()
  })
})

describe('blur behaviour', () => {
  it('hides when it loses focus', () => {
    const { popover, window } = popoverWithWindow()
    popover.show(TRAY_BOUNDS)

    window.blur()

    expect(popover.isVisible()).toBe(false)
  })

  it('stays open while pinned', () => {
    const { popover, window } = popoverWithWindow()
    popover.show(TRAY_BOUNDS)
    popover.setPinned(true)

    window.blur()

    expect(popover.isVisible()).toBe(true)
  })

  it('stays open while devtools are attached', () => {
    const { popover, window } = popoverWithWindow()
    popover.show(TRAY_BOUNDS)
    window.webContents.openDevTools()

    window.blur()

    expect(popover.isVisible()).toBe(true)
  })

  it('hides again once unpinned', () => {
    const { popover, window } = popoverWithWindow()
    popover.show(TRAY_BOUNDS)
    popover.setPinned(true)
    popover.setPinned(false)

    window.blur()

    expect(popover.isVisible()).toBe(false)
  })
})

describe('positioning', () => {
  it('centres the popover under the tray icon', () => {
    const { popover, window } = popoverWithWindow()
    popover.show(TRAY_BOUNDS)

    const [x, y] = window.getPosition()
    expect(x).toBe(Math.round(900 + 12 - 440 / 2))
    // Below the icon, but never above the top of the work area plus the margin.
    expect(y).toBe(screen.getPrimaryDisplay().workArea.y + 8)
  })

  it('clamps to the work area when the icon is near the edge', () => {
    const { popover, window } = popoverWithWindow()
    popover.show({ x: 1430, y: 0, width: 24, height: 24 })

    const [x] = window.getPosition()
    expect(x).toBe(1440 - 440 - 8)
  })

  it('falls back to the primary display when there are no tray bounds', () => {
    const { popover, window } = popoverWithWindow()
    popover.show()

    const [, y] = window.getPosition()
    expect(y).toBe(screen.getPrimaryDisplay().workArea.y + 8)
  })

  it('follows the tray icon onto a second display', () => {
    screen.displays.push({
      id: 2,
      bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1440, y: 0, width: 1920, height: 1050 },
      scaleFactor: 1
    })
    const { popover, window } = popoverWithWindow()

    popover.show({ x: 2000, y: 0, width: 24, height: 24 })

    const [x] = window.getPosition()
    expect(x).toBeGreaterThanOrEqual(1440)
  })

  it('flips above the icon when the tray sits at the bottom of the screen', () => {
    const { popover, window } = popoverWithWindow()
    popover.show({ x: 700, y: 870, width: 24, height: 24 })

    // Its whole height plus the 6px gap above the icon, rather than merely somewhere
    // higher up the screen.
    const [, y] = window.getPosition()
    expect(y).toBe(870 - 640 - 6)
  })

  it('positions the window it creates when shown without one', () => {
    const popover = new PopoverWindow()
    popover.show(TRAY_BOUNDS)

    const [x, y] = BrowserWindow.instances.at(-1)!.getPosition()
    expect(x).toBe(Math.round(900 + 12 - 440 / 2))
    expect(y).toBe(screen.getPrimaryDisplay().workArea.y + 8)
  })
})

describe('onCreate', () => {
  it('runs against the window that already exists', () => {
    const { popover, window } = popoverWithWindow()
    const attach = vi.fn()

    popover.onCreate(attach)

    expect(attach).toHaveBeenCalledWith(window)
  })

  it('runs again for every window the popover creates afterwards', () => {
    const popover = new PopoverWindow()
    const attach = vi.fn()
    popover.onCreate(attach)

    popover.create()
    const first = BrowserWindow.instances.at(-1)!
    first.emit('closed')
    popover.show()

    expect(attach).toHaveBeenCalledTimes(2)
    expect(BrowserWindow.instances.at(-1)).not.toBe(first)
  })

  it('does not run for a window that has been destroyed', () => {
    const { popover, window } = popoverWithWindow()
    window.destroyed = true
    const attach = vi.fn()

    popover.onCreate(attach)

    expect(attach).not.toHaveBeenCalled()
  })

  it('attaches before the page is told to load', () => {
    const popover = new PopoverWindow()
    const loadsAtAttach: number[] = []
    popover.onCreate(() => {
      loadsAtAttach.push(BrowserWindow.instances.at(-1)!.loaded.length)
    })

    popover.create()

    // Nothing loaded yet: the handlers are in place before the renderer can call.
    expect(loadsAtAttach).toEqual([0])
  })
})
