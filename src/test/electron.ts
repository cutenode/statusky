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
import { vi, type Mock } from 'vitest'
// The real declarations, which production code is type-checked against. Type-only, so
// nothing here ever loads the real package: see `_DriftGuards` at the bottom.
import type * as Real from 'electron'

// ---------------------------------------------------------------------- types

/**
 * A method as a plain function type. TypeScript compares method parameters bivariantly
 * even under `strictFunctionTypes`, which would let a double that accepts *less* than the
 * real method still pass; a function type is compared the strict way round. An overloaded
 * method collapses to its last overload, so pin one of those only where that is the one
 * production calls.
 */
type Strictly<F> = F extends (...args: infer A) => infer R ? (...args: A) => R : F

/**
 * The members of a real Electron API named in `Keys`, each held to its real declaration:
 * parameters contravariantly and results covariantly, so a double that refuses an
 * argument Electron takes, or answers with something Electron never produces, fails to
 * type-check. Only the parts production relies on are named, and only those whose types
 * do not themselves name another Electron object — a double hands out doubles, which the
 * real types cannot describe.
 */
export type Surface<Api, Keys extends keyof Api> = { [K in Keys]: Strictly<Api[K]> }

/** Something constructible with whatever `Class`'s own constructor accepts. */
export type Constructible<Class extends abstract new (...args: never) => unknown> = new (
  ...args: ConstructorParameters<Class>
) => unknown

/** Instantiating this with a `Fake` that is not assignable to `Target` is a compile error. */
export type Conforms<Fake extends Target, Target> = Fake

export type FakeRect = Real.Rectangle

/** The part of a `Display` the popover positions itself by. */
export type FakeDisplay = Pick<Real.Display, 'id' | 'bounds' | 'workArea' | 'scaleFactor'>

export interface MenuItemTemplate {
  label?: string
  type?: string
  /** A built-in Electron role (`paste`, `quit`, …), which supplies its own behaviour. */
  role?: string
  accelerator?: string
  enabled?: boolean
  click?: () => void
  submenu?: MenuItemTemplate[]
}

// ------------------------------------------------------------------------ app

/** `app.dock`, as far as the app touches it. */
interface FakeDock {
  hide: Mock<() => void>
  show: Mock<() => Promise<void>>
}

class FakeApp extends EventEmitter {
  isPackaged = false
  /** Flip to false to exercise the "another copy is already running" path. */
  singleInstanceLock = true
  version = '0.1.0-test'
  /**
   * What `app.getName()` answers, which is `productName` from package.json — not the
   * lowercase `name` beside it, and not the bundle. Electron prefers `productName` when
   * it is there, so a real run says `Statusky` in dev and in a packaged build alike.
   */
  name = 'Statusky'
  userModelId: string | null = null
  /**
   * What the OS has on record, which `getLoginItemSettings` reads back. Only `openAtLogin`:
   * Electron 44 no longer reports `openAsHidden` at all.
   */
  loginItem: { openAtLogin: boolean } = { openAtLogin: false }
  /**
   * `undefined` on a platform with no dock (Windows, Linux), as in Electron — not `null`,
   * which would let an `=== undefined` check pass here and fail on the real thing.
   */
  dock: FakeDock | undefined = { hide: vi.fn<() => void>(), show: vi.fn(async () => undefined) }
  /** Throw from `setLoginItemSettings`, the way an unbundled dev binary does. */
  loginItemThrows: Error | null = null
  /**
   * Accept `setLoginItemSettings` and register nothing, which is the macOS 13+ failure.
   *
   * There it goes through `SMAppService`, which refuses a bundle that is not properly
   * signed or is not in /Applications — and refuses it *quietly*: the call returns,
   * nothing throws, and the only trace is that reading the setting straight back gives
   * the old answer. Unreachable any other way from a test, and the whole reason the app
   * reads it back.
   */
  loginItemRefuses = false

  readonly quit = vi.fn(() => {
    this.emit('quit')
  })
  readonly whenReady = vi.fn(async () => undefined)
  readonly requestSingleInstanceLock = vi.fn(() => this.singleInstanceLock)
  readonly setAppUserModelId = vi.fn((id: string) => {
    this.userModelId = id
  })
  readonly getVersion = vi.fn(() => this.version)
  readonly getName = vi.fn(() => this.name)
  readonly getPath = vi.fn((name: string) => `/tmp/statusky-test/${name}`)
  /** The whole answer, as macOS gives it, rather than just the field the app reads. */
  readonly getLoginItemSettings = vi.fn((): Real.LoginItemSettings => ({
    openAtLogin: this.loginItem.openAtLogin,
    wasOpenedAtLogin: false,
    status: this.loginItem.openAtLogin ? 'enabled' : 'not-registered',
    executableWillLaunchAtLogin: this.loginItem.openAtLogin,
    launchItems: []
  }))
  readonly setLoginItemSettings = vi.fn((settings: Real.Settings) => {
    if (this.loginItemThrows) throw this.loginItemThrows
    if (this.loginItemRefuses) return
    // Electron's default, so a call that leaves it out unregisters, as the real one does.
    this.loginItem = { openAtLogin: settings.openAtLogin ?? false }
  })

