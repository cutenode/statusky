/**
 * An in-memory stand-in for the `electron` module.
 *
 * `vitest.config.ts` aliases `electron` to this file, so importing any main- or
 * preload-process module under test transparently gets these doubles instead of
 * Electron's real (native, un-loadable-outside-Electron) bindings.
 *
 * The doubles are deliberately behavioural rather than inert: `ipcRenderer` is
 * wired to `ipcMain`, `webContents.send` reaches `ipcRenderer.on` listeners, and
 * windows track their own visibility. That lets a test drive the preload API and
 * observe the real main-process consequences, instead of asserting on mock calls.
 */
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

// ---------------------------------------------------------------------- types

export interface FakeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FakeDisplay {
  id: number
  bounds: FakeRect
  workArea: FakeRect
  scaleFactor: number
}

export interface MenuItemTemplate {
  label?: string
  type?: string
  accelerator?: string
  enabled?: boolean
  click?: () => void
}

// ------------------------------------------------------------------------ app

class FakeApp extends EventEmitter {
  isPackaged = false
  /** Flip to false to exercise the "another copy is already running" path. */
  singleInstanceLock = true
  version = '0.1.0-test'
  name = 'statusky'
  userModelId: string | null = null
  loginItem = { openAtLogin: false, openAsHidden: false }
  /** Set to null to simulate a platform with no dock (Windows, Linux). */
  dock: { hide: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> } | null = {
    hide: vi.fn(),
    show: vi.fn()
  }
  /** Throw from `setLoginItemSettings`, the way an unbundled dev binary does. */
  loginItemThrows: Error | null = null

  readonly quit = vi.fn(() => {
    this.emit('quit')
  })
  readonly exit = vi.fn()
  readonly relaunch = vi.fn()
  readonly focus = vi.fn()
  readonly whenReady = vi.fn(async () => undefined)
  readonly requestSingleInstanceLock = vi.fn(() => this.singleInstanceLock)
  readonly setAppUserModelId = vi.fn((id: string) => {
    this.userModelId = id
  })
  readonly getVersion = vi.fn(() => this.version)
  readonly getName = vi.fn(() => this.name)
  readonly getPath = vi.fn((name: string) => `/tmp/statusky-test/${name}`)
  readonly getLoginItemSettings = vi.fn(() => ({ ...this.loginItem }))
  readonly setLoginItemSettings = vi.fn((settings: { openAtLogin?: boolean }) => {
    if (this.loginItemThrows) throw this.loginItemThrows
    this.loginItem = { ...this.loginItem, ...settings }
  })
}

export const app = new FakeApp()

// Electron sets this on `process`; several main-process modules read it when the app
// is packaged, and outside Electron it is simply absent. It is typed read-only because
// only Electron itself is meant to write it — which is the job this file is doing.
const host = process as { resourcesPath?: string }
host.resourcesPath ??= '/Applications/Statusky.app/Contents/Resources'

// ------------------------------------------------------------------------ ipc

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

class FakeIpcMain extends EventEmitter {
  readonly handlers = new Map<string, IpcHandler>()

  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      // Matches Electron, which refuses a second handler for one channel.
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, handler)
  }

  handleOnce(channel: string, handler: IpcHandler): void {
    this.handle(channel, (event, ...args) => {
      this.handlers.delete(channel)
      return handler(event, ...args)
    })
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
}

export const ipcMain = new FakeIpcMain()

/**
 * `webContents.ipc` / `webFrameMain.ipc`: an `ipcMain` scoped to one page.
 *
 * The generated IPC wiring registers everything here rather than globally, which is
 * what lets a handler know which frame it is answering — and therefore what lets the
 * origin validator do its job.
 */
export class FakeScopedIpc extends EventEmitter {
  readonly handlers = new Map<string, IpcHandler>()

  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
}

/** Fan-out for `webContents.send` -> `ipcRenderer.on`, so pushes reach the renderer. */
const rendererBus = new EventEmitter()
rendererBus.setMaxListeners(0)

/**
 * Which frame `ipcRenderer` is speaking as.
 *
 * Defaults to the newest live window's main frame, which is what the real app has.
 * Point `frame` somewhere else to make a call arrive from another origin or from a
 * sub-frame, and watch the origin validator refuse it.
 */
export const sender: { frame: FakeWebFrameMain | null } = { frame: null }

