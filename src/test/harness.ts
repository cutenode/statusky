/**
 * The application harness.
 *
 * Boots the real main-process stack — persisted store, `Model`, IPC handlers, the
 * popover window and the tray — against the Electron and network doubles, and hands
 * back the preload bridge the renderer would actually call. A test can therefore drive
 * the app the way a user does (`harness.api.Accounts.add(...)`) and assert on what
 * really happened: what was persisted, what the tray shows, what was notified.
 *
 * The calls go through the generated IPC wiring, origin validation included, so a
 * harness test proves the real boundary works and not just the model behind it.
 */
import { vi } from 'vitest'
import { registerIpc, type IpcController } from '../main/ipc'
import { Model, type ModelOptions } from '../main/model'
import { notifyPosts } from '../main/notifications'
import { createStore, type PersistedShape } from '../main/store'
import { readStateFromUnread, type Cursors, type ReadState } from '../main/state'
import { TrayController } from '../main/tray'
import { PopoverWindow } from '../main/window'
import type { StatuskyBridge } from '../shared/bridge'
import type { Account, AppState, NetworkSnapshot, Settings, StatusPost } from '../shared/types'
import { BUILTIN_ACCOUNTS, DEFAULT_SETTINGS } from '../shared/defaults'
import { app as electronApp, exposed, nativeTheme, published, trays } from './electron'
import type { BrowserWindow, Tray } from './electron'
import FakeElectronStore, { seedStore } from './electron-store'
import { FakeAppView, rawPost, type PostSpec, type RawProfile } from './appview'
import { makeSettings } from './factories'

export interface HarnessOptions {
  /** Accounts to pretend are already persisted. Builtins are still reconciled in. */
  accounts?: Account[]
  settings?: Partial<Settings>
  posts?: StatusPost[]
  /**
   * Which of `posts` should start out unread. Sugar over `read`: the harness builds the
   * cursors the same way the schema 3 migration does, so a test can say what the badge
   * should show without spelling out a cursor per source.
   */
  unread?: string[]
  /** Read cursors, for a test that is about the cursors themselves. */
  read?: ReadState
  cursors?: Cursors
  version?: string
  /** Register the built-in status accounts with the fake AppView. Default: true. */
  seedAppView?: boolean
  /** Wire the `notify` event to the real notification layer. Default: true. */
  wireNotifications?: boolean
  /** Create the tray icon. Default: true. */
  tray?: boolean
  /** Create the popover window. Default: true. */
  window?: boolean
  /**
   * Report the app as packaged. Default: true, because that is what the production
   * origin validator in `schemas/statusky.eipc` requires before it will accept a call.
   * Under production wiring, set it false to watch a call be refused. The
   * `node-development` project runs against the development branch, where it is the
   * other way round: see `src/main/ipc.development.test.ts`.
   */
  packaged?: boolean
  /** Give the model a way to run network checks. Without it, nothing is probed. */
  network?: ModelOptions['network']
}

export interface Harness {
  readonly appview: FakeAppView
  readonly store: FakeElectronStore<PersistedShape>
  readonly model: Model
  readonly popover: PopoverWindow
  readonly tray: TrayController | null
  /** The preload bridge, exactly as the renderer receives it on `window.statusky`. */
  readonly api: StatuskyBridge
  readonly ipc: IpcController
  readonly quit: ReturnType<typeof vi.fn>
  /** Every state pushed to the renderer, oldest first. */
  readonly pushes: AppState[]
  /** Every batch of posts handed to the notification layer. */
  readonly notified: StatusPost[][]
  /** Every network dashboard pushed, oldest first. */
  readonly networkPushes: NetworkSnapshot[]
  /** Every service the popover was asked to reveal (null: the dashboard itself). */
  readonly revealed: (string | null)[]
  /** Every piece of text dragged onto the menu bar icon. */
  readonly dropped: string[]
  state(): AppState
  /** The tray double backing the `TrayController`, if one was created. */
  trayIcon(): Tray | null
  /** The `BrowserWindow` double backing the popover, if one was created. */
  browserWindow(): BrowserWindow | null
  dispose(): void
}

