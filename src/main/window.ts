import { join } from 'node:path'
import { BrowserWindow, app, dialog, screen } from 'electron'
import { openInBrowser } from './external'
import { computePopoverPosition, type Rect } from './position'
import { APP_INDEX, APP_ORIGIN } from './protocol'

/**
 * Where electron-vite's dev server is serving the popover from, or null when the popover
 * should load its own build over `app://statusky`.
 *
 * Never anything but null in a packaged build, whatever the environment says. The
 * variable is how `npm run dev` points the window at the dev server, and nothing about it
 * stops it reaching a shipped app as well: anything that can set an environment variable
 * for the process could otherwise put a page of its choosing in a frameless, always-on-top
 * window that appears on every workspace and looks exactly like Statusky. The IPC origin
 * check would still refuse that page everything, but it would not need IPC to ask the
 * user for a password. src/main/index.ts asks the same question before it decides whether
 * to serve the built renderer at all.
 */
export function devServerUrl(): string | null {
  if (app.isPackaged) return null
  return process.env.ELECTRON_RENDERER_URL || null
}

const WIDTH = 440
const HEIGHT = 640

/**
 * How soon after a window is built a dead renderer counts as having died *on load*.
 *
 * The distinction is the whole of the crash guard: a page that dies after ten minutes
 * of use hit something the user did, and rebuilding it is exactly right. A page that
 * dies two seconds in will die two seconds into the next one as well, and the next.
 */
const CRASH_ON_LOAD_MS = 10_000

/** How many deaths on load in a row before the popover stops rebuilding itself. */
const CRASH_LIMIT = 3

const CRASH_GIVEN_UP =
  'The popover’s window has failed to start three times in a row, so Statusky has ' +
  'stopped rebuilding it — another attempt would only produce another crash. The menu ' +
  'bar icon still works: its right-click menu can refresh the feed, show the network ' +
  'checks, mark everything read and quit. Quitting Statusky and opening it again is ' +
  'what clears this.'

export class PopoverWindow {
  private window: BrowserWindow | null = null
  /** Set while a modal-ish interaction is open so a blur does not hide the popover. */
  private pinned = false
  /** Run against every window this creates, so IPC handlers survive a reopen. */
  private readonly onCreated: ((window: BrowserWindow) => void)[] = []
  /** When the current window was built, to tell a crash on load from a crash in use. */
  private createdAt = 0
  /** Consecutive renderer deaths that happened while the page was still loading. */
  private crashesOnLoad = 0
  /** Set once the popover has stopped rebuilding itself. Only a relaunch clears it. */
  private givenUp = false
  /** The warning currently on screen, so repeated clicks do not stack dialogs. */
  private warning: Promise<unknown> | null = null

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
      // Windows 11's answer to macOS vibrancy. A popover that hangs off the taskbar
      // should be made of the same material as the menus around it, and on 11 that
      // material is acrylic; without this the window is a flat dark rectangle against
      // whatever it happens to be covering. `backgroundMaterial` is win32-only, and on
      // Windows 10 it does nothing at all — which is why the opaque colour below is not
      // conditional on it, and has to stay right on its own.
      backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,
      visualEffectState: 'active',
      // Only macOS gets a transparent frame, so everywhere else this is the window: on
      // Windows 10 it is all of it, and on Windows 11 it is what acrylic tints.
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