  /**
   * Schemes this app has claimed from the OS, in order, with the command line it asked
   * to be launched with. On Windows that command line is written into the registry, so
   * the arguments are the whole of the mitigation for the protocol-handler injection
   * class of bug and are worth being able to assert on. See src/main/deep-link.ts.
   */
  readonly protocolClients: { scheme: string; path?: string; args?: string[] }[] = []

  readonly setAsDefaultProtocolClient = vi.fn(
    (scheme: string, path?: string, args?: string[]): boolean => {
      this.protocolClients.push({ scheme, path, args })
      return true
    }
  )

  readonly removeAsDefaultProtocolClient = vi.fn((scheme: string): boolean => {
    const index = this.protocolClients.findIndex((entry) => entry.scheme === scheme)
    if (index === -1) return false
    this.protocolClients.splice(index, 1)
    return true
  })

  readonly isDefaultProtocolClient = vi.fn((scheme: string): boolean =>
    this.protocolClients.some((entry) => entry.scheme === scheme)
  )

  /** What the native About panel has been told to say; null until it is configured. */
  aboutPanel: Real.AboutPanelOptionsOptions | null = null
  readonly setAboutPanelOptions = vi.fn((options: Real.AboutPanelOptionsOptions) => {
    this.aboutPanel = options
  })
  readonly showAboutPanel = vi.fn<() => void>()
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
    // Electron serializes the arguments with the structured clone algorithm on the way
    // out, so main never holds an object the page can still change, and anything that
    // cannot be cloned — a function, a Svelte state proxy — fails here as it would there.
    const sent = structuredClone(args)
    const frame = senderFrame()
    // The same search Electron makes: the frame, then its page, then `ipcMain`.
    const handler =
      frame?.ipc.handlers.get(channel) ??
      frame?.webContents.ipc.handlers.get(channel) ??
      ipcMain.handlers.get(channel)
    if (!handler) {
      throw new Error(
        `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`
      )
    }
    let result: unknown
    try {
      result = await handler({ sender: frame?.webContents ?? null, senderFrame: frame }, ...sent)
    } catch (error) {
      // All that crosses back is the failure as a string — `Error: …`, `TypeError: …`, or
      // whatever a non-Error stringifies to — which the renderer wraps in a fresh `Error`
      // behind the channel name. No class, no `cause`, no custom fields: the renderer has
      // to make do with the sentence, so here it has to as well.
      // oxlint-disable-next-line preserve-caught-error
      throw new Error(`Error invoking remote method '${channel}': ${String(error)}`)
    }
    return structuredClone(result)
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

/**
 * What a renderer-side listener is handed ahead of the payload. Its `sender` is the
 * `ipcRenderer` the message arrived on, as in Electron — never the main-process
 * `WebContents` that sent it, which no page can hold.
 */
type FakeIpcRendererEvent = Omit<Real.IpcRendererEvent, 'sender'> & {
  sender: FakeIpcRenderer
}

function rendererEvent(): FakeIpcRendererEvent {
  return {
    sender: ipcRenderer,
    ports: [],
    preventDefault: () => undefined,
    defaultPrevented: false
  }
}

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
  })
}

// ---------------------------------------------------------------------- shell

export const shell = {
  openExternal: vi.fn(async (url: string) => {
    openedExternally.push(url)
  })
}

/** Every URL handed to the OS, in order. */
export const openedExternally: string[] = []

// ------------------------------------------------------------------ clipboard

/** The system clipboard, as far as anything in a test can tell. */
export const clipboardContents = { text: '' }

export const clipboard = {
  // A promise, as in Electron 44, which made it follow `navigator.clipboard`: whether the
  // write worked is only known when it settles.
  writeText: vi.fn(async (text: string) => {
    clipboardContents.text = text
  })
}

// ------------------------------------------------------------- protocol / net

/** Schemes `registerSchemesAsPrivileged` was told about, in order. */
export const privilegedSchemes: Real.CustomScheme[] = []
/** Handlers installed by `protocol.handle`, keyed by scheme. */
export const protocolHandlers = new Map<string, (request: Request) => Promise<Response>>()

