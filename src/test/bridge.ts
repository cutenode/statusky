/**
 * A standalone double for the preload bridge (`window.statusky`).
 *
 * Component tests need the bridge to behave — toggling a switch must actually
 * change the state that comes back — but not to boot a main process. This
 * implements the same interfaces `schemas/statusky.eipc` declares, over an in-memory
 * `AppState`, pushing a fresh snapshot after every mutation exactly as the real app
 * does. Failures are thrown, because that is how they arrive from the generated client.
 *
 * `src/test/bridge.contract.test.ts` pins it to the real preload surface, so the
 * two cannot drift.
 */
import { vi } from 'vitest'
import type { StatuskyBridge } from '../shared/bridge'
import type {
  Account,
  AccountPatch,
  AppState,
  NetworkReveal,
  NetworkSnapshot,
  Platform,
  ResolvedProfile,
  Settings,
  WebhookStatus
} from '../shared/types'
import { makeAccount, makeProfile, makeSnapshot, makeState } from './factories'

export interface BridgeOptions extends Partial<AppState> {
  /** The network dashboard `Network.get` hands over. */
  snapshot?: NetworkSnapshot
  platform?: Platform
  /** Fail `Accounts.add`/`Actors.resolve` with this message, to exercise error paths. */
  resolveError?: string
  /** Profile returned by `Accounts.add`/`Actors.resolve` on success. */
  resolves?: ResolvedProfile
}

export interface TestBridge {
  readonly api: StatuskyBridge
  /** The current snapshot the bridge would hand the renderer. */
  readonly state: AppState
  /** Replace part of the state and push it, as a main-process update would. */
  push(patch: Partial<AppState>): void
  /** The current network dashboard. */
  readonly snapshot: NetworkSnapshot
  /** Replace part of the dashboard and push it on the network channel. */
  pushNetwork(patch: Partial<NetworkSnapshot>): void
  /** Ask the popover to show the dashboard, as a notification click would. */
  reveal(serviceId: string | null): void
  /** Ask the popover to show the Timeline, as a click on the away summary would. */
  catchUp(): void
  /** Number of live `State.onChanged` subscriptions; 0 after a clean teardown. */
  listenerCount(): number
  /** Live subscriptions on every other pushed channel, likewise. */
  pushListenerCount(): number
  /** Restore the previous `window.statusky`, if any. */
  restore(): void
}

/**
 * Install a working bridge on `window.statusky` and return handles to it.
 * Every method is a `vi.fn`, so tests can assert on calls as well as on effects.
 */