function senderFrame(): FakeWebFrameMain | null {
  if (sender.frame) return sender.frame
  const window = BrowserWindow.instances.findLast((w) => !w.destroyed)
  return window?.webContents.mainFrame ?? null
}

class FakeIpcRenderer extends EventEmitter {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const frame = senderFrame()
    const handler = frame?.webContents.ipc.handlers.get(channel) ?? ipcMain.handlers.get(channel)
    if (!handler) {
      throw new Error(`Error invoking remote method '${channel}': no handler registered`)
    }
    try {
      return await handler({ sender: frame?.webContents ?? null, senderFrame: frame }, ...args)
    } catch (error) {
      // Electron re-wraps handler failures on the way back across the boundary, and
      // the renderer has to unwrap them again; keep that shape so it is exercised.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Error invoking remote method '${channel}': Error: ${message}`, {
        cause: error
      })
    }
  }

  override on(channel: string, listener: (...args: unknown[]) => void): this {
    rendererBus.on(channel, listener)
    return this
  }

  override removeListener(channel: string, listener: (...args: unknown[]) => void): this {
    rendererBus.removeListener(channel, listener)
    return this
  }

  override removeAllListeners(channel?: string): this {
    if (channel) rendererBus.removeAllListeners(channel)
    else rendererBus.removeAllListeners()
    return this
  }

  send(channel: string, ...args: unknown[]): void {
    void ipcMain.handlers.get(channel)?.({ sender: null }, ...args)
  }

  /** Listener count on the renderer side, for leak assertions. */
  listenerCountFor(channel: string): number {
    return rendererBus.listenerCount(channel)
  }

  /**
   * Every renderer-side listener, across all channels. Generated channel names carry a
   * per-build random prefix, so a leak check has to count rather than name them.
   */
  totalListeners(): number {
    return rendererBus
      .eventNames()
      .reduce((total, name) => total + rendererBus.listenerCount(name), 0)
  }
}

export const ipcRenderer = new FakeIpcRenderer()

// --------------------------------------------------------------- contextBridge

/** Everything the preload script has exposed, keyed by the world name it used. */
export const exposed = new Map<string, unknown>()

/**
 * The same APIs, but never cleared by `resetElectron`. A preload script only runs
 * once per module registry, so something has to remember what it published after
 * the first test in a file has reset the doubles.
 */
export const published = new Map<string, unknown>()

export const contextBridge = {
  exposeInMainWorld: vi.fn((key: string, api: unknown) => {
    exposed.set(key, api)
    published.set(key, api)
    ;(globalThis as Record<string, unknown>)[key] = api
  }),
  exposeInIsolatedWorld: vi.fn((_worldId: number, key: string, api: unknown) => {
    exposed.set(key, api)
  })
}

// ---------------------------------------------------------------------- shell

export const shell = {
  openExternal: vi.fn(async (url: string) => {
    openedExternally.push(url)
  }),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
  beep: vi.fn()
}

/** Every URL handed to the OS, in order. */
export const openedExternally: string[] = []

// ------------------------------------------------------------------ clipboard

/** The system clipboard, as far as anything in a test can tell. */
export const clipboardContents = { text: '' }

export const clipboard = {
  writeText: vi.fn((text: string) => {
    clipboardContents.text = text
  }),
  readText: vi.fn(() => clipboardContents.text)
}

// ------------------------------------------------------------- protocol / net

export interface FakeScheme {
  scheme: string
  privileges?: Record<string, unknown>
}

/** Schemes `registerSchemesAsPrivileged` was told about, in order. */
export const privilegedSchemes: FakeScheme[] = []
/** Handlers installed by `protocol.handle`, keyed by scheme. */
export const protocolHandlers = new Map<string, (request: Request) => Promise<Response>>()

export const protocol = {
  registerSchemesAsPrivileged: vi.fn((schemes: FakeScheme[]) => {
    privilegedSchemes.push(...schemes)
  }),
  handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response>) => {
    protocolHandlers.set(scheme, handler)
  }),
  unhandle: vi.fn((scheme: string) => {
    protocolHandlers.delete(scheme)
  })
}

/**
 * Files `net.fetch` can see, keyed by absolute path. Nothing here touches the real
 * disk: a test seeds exactly the bundle it wants served, which is also the only way to
 * assert that a traversal attempt never got as far as a read.
 */
