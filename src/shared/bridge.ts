import type {
  IAccountsRenderer,
  IActorsRenderer,
  IFeedRenderer,
  IHostRenderer,
  INetworkRenderer,
  IPopoverRenderer,
  IPreferencesRenderer,
  IStateRenderer,
  IWebhookRenderer
} from '@ipc/common/statusky'

/** Everything the preload exposes on `window.statusky`, as declared in the schema. */
export interface StatuskyBridge {
  State: IStateRenderer
  Accounts: IAccountsRenderer
  Preferences: IPreferencesRenderer
  Feed: IFeedRenderer
  Actors: IActorsRenderer
  Webhook: IWebhookRenderer
  Network: INetworkRenderer
  Host: IHostRenderer
  Popover: IPopoverRenderer
}

/**
 * Reach the bridge.
 *
 * The generated `@ipc/renderer/statusky` module reads `window.statusky` once, at import
 * time. Reading it per call instead means the UI sees whatever bridge is actually
 * installed — which is what makes the components testable against a double — and gives
 * one place to turn "the preload exposed nothing" into a sentence rather than a
 * `Cannot read properties of undefined`.
 *
 * That absence is not hypothetical: the preload only exposes the API to a frame that
 * passes the origin check in `schemas/statusky.eipc`, so any page that is not the
 * popover gets exactly this error.
 */
export function bridge(): StatuskyBridge {
  // `globalThis`, not `window`: this module is shared with the main-process side of the
  // tests, which type-checks without the DOM lib. In a renderer they are the same object.
  const exposed = (globalThis as { statusky?: StatuskyBridge }).statusky
  if (!exposed) {
    throw new Error('This page is not allowed to talk to Statusky.')
  }
  return exposed
}

/**
 * The user-facing text behind a failed IPC call.
 *
 * Main throws plain `Error`s with messages written for people ("Only http and https
 * links can be opened."). Electron wraps those on the way across, prefixing the channel
 * — which for this app is a build-random string nobody wants to read. Strip the wrapper
 * and keep the sentence.
 */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^\w*Error:\s*/, '')
}
