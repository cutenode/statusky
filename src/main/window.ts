import { join } from 'node:path'
import { BrowserWindow, app, screen, shell } from 'electron'
import { computePopoverPosition, type Rect } from './position'
import { APP_INDEX, APP_ORIGIN } from './protocol'

const WIDTH = 440
const HEIGHT = 640

export class PopoverWindow {
  private window: BrowserWindow | null = null
  /** Set while a modal-ish interaction is open so a blur does not hide the popover. */
  private pinned = false
  /** Run against every window this creates, so IPC handlers survive a reopen. */
  private readonly onCreated: ((window: BrowserWindow) => void)[] = []

  /**
   * Register `fn` to run for the popover's window, now and after every recreation.
   * A menu bar app outlives its window: closing it destroys the WebContents that the
   * IPC handlers were registered against, so they have to be put back on the new one.
   */
  onCreate(fn: (window: BrowserWindow) => void): void {
    this.onCreated.push(fn)
    if (this.window && !this.window.isDestroyed()) fn(this.window)
  }

  create(): BrowserWindow {
    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      minWidth: 380,
      minHeight: 420,
      show: false,
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Rounded corners come from the renderer; a transparent frame lets them show.
      transparent: process.platform === 'darwin',
      vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
      visualEffectState: 'active',
      backgroundColor: process.platform === 'darwin' ? '#00000000' : '#0b0d12',
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: -100, y: -100 },
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })

    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    // Anything the page tries to open goes to the user's real browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    // The popover is a single page: it never navigates itself. Anything that tries is
    // either a link the user clicked or a page trying to move somewhere it should not
    // be trusted from, and either way it belongs in the real browser.
    window.webContents.on('will-navigate', (event, url) => {
      if (url === window.webContents.getURL()) return
      event.preventDefault()
      if (url.startsWith(APP_ORIGIN)) return
      void shell.openExternal(url)
    })

    if (!app.isPackaged) {
      // Renderer errors are invisible from the terminal otherwise, which makes
      // a blank popover very hard to diagnose.
      window.webContents.on('console-message', (event) => {
        if (event.level === 'error' || event.level === 'warning') {
          console.log(
            `[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`
          )
        }
      })
      window.webContents.on('render-process-gone', (_event, details) =>
        console.error('[renderer] process gone:', details)
      )
      window.webContents.on('preload-error', (_event, preloadPath, error) =>
        console.error('[preload] failed:', preloadPath, error)
      )
    }

    window.on('blur', () => {
      if (this.pinned || window.webContents.isDevToolsOpened()) return
      window.hide()
    })

    window.on('closed', () => {
      this.window = null
    })

    this.window = window
    // Handlers first: the page can call home the moment its preload runs.
    for (const fn of this.onCreated) fn(window)

    // `app://statusky` rather than `file://` so the IPC origin check has something
    // real to check. See src/main/protocol.ts.
    void window.loadURL(process.env.ELECTRON_RENDERER_URL ?? APP_INDEX)

    return window
  }

  get browserWindow(): BrowserWindow | null {
    return this.window
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned
  }

  isVisible(): boolean {
    return this.window?.isVisible() ?? false
  }

  show(trayBounds?: Rect): void {
    const window = this.window ?? this.create()
    this.position(window, trayBounds)
    window.show()
    window.focus()
  }

  hide(): void {
    this.window?.hide()
  }

  toggle(trayBounds?: Rect): void {
    if (this.isVisible()) {
      this.hide()
    } else {
      this.show(trayBounds)
    }
  }

  private position(window: BrowserWindow, trayBounds?: Rect): void {
    const bounds = window.getBounds()
    const anchor =
      trayBounds && trayBounds.width > 0
        ? trayBounds
        : { ...screen.getPrimaryDisplay().workArea, height: 0, width: 0 }

    const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y })
    const { x, y } = computePopoverPosition({
      tray: anchor,
      workArea: display.workArea,
      window: { width: bounds.width, height: bounds.height }
    })
    window.setPosition(x, y, false)
  }
}