/** Profiles the fake AppView knows about by default: the two shipped accounts. */
export const BUILTIN_PROFILES: Record<'bsky' | 'blacksky', RawProfile> = {
  bsky: {
    did: BUILTIN_ACCOUNTS[0]!.did,
    handle: BUILTIN_ACCOUNTS[0]!.handle,
    displayName: BUILTIN_ACCOUNTS[0]!.displayName,
    description: BUILTIN_ACCOUNTS[0]!.description ?? undefined,
    followersCount: 120_000,
    postsCount: 400
  },
  blacksky: {
    did: BUILTIN_ACCOUNTS[1]!.did,
    handle: BUILTIN_ACCOUNTS[1]!.handle,
    displayName: BUILTIN_ACCOUNTS[1]!.displayName,
    description: BUILTIN_ACCOUNTS[1]!.description ?? undefined,
    followersCount: 8_000,
    postsCount: 90
  }
}

let preloadApi: StatuskyBridge | null = null

/**
 * Load the preload script once and reuse the API object it exposes. The script
 * only closes over `ipcRenderer`, so a single instance stays correct across
 * harnesses even though the handlers behind it are re-registered each time.
 */
async function loadPreloadApi(): Promise<StatuskyBridge> {
  await import('../preload/index')
  // `exposeInMainWorld` publishes to both the doubles' registry and `globalThis`,
  // so this finds the API whether or not the module registry was just reset.
  const api =
    ((globalThis as Record<string, unknown>).statusky as StatuskyBridge | undefined) ??
    (exposed.get('statusky') as StatuskyBridge | undefined) ??
    (published.get('statusky') as StatuskyBridge | undefined)
  preloadApi = api ?? preloadApi
  if (!preloadApi) throw new Error('The preload script did not expose `statusky`.')
  return preloadApi
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    seedAppView = true,
    wireNotifications = true,
    tray: withTray = true,
    window: withWindow = true,
    packaged = true,
    version = '0.1.0-test'
  } = options

  const seed: Partial<PersistedShape> = {}
  if (options.accounts) seed.accounts = options.accounts
  if (options.settings) seed.settings = makeSettings(options.settings)
  if (options.posts) seed.posts = options.posts
  if (options.read) seed.read = options.read
  else if (options.unread) seed.read = readStateFromUnread(options.posts ?? [], options.unread)
  if (options.cursors) seed.cursors = options.cursors
  if (Object.keys(seed).length) seedStore('statusky', seed as Record<string, unknown>)

  const appview = new FakeAppView()
  if (seedAppView) {
    appview.setFeed(BUILTIN_PROFILES.bsky, [])
    appview.setFeed(BUILTIN_PROFILES.blacksky, [])
  }
  const restoreFetch = appview.install()

  electronApp.version = version
  // The production validator refuses anything from an unpackaged build, so a harness
  // that did not say so would be turned away before reaching a single handler.
  electronApp.isPackaged = packaged

  const store = createStore() as unknown as FakeElectronStore<PersistedShape>
  const model = new Model(store as never, version, { network: options.network })
  const popover = new PopoverWindow()

  const pushes: AppState[] = []
  const notified: StatusPost[][] = []
  const networkPushes: NetworkSnapshot[] = []
  const revealed: (string | null)[] = []
  /** Every piece of text dragged onto the tray icon, in order. */
  const dropped: string[] = []
  const quit = vi.fn(() => {
    model.stop()
    tray?.destroy()
  })

  const ipc = registerIpc({
    model,
    popover,
    onQuit: quit,
    // `tray` is declared below and read when this is called rather than now, the same
    // way `quit` above reaches it. A harness built without a tray simply drops the
    // report, which is what the real app does before `tray.create()` too.
    onReduceMotion: (reduce) => tray?.setReducedMotion(reduce),
    // Declared below and read when called, the same way `quit` and `tray` are.
    onShowNetwork: (serviceId) => showNetwork(serviceId)
  })
  const showNetwork = (serviceId: string | null): void => {
    popover.show()
    revealed.push(serviceId)
    ipc.revealNetwork(serviceId)
  }

  model.on('change', (state) => {
    pushes.push(state)
    tray?.update(state)
    ipc.publish(state)
    nativeTheme.themeSource = state.settings.theme
  })

  model.on('network', (snapshot) => {
    networkPushes.push(snapshot)
    ipc.publishNetwork(snapshot)
  })

  model.on('notify', (posts) => {
    notified.push(posts)
    if (wireNotifications) {
      notifyPosts(posts, model.settings, {
        onOpened: (post) => model.markRead([post.uri]),
        onMarkRead: (post) => model.markRead([post.uri]),
        onShowNetwork: (serviceId) => showNetwork(serviceId)
      })
    }
  })

  const tray = withTray
    ? new TrayController({
        popover,
        onRefresh: () => void model.refresh(),
        onMarkAllRead: () => model.markAllRead(),
        onRunNetworkChecks: () => void model.runNetworkChecks(),
        onShowNetwork: () => showNetwork(null),
        // What the real app does with dropped text, minus the dialog: the harness has
        // no screen to put one on, and `dropped` is what a test asserts against.
        onDropText: (text) => {
          dropped.push(text)
          void model.addAccount(text).catch(() => undefined)
        },
        onSnooze: () => undefined,
        onQuit: quit
      })
    : null
  tray?.create()
  if (withWindow) popover.create()

  const api = await loadPreloadApi()
  ;(globalThis as Record<string, unknown>).statusky = api

  return {
    appview,
    store,
    model,
    popover,
    tray,
    api,
    ipc,
    quit,
    pushes,
    notified,
    networkPushes,
    revealed,
    dropped,
    state: () => model.getState(),
    trayIcon: () => trays.at(-1) ?? null,
    browserWindow: () => popover.browserWindow as unknown as BrowserWindow | null,
    dispose(): void {
      model.stop()
      model.removeAllListeners()
      tray?.destroy()
      restoreFetch()
      appview.reset()
      // Nothing global to unregister: the generated wiring binds its handlers to the
      // popover's own WebContents, which dies with the window.
    }
  }
}