export function installBridge(options: BridgeOptions = {}): TestBridge {
  const {
    platform = 'darwin',
    resolveError,
    resolves,
    snapshot: initialSnapshot,
    ...initial
  } = options

  let state = makeState(initial)
  let snapshot = initialSnapshot ?? makeSnapshot()
  const listeners = new Set<(next: AppState) => void>()
  const networkListeners = new Set<(next: NetworkSnapshot) => void>()
  const revealListeners = new Set<(target: NetworkReveal) => void>()
  const catchUpListeners = new Set<() => void>()
  let secrets = 0

  const pushNetwork = (patch: Partial<NetworkSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of Array.from(networkListeners)) listener(structuredClone(snapshot))
  }

  const push = (patch: Partial<AppState>): void => {
    state = { ...state, ...patch }
    // Copy first: a listener may unsubscribe itself while being notified.
    for (const listener of Array.from(listeners)) listener(structuredClone(state))
  }

  const account = (did: string): Account | undefined => state.accounts.find((a) => a.did === did)

  const api: StatuskyBridge = {
    State: {
      get: vi.fn(async () => structuredClone(state)),

      onChanged: vi.fn((listener: (next: AppState) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      })
    },

    Accounts: {
      add: vi.fn(async (input: string) => {
        if (resolveError) throw new Error(resolveError)
        const profile = resolves ?? makeProfile({ handle: input.replace(/^@/, '').toLowerCase() })
        if (account(profile.did)) throw new Error(`@${profile.handle} is already being tracked.`)
        const added = makeAccount({
          did: profile.did,
          handle: profile.handle,
          displayName: profile.displayName,
          avatar: profile.avatar,
          description: profile.description
        })
        push({ accounts: [...state.accounts, added] })
        return added
      }),

      remove: vi.fn(async (did: string) => {
        const target = account(did)
        if (!target) throw new Error('That account is not being tracked.')
        if (target.builtin) {
          throw new Error('Built-in status accounts can be muted but not removed.')
        }
        push({
          accounts: state.accounts.filter((a) => a.did !== did),
          posts: state.posts.filter((p) => p.authorDid !== did)
        })
      }),

      patch: vi.fn(async (did: string, patch: AccountPatch) => {
        const target = account(did)
        if (!target) throw new Error('That account is not being tracked.')
        const next = { ...target, ...patch }
        push({ accounts: state.accounts.map((a) => (a.did === did ? next : a)) })
        return next
      })
    },

    Preferences: {
      patch: vi.fn(async (patch: Partial<Settings>) => {
        const next: Settings = { ...state.settings, ...patch }
        push({ settings: next })
        return next
      })
    },

    Feed: {
      refresh: vi.fn(async () => {
        push({ sync: { ...state.sync, status: 'idle', lastSyncedAt: new Date().toISOString() } })
      }),

      markRead: vi.fn(async (uris: string[]) => {
        const read = new Set(uris)
        push({ unread: state.unread.filter((uri) => !read.has(uri)) })
      }),

      // The real model holds a cursor per source; over a flat `unread` list the same
      // statement is "drop everything posted no later than this one".
      markReadThrough: vi.fn(async (uri: string) => {
        const target = state.posts.find((post) => post.uri === uri)
        if (!target) return
        const through = Date.parse(target.createdAt)
        const stillUnread = new Set(
          state.posts.filter((post) => Date.parse(post.createdAt) > through).map((post) => post.uri)
        )
        push({ unread: state.unread.filter((entry) => stillUnread.has(entry)) })
      }),

      markAllRead: vi.fn(async () => {
        push({ unread: [] })
      })
    },

    Actors: {
      resolve: vi.fn(async (input: string) => {
        if (resolveError) throw new Error(resolveError)
        return resolves ?? makeProfile({ handle: input })
      })
    },

    Webhook: {
      // The real receiver mints a new secret and re-publishes; the double only has to
      // produce a different URL, which is what the panel renders.
      regenerateSecret: vi.fn(async () => {
        const webhook: WebhookStatus = {
          ...state.webhook,
          url: state.webhook.url ? state.webhook.url.replace(/[^/]+$/, `secret${++secrets}`) : null
        }
        push({ webhook })
        return webhook
      })
    },

    Network: {
      get: vi.fn(async () => structuredClone(snapshot)),

      // The real monitor sweeps and pushes as it goes; the double finishes at once.
      run: vi.fn(async () => {
        pushNetwork({ running: false, finishedAt: new Date().toISOString() })
      }),

      onChanged: vi.fn((listener: (next: NetworkSnapshot) => void) => {
        networkListeners.add(listener)
        return () => {
          networkListeners.delete(listener)
        }
      }),

      onReveal: vi.fn((listener: (target: NetworkReveal) => void) => {
        revealListeners.add(listener)
        return () => {
          revealListeners.delete(listener)
        }
      })
    },

    Popover: {
      online: vi.fn(async () => undefined),
      reduceMotion: vi.fn(async () => undefined),
      // The real one pops up a menu the OS drew, which a component test has no way to
      // see and no business drawing. What a test asserts is that the right-click asked
      // for one, and for which update.
      postMenu: vi.fn(async () => undefined),

      onCatchUp: vi.fn((listener: () => void) => {
        catchUpListeners.add(listener)
        return () => {
          catchUpListeners.delete(listener)
        }
      })
    },

    Host: {
      openExternal: vi.fn(async () => undefined),
      copyText: vi.fn(async () => undefined),
      hideWindow: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      sendTestNotification: vi.fn(async () => undefined),
      getPlatform: vi.fn(async () => platform)
    }
  }

  const target = globalThis as Record<string, unknown>
  const previous = target.statusky
  target.statusky = api

  return {
    api,
    get state(): AppState {
      return state
    },
    push,
    get snapshot(): NetworkSnapshot {
      return snapshot
    },
    pushNetwork,
    reveal(serviceId: string | null): void {
      for (const listener of Array.from(revealListeners)) listener({ serviceId })
    },
    catchUp(): void {
      for (const listener of Array.from(catchUpListeners)) listener()
    },
    listenerCount: () => listeners.size,
    pushListenerCount: () => networkListeners.size + revealListeners.size + catchUpListeners.size,
    restore(): void {
      listeners.clear()
      networkListeners.clear()
      revealListeners.clear()
      catchUpListeners.clear()
      if (previous === undefined) delete target.statusky
      else target.statusky = previous
    }
  }
}