export const servedFiles = new Map<string, string>()

/**
 * `net.WebSocket`, as far as the firehose check uses it. There is no network behind the
 * doubles, so every connection fails the way an unreachable relay's would.
 */
export class FakeNetWebSocket extends EventTarget {
  static readonly instances: FakeNetWebSocket[] = []
  binaryType = 'blob'
  closed = false

  constructor(readonly url: string) {
    super()
    FakeNetWebSocket.instances.push(this)
    queueMicrotask(() => this.dispatchEvent(new Event('error')))
  }

  close(): void {
    this.closed = true
  }
}

export const net = {
  fetch: vi.fn(async (input: string) => {
    const path = input.startsWith('file://') ? fileURLToPath(input) : input
    const body = servedFiles.get(path)
    if (body === undefined) return new Response('Not found', { status: 404 })
    return new Response(body, { status: 200 })
  }),
  WebSocket: FakeNetWebSocket
}

// --------------------------------------------------------------- notifications

export interface FakeNotificationOptions {
  title?: string
  subtitle?: string
  body?: string
  silent?: boolean
  timeoutType?: string
}

export class Notification extends EventEmitter {
  static supported = true
  static isSupported = vi.fn(() => Notification.supported)
  /** When set, every notification is refused by the fake OS with this reason. */
  static failWith: string | null = null
  /** Model an OS that simply never answers, which is what the confirm timeout is for. */
  static neverAnswers = false

  shown = false
  closed = false

  constructor(readonly options: FakeNotificationOptions = {}) {
    super()
    notifications.push(this)
  }

  show(): void {
    this.shown = true
    if (Notification.neverAnswers) return
    // The real `show` is asynchronous: the OS answers on a later tick.
    queueMicrotask(() => {
      if (Notification.failWith === null) this.emit('show', {})
      else this.emit('failed', {}, Notification.failWith)
    })
  }

  close(): void {
    this.closed = true
  }

  /** Simulate the user clicking the notification banner. */
  click(): void {
    this.emit('click', {})
  }
}

/** Every notification constructed, in order. */
export const notifications: Notification[] = []

// ----------------------------------------------------------------- nativeImage

export class FakeNativeImage {
  isTemplate = false

  constructor(readonly path: string) {}

  setTemplateImage(value: boolean): void {
    this.isTemplate = value
  }

  isTemplateImage(): boolean {
    return this.isTemplate
  }

  isEmpty(): boolean {
    return false
  }

  resize(): FakeNativeImage {
    return this
  }
}

export const nativeImage = {
  createFromPath: vi.fn((path: string) => new FakeNativeImage(path)),
  createEmpty: vi.fn(() => new FakeNativeImage(''))
}

// ----------------------------------------------------------------------- menu

export class FakeMenu {
  constructor(readonly template: MenuItemTemplate[]) {}

  /** Find a menu entry by its label, so tests can assert on and invoke it. */
  item(label: string): MenuItemTemplate | undefined {
    return this.template.find((entry) => entry.label === label)
  }

  /** Click a menu entry by label. Throws if it is missing, so typos fail loudly. */
  click(label: string): void {
    const entry = this.item(label)
    if (!entry) throw new Error(`No menu item labelled ${JSON.stringify(label)}`)
    entry.click?.()
  }
}

export const Menu = {
  buildFromTemplate: vi.fn((template: MenuItemTemplate[]) => {
    const menu = new FakeMenu(template)
    menus.push(menu)
    return menu
  }),
  setApplicationMenu: vi.fn()
}

export const menus: FakeMenu[] = []

// ----------------------------------------------------------------------- tray

export class Tray extends EventEmitter {
  image: FakeNativeImage
  tooltip = ''
  title = ''
  destroyed = false
  ignoresDoubleClick = false
  bounds: FakeRect = { x: 900, y: 0, width: 24, height: 24 }
  readonly poppedUpMenus: FakeMenu[] = []

  constructor(image: FakeNativeImage) {
    super()
    this.image = image
    trays.push(this)
  }

  setImage(image: FakeNativeImage): void {
    this.image = image
  }

  setToolTip(tooltip: string): void {
    this.tooltip = tooltip
  }

  setTitle(title: string): void {
    this.title = title
  }