    // Anything the page tries to open goes to the user's real browser — if it is a web
    // page at all. A middle click the page does not catch (RichText.svelte does) lands
    // here without passing through any click handler, carrying whatever scheme the
    // link's href says; `openInBrowser` is the check.
    window.webContents.setWindowOpenHandler(({ url }) => {
      void openInBrowser(url)
      return { action: 'deny' }
    })
    // The popover is a single page: it never navigates itself. Anything that tries is
    // either a link the user clicked or a page trying to move somewhere it should not
    // be trusted from, so it is always cancelled, and only ever reaches the real browser
    // through the same check as a popup does. The page it is already on is the one
    // exception, because that is a reload rather than a navigation away.
    // The URL is read off the event rather than the deprecated positional argument.
    window.webContents.on('will-navigate', (event) => {
      const { url } = event
      if (url === window.webContents.getURL()) return
      event.preventDefault()
      if (url.startsWith(APP_ORIGIN)) return
      void openInBrowser(url)
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
    }

    // Not a development-only diagnostic. A renderer that dies takes the page with it
    // and leaves the window behind: on macOS that is a transparent, vibrant, empty
    // rectangle that reappears every time the tray is clicked, with no way out short
    // of quitting — and nobody quits a menu bar app for months. Tearing it down here
    // is what lets the next `show()` build a working one, which is safe because
    // `onCreate` re-attaches every IPC dispatcher to whatever window it builds.
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer] process gone:', details)
      this.recover(window)
    })

    // Reported but never recovered from, which is the opposite of the case above. A
    // failed preload leaves the page itself running, so there is no blank rectangle to
    // clear — and the preload would fail identically in a new window, so rebuilding
    // would trade a popover that cannot reach the main process for a crash loop.
    window.webContents.on('preload-error', (_event, preloadPath, error) =>
      console.error('[preload] failed:', preloadPath, error)
    )

    window.on('blur', () => {
      if (this.pinned || window.webContents.isDevToolsOpened()) return
      window.hide()
    })

    window.on('closed', () => {
      this.window = null
    })

    this.window = window
    this.createdAt = Date.now()
    // Handlers first: the page can call home the moment its preload runs.
    for (const fn of this.onCreated) fn(window)

    // `app://statusky` rather than `file://` so the IPC origin check has something
    // real to check. See src/main/protocol.ts.
    void window.loadURL(devServerUrl() ?? APP_INDEX)

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
    // Nothing to build: the last three attempts died on load, and a fourth would die
    // the same way. Say so again instead, because a click that does nothing at all
    // reads as the app being broken in a way that has no explanation.
    if (this.givenUp) {
      this.warn()
      return
    }

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

  /**
   * Put an already-open popover back where it belongs on the current displays.
   *
   * `show()` positions the popover and nothing positions it again, which is right
   * until the displays move underneath it: undocking a laptop or unplugging a
   * projector can leave an open popover on coordinates no display covers any more,
   * where it cannot be reached — or even blurred away, since it cannot be clicked.
   * A hidden popover needs none of this; `show()` will place it. See
   * `followDisplayChanges`.
   */
  reposition(trayBounds?: Rect): void {
    const window = this.window
    if (!window || window.isDestroyed() || !window.isVisible()) return
    this.position(window, trayBounds)
  }

  /**
   * Take the window down after its renderer died, and decide whether to keep trying.
   *
   * The window is destroyed rather than reloaded because a destroyed one is the only
   * state `show()` can recover from cleanly — it rebuilds from scratch, handlers and
   * all — and because leaving it up is the blank-rectangle failure this exists to
   * prevent. Rebuilding is left to the next `show()` on purpose: doing it here would
   * be the crash loop, spawning a renderer into the same failure as fast as the OS
   * can report it.
   *
   * A single crash says nothing to the user, deliberately. What they see is a popover
   * that vanished and then opened again working on the next click, which is both the
   * truth and the best outcome available; a banner explaining it would only make a
   * recovery look like a fault. Only the page that will not start at all is worth
   * interrupting them for, and that is what `CRASH_LIMIT` is counting towards.
   */
  private recover(window: BrowserWindow): void {
    const onLoad = Date.now() - this.createdAt < CRASH_ON_LOAD_MS
    this.crashesOnLoad = onLoad ? this.crashesOnLoad + 1 : 0

    // Electron can report the death of a page whose window is already gone — a
    // crashed renderer inside a window the user just closed — and `destroy()` is not
    // a question to ask a window twice.
    if (!window.isDestroyed()) window.destroy()

    if (this.crashesOnLoad < CRASH_LIMIT) return
    this.givenUp = true
    this.warn()
  }

  /**
   * Tell the user the popover has stopped coming back, and what still works.
   *
   * One dialog at a time: the tray icon toggles the popover, so somebody watching
   * nothing happen will click it again, and a stack of identical modal message boxes
   * is its own kind of broken.
   */
  private warn(): void {
    if (this.warning) return
    this.warning = dialog
      .showMessageBox({
        type: 'error',
        title: 'Statusky',
        message: 'Statusky’s popover keeps crashing',
        detail: CRASH_GIVEN_UP
      })
      .finally(() => {
        this.warning = null
      })
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

/**
 * Keep an open popover on screen while the display arrangement changes underneath it.
 *
 * `PopoverWindow.position` runs on `show()`, which is the only moment it needs to run
 * while the displays stay put. They do not always: a laptop is undocked, a projector
 * is unplugged, a display's resolution or scale factor changes, and the work area the
 * popover was placed against stops existing. `anchor` is read at the moment of the
 * change rather than captured, because the tray icon moves with the menu bar it is in
 * — it is the same call `show()` makes, and it has to give the same answer as the
 * arrangement it is being asked about.
 */
export function followDisplayChanges(popover: PopoverWindow, anchor: () => Rect | undefined): void {
  const reposition = (): void => popover.reposition(anchor())

  screen.on('display-metrics-changed', reposition)
  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
}