export const protocol = {
  registerSchemesAsPrivileged: vi.fn((schemes: Real.CustomScheme[]) => {
    privilegedSchemes.push(...schemes)
  }),
  // Electron takes a handler that answers synchronously as readily as one that returns a
  // promise, and awaits either. Stored behind an `await` of its own, so whatever a test
  // does with the answer holds for both.
  handle: vi.fn((scheme: string, handler: (request: Request) => Response | Promise<Response>) => {
    protocolHandlers.set(scheme, async (request) => handler(request))
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

/**
 * The default `net.fetch`: `servedFiles` and nothing else, 404 for everything else.
 *
 * Named so `resetElectron` can put it back after a test has replaced it. A 404 is a
 * useful default beyond the renderer bundle, too — it is exactly what the GitHub
 * releases API answers for a repository that has not published one yet.
 *
 * The `init` is declared and ignored: nothing here varies on it, but the real
 * `net.fetch` takes one and both callers pass one — the probes their abort signal, the
 * release check its headers — so a test that wraps this one has to be able to pass it on.
 */
const serveFromDisk = async (input: string | Request, _init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.url
  const path = url.startsWith('file://') ? fileURLToPath(url) : url
  const body = servedFiles.get(path)
  if (body === undefined) return new Response('Not found', { status: 404 })
  return new Response(body, { status: 200 })
}

export const net = {
  /**
   * Chromium's own read on whether this machine has a connection, which main puts a
   * renderer's `online` claim to before acting on it. True by default: a test that
   * cares about main disbelieving the page sets it false.
   */
  online: true,
  fetch: vi.fn(serveFromDisk),
  WebSocket: FakeNetWebSocket
}

// --------------------------------------------------------------- notifications

export class Notification extends EventEmitter {
  static supported = true
  static isSupported = vi.fn(() => Notification.supported)
  /** When set, every notification is refused by the fake OS with this reason. */
  static failWith: string | null = null
  /** Model an OS that simply never answers, which is what the confirm timeout is for. */
  static neverAnswers = false

  shown = false
  closed = false

  /** Exactly what the real constructor takes, so a test can only assert on real options. */
  constructor(readonly options: Real.NotificationConstructorOptions = {}) {
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

  /**
   * Simulate the user pressing one of the banner's action buttons.
   *
   * Electron passes the index inside the event object and, deprecated, as a positional
   * argument as well; only the object is reproduced here, because that is the one the
   * app is allowed to read. A button the banner does not have throws rather than
   * silently doing nothing, so a test that renumbers the actions fails loudly.
   */
  act(index: number): void {
    const actions = this.options.actions ?? []
    if (index < 0 || index >= actions.length) {
      throw new Error(`This notification has no action at index ${index}.`)
    }
    this.emit('action', {
      actionIndex: index,
      selectionIndex: -1
    } satisfies Real.NotificationActionEventParams)
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
}

export const nativeImage = {
  createFromPath: vi.fn((path: string) => new FakeNativeImage(path))
}

// ----------------------------------------------------------------------- menu

function collectRoles(entries: MenuItemTemplate[]): string[] {
  return entries.flatMap((entry) => [
    ...(entry.role ? [entry.role] : []),
    ...collectRoles(entry.submenu ?? [])
  ])
}

export interface MenuPopupOptions {
  window?: unknown
  x?: number
  y?: number
  /** Run when the menu closes, however it closed. */
  callback?: () => void
}

export class FakeMenu {
  /** Every `popup`, in order; the last one is the menu currently on screen. */
  readonly popups: MenuPopupOptions[] = []

  constructor(readonly template: MenuItemTemplate[]) {}

  /**
   * Put the menu on screen. Electron's `popup` returns immediately and reports the
   * dismissal through `callback`, which is the only notice an app gets that a menu it
   * opened is gone — and therefore the only place anything held open for it can be
   * let go. See `closePopup`.
   */
  popup(options: MenuPopupOptions = {}): void {
    this.popups.push(options)
  }

  /** Whether this menu is on screen right now. */
  isOpen(): boolean {
    return this.popups.length > 0
  }

  /**
   * Dismiss the menu, running the close callback Electron would run.
   *
   * Called by `click` as well, because selecting an item is one of the ways a menu
   * closes: an app that only released what it was holding on an explicit dismissal
   * would hold it forever the moment somebody actually used the menu. Electron does
   * not promise which of the two arrives first, so nothing here should depend on it.
   */
  closePopup(): void {
    const options = this.popups.pop()
    options?.callback?.()
  }

  /** Find a menu entry by its label, so tests can assert on and invoke it. */
  item(label: string): MenuItemTemplate | undefined {
    return this.template.find((entry) => entry.label === label)
  }

  /**
   * The entries of the submenu hanging off `label`, or `undefined` if there is no
   * such entry. An application menu is entirely submenus, so a test that never
   * descends into one can only assert that the menu bar exists.
   */
  submenu(label: string): MenuItemTemplate[] | undefined {
    return this.item(label)?.submenu
  }

  /** Every role in the menu, submenus included, depth first and in drawing order. */
  roles(): string[] {
    return collectRoles(this.template)
  }

  /** Click a menu entry by label. Throws if it is missing, so typos fail loudly. */
  click(label: string): void {
    const entry = this.item(label)
    if (!entry) throw new Error(`No menu item labelled ${JSON.stringify(label)}`)
    entry.click?.()
    if (this.isOpen()) this.closePopup()
  }
}

/**
 * `ShareMenu`: the system share sheet, which is a menu the OS fills in.
 *
 * Deliberately not a `FakeMenu`: the app never writes its entries — Messages, Mail and
 * whatever share extensions are installed are the OS's business — so the only thing
 * worth recording is what was handed over and whether it was put on screen.
 */
export class FakeShareMenu {
  readonly popups: MenuPopupOptions[] = []

  constructor(readonly sharingItem: Real.SharingItem) {
    shareMenus.push(this)
  }

  popup(options: MenuPopupOptions = {}): void {
    this.popups.push(options)
  }

  isOpen(): boolean {
    return this.popups.length > 0
  }

  closePopup(): void {
    const options = this.popups.pop()
    options?.callback?.()
  }
}

/** Every share sheet constructed, in order. */
export const shareMenus: FakeShareMenu[] = []

/**
 * The menu Electron would install over the whole application, or null where the app
 * has explicitly asked for none. It stays `undefined` until something sets it, which
 * is the state that lets Electron install its own default menu instead.
 */
export const applicationMenu: { current: FakeMenu | null | undefined } = { current: undefined }

export const Menu = {
  buildFromTemplate: vi.fn((template: MenuItemTemplate[]) => {
    const menu = new FakeMenu(template)
    menus.push(menu)
    return menu
  }),
  setApplicationMenu: vi.fn((menu: FakeMenu | null) => {
    applicationMenu.current = menu
  })
}

export const menus: FakeMenu[] = []
export const ShareMenu = FakeShareMenu

// ------------------------------------------------------------ globalShortcut

/**
 * `globalShortcut`: key combinations claimed from the whole machine.
 *
 * `taken` is the knob that matters. A global shortcut belongs to whichever application
 * asked for it first, and the only sign of losing that race is `register` answering
 * false — there is no error, no event, and no second chance until the winner exits. It
 * is unreachable from a test any other way, and it is the entire reason the app reads
 * the return value instead of assuming the key now works.
 */
class FakeGlobalShortcut {
  /** Accelerators another application already owns, so `register` refuses them. */
  readonly taken = new Set<string>()
  /**
   * Set to throw from `register`, the way Electron does on a malformed accelerator.
   * Typed as `unknown` because a throw crossing out of native code is not obliged to be
   * an `Error`, and the app has to survive one that is not.
   */
  registerThrows: unknown = null
  /** What is currently registered to this app, and what each one runs. */
  readonly registrations = new Map<string, () => void>()

  readonly register = vi.fn((accelerator: string, callback: () => void): boolean => {
    if (this.registerThrows) throw this.registerThrows
    if (this.taken.has(accelerator)) return false
    this.registrations.set(accelerator, callback)
    return true
  })

  readonly unregister = vi.fn((accelerator: string) => {
    this.registrations.delete(accelerator)
  })

  readonly unregisterAll = vi.fn(() => {
    this.registrations.clear()
  })

  readonly isRegistered = vi.fn((accelerator: string) => this.registrations.has(accelerator))

  /** Press the combination, the way somebody in another application would. */
  press(accelerator: string): boolean {
    const callback = this.registrations.get(accelerator)
    if (!callback) return false
    callback()
    return true
  }
}

export const globalShortcut = new FakeGlobalShortcut()

// ----------------------------------------------------------------- autoUpdater

/**
 * `autoUpdater`: Electron's wrapper around Squirrel.Mac and Squirrel.Windows.
 *
 * Only the two things this app touches, and it touches neither directly in the ordinary
 * case — `update-electron-app` drives the feed and the checks, and src/main/update.ts
 * listens in on one event and offers one action.
 *
 * `error` is the interesting one. It is Squirrel's single channel for every reason an
 * install cannot update itself: a code signature that does not match the running app
 * (which is every ad-hoc signed local build), a Windows install with no `Update.exe`
 * beside it, a feed that answers 404 because nothing has been released yet. The app
 * treats all of them the same way and falls back to merely telling the user, so a test
 * needs to be able to raise one.
 *
 * `quitAndInstall` never returns in Electron — Squirrel swaps the bundle and relaunches —
 * so here it only records that it was reached. Anything asserting on it is asserting that
 * the process was about to go, which is the whole of what the app can promise.
 */
class FakeAutoUpdater extends EventEmitter {
  readonly quitAndInstall = vi.fn<() => void>()

  /** Squirrel refusing, in whatever way it is refusing today. */
  fail(reason: string): void {
    this.emit('error', new Error(reason))
  }
}

export const autoUpdater = new FakeAutoUpdater()

// ----------------------------------------------------------------------- tray

export class Tray extends EventEmitter {
  image: FakeNativeImage
  tooltip = ''
  title = ''
  /**
   * The options `setTitle` was last given. macOS renders the title in the menu bar's
   * proportional font unless asked for `monospacedDigit`, and a count that changes width
   * shoves everything left of the icon sideways — so this is worth being able to assert.
   */
  titleOptions: Real.TitleOptions | null = null
  destroyed = false
  ignoresDoubleClick = false
  bounds: FakeRect = { x: 900, y: 0, width: 24, height: 24 }
  readonly poppedUpMenus: FakeMenu[] = []
  /**
   * The menu attached to the icon, as opposed to one popped up on demand.
   *
   * These are two different things on the real platforms, which is the whole reason the
   * app cares: under StatusNotifierItem — GNOME, KDE, most Linux desktops — the host asks
   * the item for this menu, and never delivers a left click to the application at all, so
   * an item that has not set one can end up with no way in. On macOS, setting it replaces
   * the left-click toggle, which for this app would be wrong. Null until set.
   */
  contextMenu: FakeMenu | null = null

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

  setTitle(title: string, options?: Real.TitleOptions): void {
    this.title = title
    this.titleOptions = options ?? null
  }

  setContextMenu(menu: FakeMenu | null): void {
    this.contextMenu = menu
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

  /**
   * Drag text over the icon and let go of it, the way a handle selected in a browser
   * arrives. macOS only in Electron, and there is no way to reach any of the three from
   * a test but to emit them, so they are spelled out here rather than left to callers.
   */
  dragEnter(): void {
    this.emit('drag-enter', {})
  }

  dragLeave(): void {
    this.emit('drag-leave', {})
  }

  dropText(text: string): void {
    this.emit('drop-text', {}, text)
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
  destroyed = false
  url = ''
  windowOpenHandler: ((details: { url: string }) => unknown) | null = null
  /** Every `send` this window made: the renderer-facing push stream. */
  readonly sent: { channel: string; payload: unknown }[] = []
  /** Handlers registered against this page rather than globally. */
  readonly ipc = new FakeScopedIpc()
  readonly mainFrame: FakeWebFrameMain = new FakeWebFrameMain(this)

  send(channel: string, ...args: unknown[]): void {
    // Electron throws rather than quietly dropping the message when the page is gone,
    // which is the whole reason anything holding a dispatcher has to ask first.
    if (this.destroyed) throw new TypeError('Object has been destroyed')
    // Serialized on the way across, like `invoke`: the page gets a copy, so main changing
    // an object after pushing it cannot reach into what the renderer already holds.
    const delivered = structuredClone(args)
    const payload = delivered.length > 1 ? delivered : delivered[0]
    this.sent.push({ channel, payload })
    rendererBus.emit(channel, rendererEvent(), ...delivered)
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

  /**
   * Electron throws from `send` on a destroyed page rather than dropping the message,
   * so anything holding a dispatcher has to ask first. See src/main/ipc.ts.
   */
  isDestroyed(): boolean {
    return this.destroyed
  }

  openDevTools(): void {
    this.devToolsOpen = true
  }
}

export class BrowserWindow extends EventEmitter {
  static instances: BrowserWindow[] = []

  readonly webContents = new FakeWebContents()
  readonly options: Real.BrowserWindowConstructorOptions
  readonly loaded: { url?: string; file?: string }[] = []
  visible = false
  focused = false
  destroyed = false
  alwaysOnTop: boolean
  visibleOnAllWorkspaces = false
  private bounds: FakeRect

  constructor(options: Real.BrowserWindowConstructorOptions = {}) {
    super()
    this.options = options
    this.alwaysOnTop = options.alwaysOnTop ?? false
    this.bounds = { x: 0, y: 0, width: options.width ?? 800, height: options.height ?? 600 }
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
    this.webContents.destroyed = true
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
}

export const screen = new FakeScreen()

// ---------------------------------------------------------- theme / power / os

export const nativeTheme = Object.assign(new EventEmitter(), {
  themeSource: 'system' as Real.NativeTheme['themeSource'],
  shouldUseDarkColors: false,
  /**
   * Windows high contrast, which is an axis of its own rather than a darker dark. Set it
   * and emit `updated` to turn the mode on the way the OS does — there is no way to reach
   * this from a Mac otherwise, and the app's response to it is a real branch.
   */
  shouldUseHighContrastColors: false
})

export type FakeThermalState = ReturnType<Real.PowerMonitor['getCurrentThermalState']>
export type FakeIdleState = ReturnType<Real.PowerMonitor['getSystemIdleState']>

/**
 * `powerMonitor`: an event emitter with three questions it can also be asked.
 *
 * The events are the point — `emit('on-battery')` is how a test unplugs a laptop — but
 * the three readable states matter just as much, because the app reads all of them at
 * startup rather than waiting for a transition that may never come. They are plain
 * fields so that a test sets the machine up and then boots the app into it, which is
 * the only way round that models "this laptop has been on battery since breakfast".
 */
class FakePowerMonitor extends EventEmitter {
  onBattery = false
  thermalState: FakeThermalState = 'nominal'
  /** What `getSystemIdleState` answers, whatever threshold it is asked about. */
  idleState: FakeIdleState = 'active'

  isOnBatteryPower(): boolean {
    return this.onBattery
  }

  getCurrentThermalState(): FakeThermalState {
    return this.thermalState
  }

  getSystemIdleState(_idleThreshold: number): FakeIdleState {
    return this.idleState
  }
}

export const powerMonitor = new FakePowerMonitor()
powerMonitor.setMaxListeners(0)

/** What the file dialogs answer until a test says otherwise: somebody pressed Cancel. */
const cancelledOpen = async (
  _options?: unknown
): Promise<{ canceled: boolean; filePaths: string[] }> => ({
  canceled: true,
  filePaths: []
})
const cancelledSave = async (
  _options?: unknown
): Promise<{ canceled: boolean; filePath: string }> => ({
  canceled: true,
  filePath: ''
})

export const dialog = {
  showErrorBox: vi.fn<(title: string, content: string) => void>(),
  showMessageBox: vi.fn(
    async (_options: Real.MessageBoxOptions): Promise<Real.MessageBoxReturnValue> => ({
      response: 0,
      checkboxChecked: false
    })
  ),
  showOpenDialog: vi.fn(cancelledOpen),
  showSaveDialog: vi.fn(cancelledSave)
}

// ----------------------------------------------------------------- safeStorage

/** What a sealed value starts with, so a test can recognise one on sight. */
export const SEALED_PREFIX = 'sealed:'

/**
 * `safeStorage`: the OS credential store, as far as anything keeping a secret can tell.
 *
 * The sealing is a visible envelope rather than a cipher. What a test needs to prove is
 * that the plaintext left the config file, that the value survives a round trip, and
 * that a buffer this machine cannot open is refused — none of which needs real crypto,
 * and all of which is easier to read when the envelope is legible.
 *
 * `available` is the knob that matters: it models a Linux desktop with no secret
 * service running, where `isEncryptionAvailable()` is honestly false and the app has
 * to carry on anyway.
 */
class FakeSafeStorage {
  /** Set to false for a machine with nowhere to keep a secret. */
  available = true
  /** Set to make a store that claims to be available refuse the write anyway. */
  encryptThrows: Error | null = null

  readonly isEncryptionAvailable = vi.fn(() => this.available)

  readonly encryptString = vi.fn((plaintext: string) => {
    if (this.encryptThrows) throw this.encryptThrows
    if (!this.available) throw new Error('Encryption is not available on this system')
    return Buffer.from(`${SEALED_PREFIX}${plaintext}`, 'utf8')
  })

  readonly decryptString = vi.fn((sealed: Buffer) => {
    if (!this.available) throw new Error('Encryption is not available on this system')
    const text = sealed.toString('utf8')
    // What the real one does with a buffer it did not seal, or sealed under a key
    // this machine no longer has.
    if (!text.startsWith(SEALED_PREFIX)) throw new Error('Could not decrypt the buffer')
    return text.slice(SEALED_PREFIX.length)
  })
}

export const safeStorage = new FakeSafeStorage()

// --------------------------------------------------------------------- session

type RealRequestHandler = NonNullable<Parameters<Real.Session['setPermissionRequestHandler']>[0]>
export type PermissionCheckHandler = NonNullable<
  Parameters<Real.Session['setPermissionCheckHandler']>[0]
>

/**
 * Every permission Chromium can put to each handler, straight from Electron's own
 * declaration, so a test cannot prove the app refuses one that is never asked for.
 */
export type RequestPermission = Parameters<RealRequestHandler>[1]
export type CheckPermission = Parameters<PermissionCheckHandler>[1]

/**
 * The prompt handler, as the double calls it. Electron always hands it the asking
 * page's `WebContents` and a `details` object; there is no page behind `request`, so
 * both stay loose here, and only the permission is held to the real list.
 */
export type PermissionRequestHandler = (
  contents: unknown,
  permission: RequestPermission,
  callback: (granted: boolean) => void,
  details?: unknown
) => void

/**
 * One browsing session, and the two questions Chromium asks it about permissions.
 *
 * `request` and `check` answer the way Chromium would if nothing had been configured
 * — granted — so a test that forgets to install the handlers sees a permission being
 * allowed rather than a mock that was never called. Denial has to be the app's doing.
 */
class FakeSession {
  requestHandler: PermissionRequestHandler | null = null
  checkHandler: PermissionCheckHandler | null = null

  readonly setPermissionRequestHandler = vi.fn((handler: PermissionRequestHandler | null) => {
    this.requestHandler = handler
  })

  readonly setPermissionCheckHandler = vi.fn((handler: PermissionCheckHandler | null) => {
    this.checkHandler = handler
  })

  /** Ask for a permission the way a page would, and report the answer. */
  request(permission: RequestPermission, contents: unknown = null): boolean {
    let granted = true
    this.requestHandler?.(contents, permission, (value) => {
      granted = value
    })
    return granted
  }

  /**
   * Ask whether a permission is already held, which Chromium does without a prompt —
   * and, for this one, without necessarily having a page to name, so a `null` sender is
   * what Electron passes too.
   */
  check(permission: CheckPermission, origin = 'app://statusky'): boolean {
    return (
      this.checkHandler?.(null, permission, origin, { isMainFrame: true, requestingUrl: origin }) ??
      true
    )
  }
}

export const session = {
  defaultSession: new FakeSession()
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
  app.name = 'Statusky'
  app.loginItem = { openAtLogin: false }
  app.loginItemThrows = null
  app.loginItemRefuses = false
  app.dock = { hide: vi.fn<() => void>(), show: vi.fn(async () => undefined) }
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
  openedExternally.length = 0

  clipboard.writeText.mockClear()
  clipboardContents.text = ''

  sender.frame = null
  privilegedSchemes.length = 0
  protocolHandlers.clear()
  servedFiles.clear()
  protocol.registerSchemesAsPrivileged.mockClear()
  protocol.handle.mockClear()
  // Put the default implementation back, not just the call list. A test that pointed
  // `net.fetch` somewhere of its own — the release check's GitHub answers, a probe's
  // response — must not leave it pointed there for the next one, which would then be
  // asserting against a neighbour's fixture. Same reasoning as `dialog.showMessageBox`
  // at the bottom of this function.
  net.fetch.mockReset()
  net.fetch.mockImplementation(serveFromDisk)
  net.online = true
  FakeNetWebSocket.instances.length = 0

  Notification.supported = true
  Notification.failWith = null
  Notification.neverAnswers = false
  Notification.isSupported.mockClear()
  notifications.length = 0

  nativeImage.createFromPath.mockClear()
  Menu.buildFromTemplate.mockClear()
  Menu.setApplicationMenu.mockClear()
  applicationMenu.current = undefined
  menus.length = 0
  shareMenus.length = 0
  trays.length = 0

  app.protocolClients.length = 0
  app.setAsDefaultProtocolClient.mockClear()
  app.removeAsDefaultProtocolClient.mockClear()
  app.isDefaultProtocolClient.mockClear()

  globalShortcut.taken.clear()
  globalShortcut.registrations.clear()
  globalShortcut.registerThrows = null
  globalShortcut.register.mockClear()
  globalShortcut.unregister.mockClear()
  globalShortcut.unregisterAll.mockClear()
  globalShortcut.isRegistered.mockClear()

  autoUpdater.removeAllListeners()
  autoUpdater.quitAndInstall.mockClear()

  app.aboutPanel = null
  app.setAboutPanelOptions.mockClear()
  app.showAboutPanel.mockClear()

  safeStorage.available = true
  safeStorage.encryptThrows = null
  safeStorage.isEncryptionAvailable.mockClear()
  safeStorage.encryptString.mockClear()
  safeStorage.decryptString.mockClear()

  session.defaultSession.requestHandler = null
  session.defaultSession.checkHandler = null
  session.defaultSession.setPermissionRequestHandler.mockClear()
  session.defaultSession.setPermissionCheckHandler.mockClear()

  BrowserWindow.instances.length = 0

  screen.displays = [structuredClone(DEFAULT_DISPLAY)]
  screen.removeAllListeners()

  nativeTheme.themeSource = 'system'
  nativeTheme.shouldUseDarkColors = false
  nativeTheme.shouldUseHighContrastColors = false
  nativeTheme.removeAllListeners()

  powerMonitor.removeAllListeners()
  powerMonitor.onBattery = false
  powerMonitor.thermalState = 'nominal'
  powerMonitor.idleState = 'active'

  dialog.showErrorBox.mockClear()
  dialog.showMessageBox.mockClear()
  // A test that made the dialog never answer must not leave it that way for the next
  // one: `mockClear` forgets the calls but keeps the implementation.
  dialog.showMessageBox.mockImplementation(async () => ({ response: 0, checkboxChecked: false }))
  // Likewise a file dialog pointed at a test's own temporary file.
  dialog.showOpenDialog.mockReset()
  dialog.showOpenDialog.mockImplementation(cancelledOpen)
  dialog.showSaveDialog.mockReset()
  dialog.showSaveDialog.mockImplementation(cancelledSave)
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
  ShareMenu,
  globalShortcut,
  autoUpdater,
  Tray,
  BrowserWindow,
  screen,
  nativeTheme,
  powerMonitor,
  dialog,
  safeStorage,
  session
}

// ---------------------------------------------------------------- drift guards

/**
 * Every double above, held to the real declaration it stands in for — the one production
 * code is type-checked against — for exactly the members production calls. An Electron
 * upgrade that changes one of them, or an edit that makes a double take or return
 * something the real API does not, is then a type error here instead of a suite that
 * passes against behaviour no build will ever see.
 *
 * What is missing is missing on purpose, because its type names another Electron object
 * that a double can only answer with another double: `webContents` and the events IPC
 * handlers receive, the images and menus a tray or window is handed,
 * `nativeImage.createFromPath`, `screen`'s displays (whose shape `FakeDisplay` pins
 * instead), the `WebContents` a permission request comes from, and the `on` overloads.
 * So are `net.fetch`, which takes a `Request` as well as a string, and
 * `dialog.showMessageBox`, whose answer also carries `checkboxChecked`: both are
 * narrower here than in Electron, and tests override them with implementations just as
 * narrow, so widening them is a change for those tests to make first.
 */
export type _DriftGuards = [
  Conforms<
    typeof app,
    Surface<
      Real.App,
      | 'isPackaged'
      | 'quit'
      | 'whenReady'
      | 'requestSingleInstanceLock'
      | 'setAppUserModelId'
      | 'getVersion'
      | 'getName'
      | 'getPath'
      | 'getLoginItemSettings'
      | 'setLoginItemSettings'
      | 'setAsDefaultProtocolClient'
      | 'removeAsDefaultProtocolClient'
      | 'isDefaultProtocolClient'
      | 'setAboutPanelOptions'
      | 'showAboutPanel'
    >
  >,
  Conforms<FakeDock, Surface<Real.Dock, 'hide' | 'show'>>,
  Conforms<typeof ipcMain, Surface<Real.IpcMain, 'removeHandler'>>,
  Conforms<FakeScopedIpc, Surface<Real.IpcMain, 'removeHandler'>>,
  Conforms<typeof ipcRenderer, Surface<Real.IpcRenderer, 'invoke'>>,
  Conforms<typeof contextBridge, Surface<Real.ContextBridge, 'exposeInMainWorld'>>,
  Conforms<typeof shell, Surface<Real.Shell, 'openExternal'>>,
  Conforms<typeof clipboard, Surface<Real.Clipboard, 'writeText'>>,
  Conforms<typeof protocol, Surface<Real.Protocol, 'registerSchemesAsPrivileged' | 'handle'>>,
  Conforms<typeof net, Surface<Real.Net, 'online' | 'fetch'>>,
  Conforms<
    typeof Notification,
    Constructible<typeof Real.Notification> & Surface<typeof Real.Notification, 'isSupported'>
  >,
  Conforms<Notification, Surface<Real.Notification, 'show' | 'close'>>,
  Conforms<
    FakeNativeImage,
    Surface<Real.NativeImage, 'setTemplateImage' | 'isTemplateImage' | 'isEmpty'>
  >,
  Conforms<FakeMenu, Surface<Real.Menu, 'popup' | 'closePopup'>>,
  Conforms<typeof ShareMenu, Constructible<typeof Real.ShareMenu>>,
  Conforms<FakeShareMenu, Surface<Real.ShareMenu, 'popup' | 'closePopup'>>,
  Conforms<
    typeof globalShortcut,
    Surface<Real.GlobalShortcut, 'register' | 'unregister' | 'unregisterAll' | 'isRegistered'>
  >,
  Conforms<typeof autoUpdater, Surface<Real.AutoUpdater, 'quitAndInstall'>>,
  Conforms<
    Tray,
    Surface<
      Real.Tray,
      | 'setToolTip'
      | 'setTitle'
      | 'setIgnoreDoubleClickEvents'
      | 'getBounds'
      | 'destroy'
      | 'isDestroyed'
    >
  >,
  Conforms<FakeWebFrameMain, Surface<Real.WebFrameMain, 'url' | 'send'>>,
  Conforms<
    BrowserWindow['webContents'],
    Surface<
      Real.WebContents,
      'send' | 'getURL' | 'isDevToolsOpened' | 'isDestroyed' | 'openDevTools'
    >
  >,
  Conforms<typeof BrowserWindow, Constructible<typeof Real.BrowserWindow>>,
  Conforms<
    BrowserWindow,
    Surface<
      Real.BrowserWindow,
      | 'show'
      | 'hide'
      | 'focus'
      | 'blur'
      | 'close'
      | 'destroy'
      | 'isVisible'
      | 'isDestroyed'
      | 'isFocused'
      | 'getBounds'
      | 'setBounds'
      | 'getPosition'
      | 'setPosition'
      | 'setAlwaysOnTop'
      | 'setVisibleOnAllWorkspaces'
      | 'loadURL'
      | 'loadFile'
    >
  >,
  Conforms<
    typeof nativeTheme,
    Surface<Real.NativeTheme, 'themeSource' | 'shouldUseDarkColors' | 'shouldUseHighContrastColors'>
  >,
  Conforms<
    typeof powerMonitor,
    Surface<Real.PowerMonitor, 'isOnBatteryPower' | 'getCurrentThermalState' | 'getSystemIdleState'>
  >,
  Conforms<
    typeof dialog,
    Surface<Real.Dialog, 'showErrorBox' | 'showMessageBox' | 'showOpenDialog' | 'showSaveDialog'>
  >,
  Conforms<
    typeof safeStorage,
    Surface<Real.SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  >,
  Conforms<typeof session.defaultSession, Surface<Real.Session, 'setPermissionCheckHandler'>>
]
