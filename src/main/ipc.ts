import { clipboard, net, shell } from 'electron'
import type { WebContents } from 'electron'
import {
  Accounts,
  Actors,
  Feed,
  Host,
  Network,
  Popover,
  Preferences,
  ProbeTargetsFile,
  State,
  Webhook,
  type INetworkDispatcher,
  type IPopoverDispatcher,
  type IStateDispatcher
} from '@ipc/browser/statusky'
import type { AppState, NetworkSnapshot } from '../shared/types'
import { showPostMenu } from './context-menu'
import type { Model } from './model'
import { notifyTest } from './notifications'
import { probeTargetsFile } from './probe-targets-file'
import type { PopoverWindow } from './window'

export interface IpcDeps {
  model: Model
  popover: PopoverWindow
  onQuit(): void
  /** The OS's reduced-motion preference, which only a page can read. See `Popover`. */
  onReduceMotion(reduce: boolean): void
  /**
   * Show the dashboard at one service. The same route the tray menu and a notification
   * take, handed in rather than reached for, because showing the popover and revealing a
   * service is two things and only src/main/index.ts owns both.
   */
  onShowNetwork(serviceId: string): void
}

export interface IpcController {
  /** Push a fresh snapshot to the popover, if one is currently attached. */
  publish(state: AppState): void
  /** Push the network dashboard to the popover. */
  publishNetwork(snapshot: NetworkSnapshot): void
  /** Ask the popover to show the network dashboard, at one service if given. */
  revealNetwork(serviceId: string | null): void
  /** Ask the popover to show the Timeline, which is the tab that catches you up. */
  catchUp(): void
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
 *
 * The parameters below are left unannotated on purpose, so they take their types from
 * the generated `I*Impl` interfaces. Those declare methods, and TypeScript checks a
 * method's parameters in both directions, so an annotation here could claim a narrower
 * type than the validator actually admits and nothing would say so.
 */
export function registerIpc({
  model,
  popover,
  onQuit,
  onReduceMotion,
  onShowNetwork
}: IpcDeps): IpcController {
  let state: IStateDispatcher | null = null
  let network: INetworkDispatcher | null = null
  let page: IPopoverDispatcher | null = null
  /** The page those dispatchers were bound to, so a destroyed one is not written to. */
  let attached: WebContents | null = null
  // Built once rather than per window, so its one-dialog-at-a-time rule outlives a reload.
  const targetsFile = probeTargetsFile({ model, popover })

  const attach = (contents: WebContents): void => {
    attached = contents
    // Bind to the WebContents rather than to `mainFrame`: the frame object is replaced
    // on every reload, which in development happens on every save.
    state = State.for(contents).setImplementation({
      get: () => model.getState()
    })

    Accounts.for(contents).setImplementation({
      add: (input) => model.addAccount(input),
      remove: (did) => model.removeAccount(did),
      patch: (did, patch) => model.patchAccount(did, patch)
    })

    Preferences.for(contents).setImplementation({
      patch: (patch) => model.patchSettings(patch)
    })

    Feed.for(contents).setImplementation({
      refresh: () => model.refresh(),
      markRead: (uris) => model.markRead(uris),
      markReadThrough: (uri) => model.markReadThrough(uri),
      markAllRead: () => model.markAllRead()
    })

    Actors.for(contents).setImplementation({
      resolve: (input) => model.resolveActor(input)
    })

    Webhook.for(contents).setImplementation({
      regenerateSecret: () => model.regenerateWebhookSecret()
    })

    ProbeTargetsFile.for(contents).setImplementation({
      save: () => targetsFile.save(),
      open: () => targetsFile.open()
    })

    network = Network.for(contents).setImplementation({
      get: () => model.networkSnapshot(),
      run: () => model.runNetworkChecks()
    })

    page = Popover.for(contents).setImplementation({
      /**
       * Chromium noticed the connection change. This is a page reporting on the world,
       * so it is taken as a hint and never as an instruction: only the claim that we are
       * back is worth acting on at all, and even that is put to `net.online` — main's
       * own read — before the checks are asked to look again. A page insisting we are
       * offline is ignored outright, because believing it would let the renderer stop
       * the measurements, and the control group is what decides that.
       */
      online: (up) => {
        if (!up || !net.online) return
        model.recheckConnection()
      },

      /**
       * The page read `prefers-reduced-motion` for us, because nothing in main can.
       *
       * Taken at face value, unlike `online` above: there is no second opinion to put it
       * to, and the two ways of being wrong are not symmetric. Believing a page that says
       * to calm down costs somebody a heartbeat they might have wanted; disbelieving it
       * flashes an icon ten times a second at somebody who asked the entire system not to.
       */
      reduceMotion: (reduce) => onReduceMotion(reduce),

      /**
       * A right-click in the feed, answered with a menu the OS drew.
       *
       * The URI is all the page sends and all it is allowed to send: main looks the
       * update up in its own state and builds every label from what it finds there, so
       * this cannot be used to put a sentence, a link or a source name of the page's
       * choosing in front of the user. See src/main/context-menu.ts.
       */
      postMenu: (uri) => showPostMenu(uri, { model, popover, onShowNetwork })
    })

    Host.for(contents).setImplementation({
      async openExternal(url) {
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
      copyText: (text) => clipboard.writeText(text),
      hideWindow: () => popover.hide(),
      quit: () => onQuit(),
      sendTestNotification: () => notifyTest(model.settings),
      getPlatform: () => process.platform
    })
  }

  // Re-attach whenever the popover is (re)created: a menu bar app closes and reopens
  // its window, and each new window is a new WebContents with no handlers on it.
  popover.onCreate((window) => attach(window.webContents))

  /**
   * Whether there is still a page at the other end of the dispatchers.
   *
   * A dispatcher is bound to one WebContents, and Electron throws from `send` on a
   * destroyed one rather than dropping the message — which would take the throw
   * straight out of a `model` event handler in `src/main/index.ts` and into the main
   * process. The popover is normally hidden rather than closed, but a renderer that
   * dies is destroyed outright so the next `show()` can rebuild it (see
   * `src/main/window.ts`), and in between the model carries on polling and publishing
   * to a window that is not there.
   */
  const live = (): boolean => attached !== null && !attached.isDestroyed()

  return {
    publish(next: AppState): void {
      if (live()) state?.dispatchChanged(next)
    },
    publishNetwork(snapshot: NetworkSnapshot): void {
      if (live()) network?.dispatchChanged(snapshot)
    },
    revealNetwork(serviceId: string | null): void {
      if (live()) network?.dispatchReveal({ serviceId })
    },
    catchUp(): void {
      if (live()) page?.dispatchCatchUp()
    }
  }
}
