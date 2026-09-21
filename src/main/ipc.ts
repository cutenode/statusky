import { clipboard, shell } from 'electron'
import type { WebContents } from 'electron'
import {
  Accounts,
  Actors,
  Feed,
  Host,
  Network,
  Preferences,
  State,
  Webhook,
  type INetworkDispatcher,
  type IStateDispatcher
} from '@ipc/browser/statusky'
import type { AccountPatch, AppState, NetworkSnapshot, Platform, Settings } from '../shared/types'
import type { Model } from './model'
import { notifyTest } from './notifications'
import type { PopoverWindow } from './window'

export interface IpcDeps {
  model: Model
  popover: PopoverWindow
  onQuit(): void
}

export interface IpcController {
  /** Push a fresh snapshot to the popover, if one is currently attached. */
  publish(state: AppState): void
  /** Push the network dashboard to the popover. */
  publishNetwork(snapshot: NetworkSnapshot): void
  /** Ask the popover to show the network dashboard, at one service if given. */
  revealNetwork(serviceId: string | null): void
}

/**
 * Implement the interfaces declared in `schemas/statusky.eipc`.
 *
 * There is no channel plumbing here on purpose: the generated wiring in `src/ipc`
 * registers the handlers, checks that every call came from the popover's own origin,
 * and validates each argument and return value against the Zod schemas before and
 * after these functions run. What is left is the actual behaviour.
 *
 * Failures are thrown rather than returned. The generated client rejects with the
 * message, and the renderer unwraps it back into the text the user sees.
 */
export function registerIpc({ model, popover, onQuit }: IpcDeps): IpcController {
  let state: IStateDispatcher | null = null
  let network: INetworkDispatcher | null = null

  const attach = (contents: WebContents): void => {
    // Bind to the WebContents rather than to `mainFrame`: the frame object is replaced
    // on every reload, which in development happens on every save.
    state = State.for(contents).setImplementation({
      get: () => model.getState()
    })

    Accounts.for(contents).setImplementation({
      add: (input: string) => model.addAccount(input),
      remove: (did: string) => model.removeAccount(did),
      patch: (did: string, patch: AccountPatch) => model.patchAccount(did, patch)
    })

    Preferences.for(contents).setImplementation({
      patch: (patch: Partial<Settings>) => model.patchSettings(patch)
    })

    Feed.for(contents).setImplementation({
      refresh: () => model.refresh(),
      markRead: (uris: string[]) => model.markRead(uris),
      markReadThrough: (uri: string) => model.markReadThrough(uri),
      markAllRead: () => model.markAllRead()
    })

    Actors.for(contents).setImplementation({
      resolve: (input: string) => model.resolveActor(input)
    })

    Webhook.for(contents).setImplementation({
      regenerateSecret: () => model.regenerateWebhookSecret()
    })

    network = Network.for(contents).setImplementation({
      get: () => model.networkSnapshot(),
      run: () => model.runNetworkChecks()
    })

    Host.for(contents).setImplementation({
      async openExternal(url: string) {
        // Never hand an arbitrary scheme to the OS — `file:` and custom schemes can
        // launch local handlers, and the URL here ultimately comes from remote posts.
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('Only http and https links can be opened.')
        }
        await shell.openExternal(parsed.toString())
      },
      // The webhook endpoint is long, secret and useless retyped, so it has to be
      // copyable — and the renderer's own clipboard access is unreliable inside a
      // popover that loses focus the moment a dialog opens.
      copyText: (text: string) => clipboard.writeText(text),
      hideWindow: () => popover.hide(),
      quit: () => onQuit(),
      sendTestNotification: () => notifyTest(model.settings),
      getPlatform: () => process.platform as Platform
    })
  }

  // Re-attach whenever the popover is (re)created: a menu bar app closes and reopens
  // its window, and each new window is a new WebContents with no handlers on it.
  popover.onCreate((window) => attach(window.webContents))

  return {
    publish(next: AppState): void {
      state?.dispatchChanged(next)
    },
    publishNetwork(snapshot: NetworkSnapshot): void {
      network?.dispatchChanged(snapshot)
    },
    revealNetwork(serviceId: string | null): void {
      network?.dispatchReveal({ serviceId })
    }
  }
}