  setIgnoreDoubleClickEvents(value: boolean): void {
    this.ignoresDoubleClick = value
  }

  getBounds(): FakeRect {
    return { ...this.bounds }
  }

  popUpContextMenu(menu: FakeMenu): void {
    this.poppedUpMenus.push(menu)
  }

  destroy(): void {
    this.destroyed = true
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

export const trays: Tray[] = []

// --------------------------------------------------------------- browserWindow

/** `webFrameMain`: a single frame in a page, and the thing an origin check inspects. */
export class FakeWebFrameMain {
  readonly ipc = new FakeScopedIpc()
  /** `null` for the main frame; set it to pretend this is an iframe. */
  parent: FakeWebFrameMain | null = null

  constructor(
    readonly webContents: FakeWebContents,
    public url = ''
  ) {}

  send(channel: string, ...args: unknown[]): void {
    this.webContents.send(channel, ...args)
  }
}

class FakeWebContents extends EventEmitter {
  devToolsOpen = false
  url = ''
  windowOpenHandler: ((details: { url: string }) => unknown) | null = null
  /** Every `send` this window made: the renderer-facing push stream. */
  readonly sent: { channel: string; payload: unknown }[] = []
  /** Handlers registered against this page rather than globally. */
  readonly ipc = new FakeScopedIpc()
  readonly mainFrame: FakeWebFrameMain = new FakeWebFrameMain(this)

  send(channel: string, ...args: unknown[]): void {
    const payload = args.length > 1 ? args : args[0]
    this.sent.push({ channel, payload })
    rendererBus.emit(channel, { sender: this }, ...args)
  }

  setWindowOpenHandler(handler: (details: { url: string }) => unknown): void {
    this.windowOpenHandler = handler
  }

  getURL(): string {
    return this.url
  }

  isDevToolsOpened(): boolean {
    return this.devToolsOpen
  }

  openDevTools(): void {
    this.devToolsOpen = true
  }

  closeDevTools(): void {
    this.devToolsOpen = false
  }

  setZoomFactor(): void {}
}

export class BrowserWindow extends EventEmitter {
  static instances: BrowserWindow[] = []
  static getAllWindows = vi.fn(() => BrowserWindow.instances.filter((w) => !w.destroyed))

  readonly webContents = new FakeWebContents()
  readonly options: Record<string, unknown>
  readonly loaded: { url?: string; file?: string }[] = []
  visible = false
  focused = false
  destroyed = false
  alwaysOnTop: boolean
  visibleOnAllWorkspaces = false
  private bounds: FakeRect

  constructor(options: Record<string, unknown> = {}) {
    super()
    this.options = options
    this.alwaysOnTop = Boolean(options.alwaysOnTop)
    this.bounds = {
      x: 0,
      y: 0,
      width: Number(options.width ?? 800),
      height: Number(options.height ?? 600)
    }
    BrowserWindow.instances.push(this)
  }

  show(): void {
    this.visible = true
    this.emit('show')
  }

  hide(): void {
    this.visible = false
    this.emit('hide')
  }

  focus(): void {
    this.focused = true
    this.emit('focus')
  }

  /** Simulate the popover losing focus, which is what hides it in real use. */
  blur(): void {
    this.focused = false
    this.emit('blur')
  }

  close(): void {
    this.destroyed = true
    this.emit('closed')
  }

  destroy(): void {
    this.close()
  }

  isVisible(): boolean {
    return this.visible && !this.destroyed
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isFocused(): boolean {
    return this.focused
  }

  getBounds(): FakeRect {
    return { ...this.bounds }
  }

  setBounds(bounds: Partial<FakeRect>): void {
    this.bounds = { ...this.bounds, ...bounds }
  }

  getPosition(): [number, number] {
    return [this.bounds.x, this.bounds.y]
  }

  setPosition(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y }
  }

  setSize(width: number, height: number): void {
    this.bounds = { ...this.bounds, width, height }
  }

  setAlwaysOnTop(value: boolean): void {
    this.alwaysOnTop = value
  }

  setVisibleOnAllWorkspaces(value: boolean): void {
    this.visibleOnAllWorkspaces = value
  }

  async loadURL(url: string): Promise<void> {
    this.loaded.push({ url })
    this.webContents.url = url
    this.webContents.mainFrame.url = url
  }

  async loadFile(file: string): Promise<void> {
    this.loaded.push({ file })
    this.webContents.url = `file://${file}`
    this.webContents.mainFrame.url = this.webContents.url
  }
}

// --------------------------------------------------------------------- screen

const DEFAULT_DISPLAY: FakeDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
  scaleFactor: 2
}

class FakeScreen extends EventEmitter {
  displays: FakeDisplay[] = [structuredClone(DEFAULT_DISPLAY)]