/**
 * A `Model` over a bare in-memory store, with no builtin-account reconciliation.
 * Use it when a test needs an exact account set; use `createHarness` when it needs
 * the whole app.
 */
export function createModel(
  overrides: Partial<PersistedShape> = {},
  version = '0.1.0-test',
  options: ModelOptions = {}
): { model: Model; store: FakeElectronStore<PersistedShape> } {
  const store = new FakeElectronStore<PersistedShape>({
    name: `model-${Math.random().toString(36).slice(2)}`,
    defaults: {
      schemaVersion: 4,
      accounts: [],
      settings: { ...DEFAULT_SETTINGS },
      posts: [],
      read: { cursors: {}, above: [] },
      cursors: {},
      openIncidents: [],
      // A secret already in the clear, the way schema 4 left it: reading it is what
      // moves it into the OS credential store. See `readWebhookSecret`.
      webhookSecret: 'test-webhook-secret',
      webhookSecretEncrypted: '',
      ...overrides
    }
  })
  return { model: new Model(store as never, version, options), store }
}

/** Register an actor's author feed on the fake AppView, one post per spec, newest last. */
export function seedFeed(
  appview: FakeAppView,
  profile: RawProfile,
  specs: PostSpec[]
): FakeAppView {
  return appview.setFeed(
    profile,
    specs.map((spec) => rawPost(profile, spec))
  )
}

/** Run `fn` with `process.platform` pinned, then restore it. */
export async function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

/**
 * Let every queued promise callback run. A macrotask boundary drains the whole
 * microtask queue, so this settles chained `.then`s that a fixed number of
 * `await Promise.resolve()` hops would not.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Wait for something the app does off the back of a call it does not await —
 * binding the webhook receiver's socket, for one, which `patchSettings` starts and
 * leaves running.
 */
export async function waitFor(
  predicate: () => boolean,
  description = 'the condition',
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`)
    // Sequential by nature: each poll has to see the effect of the one before it.
    // oxlint-disable-next-line no-await-in-loop
    await flush()
  }
}
