import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow, app, openedExternally, screen } from '../test/electron'
import { withPlatform } from '../test/harness'
import { PopoverWindow } from './window'

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
  it('mirrors renderer errors to the terminal in development', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { window } = popoverWithWindow()

    window.webContents.emit('console-message', {
      level: 'error',
      message: 'boom',
      sourceId: 'app.js',
      lineNumber: 12
    })
    window.webContents.emit('console-message', { level: 'info', message: 'quiet' })
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    window.webContents.emit('preload-error', {}, '/preload.cjs', new Error('nope'))

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain('[renderer:error] boom (app.js:12)')
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('stays silent in a packaged build', () => {
    app.isPackaged = true
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { window } = popoverWithWindow()

    window.webContents.emit('console-message', { level: 'error', message: 'boom' })

    expect(log).not.toHaveBeenCalled()
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

    const [, y] = window.getPosition()
    expect(y).toBeLessThan(870)
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