  getPrimaryDisplay(): FakeDisplay {
    return this.displays[0]!
  }

  getAllDisplays(): FakeDisplay[] {
    return this.displays
  }

  /** Pick the display whose bounds contain the point, else the primary one. */
  getDisplayNearestPoint(point: { x: number; y: number }): FakeDisplay {
    return (
      this.displays.find(
        (display) =>
          point.x >= display.bounds.x &&
          point.x < display.bounds.x + display.bounds.width &&
          point.y >= display.bounds.y &&
          point.y < display.bounds.y + display.bounds.height
      ) ?? this.getPrimaryDisplay()
    )
  }

  getCursorScreenPoint(): { x: number; y: number } {
    return { x: 0, y: 0 }
  }
}

export const screen = new FakeScreen()

// ---------------------------------------------------------- theme / power / os

export const nativeTheme = Object.assign(new EventEmitter(), {
  themeSource: 'system' as 'system' | 'light' | 'dark',
  shouldUseDarkColors: false
})

export const powerMonitor = new EventEmitter()
powerMonitor.setMaxListeners(0)

export const dialog = {
  showErrorBox: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] }))
}

export const systemPreferences = {
  getMediaAccessStatus: vi.fn(() => 'granted')
}

// ---------------------------------------------------------------------- reset

/**
 * Return every double to its initial state. Called from the global test setup,
 * so a test never inherits handlers, windows or notifications from its neighbour.
 */
export function resetElectron(): void {
  app.removeAllListeners()
  app.isPackaged = false
  app.singleInstanceLock = true
  app.version = '0.1.0-test'
  app.loginItem = { openAtLogin: false, openAsHidden: false }
  app.loginItemThrows = null
  app.dock = { hide: vi.fn(), show: vi.fn() }
  app.userModelId = null
  app.quit.mockClear()
  app.whenReady.mockClear()
  app.requestSingleInstanceLock.mockClear()
  app.setAppUserModelId.mockClear()
  app.getVersion.mockClear()
  app.getLoginItemSettings.mockClear()
  app.setLoginItemSettings.mockClear()

  ipcMain.handlers.clear()
  ipcMain.removeAllListeners()
  ipcRenderer.removeAllListeners()
  rendererBus.removeAllListeners()

  exposed.clear()
  contextBridge.exposeInMainWorld.mockClear()

  shell.openExternal.mockClear()
  shell.openPath.mockClear()
  openedExternally.length = 0

  clipboard.writeText.mockClear()
  clipboard.readText.mockClear()
  clipboardContents.text = ''

  sender.frame = null
  privilegedSchemes.length = 0
  protocolHandlers.clear()
  servedFiles.clear()
  protocol.registerSchemesAsPrivileged.mockClear()
  protocol.handle.mockClear()
  net.fetch.mockClear()
  FakeNetWebSocket.instances.length = 0

  Notification.supported = true
  Notification.failWith = null
  Notification.neverAnswers = false
  Notification.isSupported.mockClear()
  notifications.length = 0

  nativeImage.createFromPath.mockClear()
  Menu.buildFromTemplate.mockClear()
  menus.length = 0
  trays.length = 0

  BrowserWindow.instances.length = 0
  BrowserWindow.getAllWindows.mockClear()

  screen.displays = [structuredClone(DEFAULT_DISPLAY)]
  screen.removeAllListeners()

  nativeTheme.themeSource = 'system'
  nativeTheme.shouldUseDarkColors = false
  nativeTheme.removeAllListeners()

  powerMonitor.removeAllListeners()

  dialog.showErrorBox.mockClear()
}

export default {
  app,
  ipcMain,
  ipcRenderer,
  contextBridge,
  shell,
  protocol,
  net,
  Notification,
  nativeImage,
  Menu,
  Tray,
  BrowserWindow,
  screen,
  nativeTheme,
  powerMonitor,
  dialog,
  systemPreferences
}
