import { join } from 'node:path'
import { app, dialog, nativeTheme, net } from 'electron'
import { IPC_ENVIRONMENT } from '@ipc/environment'
import { probeServiceId } from '../shared/network'
import { snoozeEnd } from '../shared/notify'
import type { AppState } from '../shared/types'
import {
  deepLinkFromCommandLine,
  openDeepLink,
  registerProtocolClient,
  watchDeepLinks,
  type DeepLinkTarget
} from './deep-link'
import { registerIpc } from './ipc'
import { applyLoginItem, readLoginItem } from './login-item'
import { configureAboutPanel, installApplicationMenu } from './menu'
import { Model } from './model'
import { createNotifier } from './notifications'
import { watchPower } from './power'
import type { ProbeTransport } from './probes'
import { denyRendererPermissions, registerAppScheme, serveRenderer } from './protocol'
import { applyGlobalShortcut, releaseGlobalShortcut } from './shortcut'
import { handleSquirrelEvent } from './squirrel'
import { createStore } from './store'
import { TrayController } from './tray'
import { watchUpdates } from './update'
import { followDisplayChanges, PopoverWindow } from './window'

/**
 * The network checks go through Chromium's network stack rather than Node's, so they
 * take the same route a browser tab would — system proxy, certificate store and all.
 * That is the point of measuring from here: it tests the user's own path to each
 * service, the way status.feeds.blue does from the page.
 */
const chromiumTransport: ProbeTransport = {
  fetch: (url, init) => net.fetch(url, init),
  openSocket: (url) => new net.WebSocket(url)
}

/**
 * Put the theme preference to Chromium; the renderer mirrors it onto its `dark` class
 * via `prefers-color-scheme`.
 *
 * High contrast is a third theme rather than a shade of the other two, and it is on a
 * separate axis the preference cannot express. When Windows is in a high-contrast mode,
 * the OS has already chosen light or dark as part of that mode, and a pinned `light` or
 * `dark` here would overrule it — leaving the app light inside a high-contrast dark
 * desktop, which is both wrong and precisely the kind of wrong somebody who turns high
 * contrast on cannot afford. So while it is on, the pin stands down and the app follows
 * the system. The stored setting is not touched and comes straight back when the mode
 * goes off; this is the same principle as the tray declining to beat under reduced
 * motion, and for the same reason — the app adapts, the user's preference stays theirs.
 */
function applyTheme(state: AppState): void {
  nativeTheme.themeSource = nativeTheme.shouldUseHighContrastColors
    ? 'system'
    : state.settings.theme
}

const PRODUCTION_WIRING_UNPACKAGED =
  'IPC wiring mismatch: this build contains production IPC wiring, but the app is ' +
  'running unpackaged (app.isPackaged is false). The production origin validator only ' +
  'accepts a packaged app, so every IPC call from the popover will be refused as ' +
  'failing origin validation. Run `npm start` or `npm run dev` instead; both generate ' +
  'development wiring before they run.'

const DEVELOPMENT_WIRING_PACKAGED =
  'IPC wiring mismatch: this packaged app was built with development IPC wiring ' +
  '(app.isPackaged is true). The development origin validator only accepts an ' +
  'unpackaged app, so every IPC call from the popover will be refused as failing origin ' +
  'validation. Rebuild with `npm run build`, which generates production wiring, and ' +
  'package it again.'

/**
 * The generated wiring contains one branch of the `PopoverOnly` validator, chosen when
 * it was generated: production accepts only a packaged app, development only an
 * unpackaged one. With the wrong branch, every IPC call is refused with an error that
 * blames the origin and never mentions `app.isPackaged`, the check that actually failed.
 * This names the real cause, once per launch.
 *
 * An unpackaged app is started from a terminal, which is where `console.error` goes, so
 * the log is enough there. A packaged menu bar app has no console anyone will see, so it
 * also gets a dialog. The dialog is not awaited and nothing waits on it: the tray,
 * polling and notifications all work without IPC, so startup continues either way.
 */
function reportWiringMismatch(): void {
  // A ternary on purpose: packaging finds the generated validator by its comparison of
  // `isPackaged` with a boolean, and a comparison here would look like a second one.
  const running = app.isPackaged ? 'production' : 'development'
  if (IPC_ENVIRONMENT === running) return

  if (running === 'development') {
    console.error(PRODUCTION_WIRING_UNPACKAGED)
    return
  }

  console.error(DEVELOPMENT_WIRING_PACKAGED)
  void dialog.showMessageBox({
    type: 'error',
    title: 'Statusky',
    message: 'Statusky was packaged with development IPC wiring',
    detail: DEVELOPMENT_WIRING_PACKAGED
  })
}

// Chromium reads the privileged-scheme table exactly once, before it is ready, so
// this cannot wait for `bootstrap()`.
registerAppScheme()

// And nor can this: a `statusky://` link that *launched* the app is delivered as
// `open-url` the moment the app is ready, and Electron does not hold it for a listener
// that is not there yet. The watcher takes the URL now and hands it over in `bootstrap`,
// once there is a popover to show. See src/main/deep-link.ts.
const deepLinks = watchDeepLinks()

if (handleSquirrelEvent()) {
  // Not a launch a user asked for: Squirrel.Windows runs the app with a switch to tell
  // it that it has just been installed, updated or removed. The handler has written the
  // Start Menu shortcut (or taken it away) and there is nothing else this process is
  // for, so it must go without ever reaching the menu bar.
  app.quit()
} else if (!app.requestSingleInstanceLock()) {
  // A tray app should never have a second copy fighting over the same icon.
  app.quit()
} else {
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  // No dock icon: this lives in the menu bar.
  app.dock?.hide()
  app.setAppUserModelId('community.statusky.app')

  await app.whenReady()

  // The packaged renderer is served over app://statusky so that the IPC layer has a
  // real origin to validate against. In development electron-vite's server does it.
  if (!process.env.ELECTRON_RENDERER_URL) {
    serveRenderer(join(import.meta.dirname, '../renderer'))
  }

  // Before any page exists to ask: the popover needs no camera, microphone, location
  // or renderer-side notifications, and Chromium decides for itself if nothing says so.
  denyRendererPermissions()

  // Before the first window too, and for the same kind of reason. Electron installs a
  // default application menu when nothing else does, and although an LSUIElement app
  // never draws one, its accelerators are live — the default's Cmd+R was eating the
  // renderer's own. The About panel is configured first because the menu opens it.
  configureAboutPanel()
  installApplicationMenu()

  const store = createStore()
  const model = new Model(store, app.getVersion(), { network: { transport: chromiumTransport } })
  const popover = new PopoverWindow()

  /** Open the popover on the network dashboard, scrolled to one service if given. */
  const showNetwork = (serviceId: string | null): void => {
    popover.show(tray.bounds())
    ipc.revealNetwork(serviceId)
  }

  /** Open the popover on the Timeline, which is the tab that catches you up. */
  const showTimeline = (): void => {
    popover.show(tray.bounds())
    ipc.catchUp()
  }

  const quit = (): void => {
    model.stop()
    tray.destroy()
    app.quit()
  }

  /**
   * Somebody dragged text onto the menu bar icon. See `drop-text` in src/main/tray.ts.
   *
   * Handed straight to `addAccount`, which already parses a handle, a DID or a bsky.app
   * profile link and refuses anything else — so the validation is the one that is
   * already right rather than a second, weaker copy of it here.
   *
   * Both outcomes have to be visible, and neither can be a notification: the gesture is
   * deliberate and immediate, and on this platform a notification is the one channel
   * that may be silently unavailable (see `explainFailure`). Success opens the popover,
   * which is both a confirmation and where the new source's updates are about to appear.
   * Failure says so in a dialog, because a drag that lands on the icon and produces
   * absolutely nothing is indistinguishable from the feature not existing — and the
   * sentence `addAccount` throws is already written for a person. What was dropped is
   * quoted back, trimmed, since a drag can carry a paragraph and the reason it failed is
   * usually visible in the first few words of it.
   */
  const watchDropped = (text: string): void => {
    void model
      .addAccount(text)
      .then(() => popover.show(tray.bounds()))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        const dropped = text.replace(/\s+/g, ' ').trim()
        void dialog.showMessageBox({
          type: 'warning',
          title: 'Statusky',
          message: 'Statusky could not watch that',
          detail: `${reason}\n\nDropped: ${
            dropped.length > 80 ? `${dropped.slice(0, 79)}…` : dropped
          }`
        })
      })
  }

  const tray = new TrayController({
    popover,
    onRefresh: () => void model.refresh(),
    onMarkAllRead: () => model.markAllRead(),
    onRunNetworkChecks: () => void model.runNetworkChecks(),
    onShowNetwork: () => showNetwork(null),
    onDropText: watchDropped,
    onSnooze: (choice) =>
      void model.patchSettings({
        notificationsSnoozedUntil: choice
          ? snoozeEnd(choice, model.settings, new Date()).toISOString()
          : null
      }),
    onQuit: quit
  })

  /**
   * Only re-register the login item when the preference actually changes: registering
   * hits the OS every call — a write to the login item database, or a file written into
   * `~/.config/autostart` — and it fails noisily in dev, where the binary is not a
   * registerable app bundle. `loginItemApplied` starts as what the OS says rather than
   * as the setting, which is how a registration that has drifted away from the
   * preference gets re-applied instead of assumed to still be there. See
   * src/main/login-item.ts, which is where the platforms differ.
   */
  let loginItemApplied: boolean | null = null
  const syncLoginItem = (openAtLogin: boolean): void => {
    if (openAtLogin === loginItemApplied) return
    loginItemApplied = openAtLogin
    // Not logged and forgotten: `applyLoginItem` reads back what the OS really did, and
    // a refusal has to reach the Settings panel, because the toggle is otherwise left
    // saying yes to something that will not happen.
    model.setLoginItem(applyLoginItem(openAtLogin))
  }

  /**
   * And the same again for the global shortcut, for the same reason and with one
   * difference: there is nothing to read back. The OS has no "who owns this combination"
   * to ask, so the only way to find out is to try to register it — which means this is
   * the one place that knows, and `model.setShortcut` is how the Settings panel is told.
   * A shortcut another application already owns is invisible otherwise: the key just
   * does somebody else's thing. See src/main/shortcut.ts.
   */
  let shortcutApplied: string | null = null
  const syncShortcut = (accelerator: string): void => {
    if (accelerator === shortcutApplied) return
    shortcutApplied = accelerator
    // The popover, summoned from anywhere and put away by the same keystroke — a
    // shortcut that only ever opens is a shortcut you have to reach for the mouse to
    // undo.
    model.setShortcut(applyGlobalShortcut(accelerator, () => popover.toggle(tray.bounds())))
  }

  model.on('change', (state) => {
    tray.update(state)
    ipc.publish(state)
    applyTheme(state)
    syncLoginItem(state.settings.launchAtLogin)
    syncShortcut(state.settings.globalShortcut)
  })

  model.on('network', (snapshot) => ipc.publishNetwork(snapshot))

  /**
   * Banners go through here rather than straight to the OS, so that the ones raised
   * while nobody is at the machine can be held back and summarised into one on the way
   * in. `presence` is wired up below, after the tray and the popover it needs exist;
   * nothing can reach `away()` before then, because nothing notifies before
   * `model.start()`.
   */
  const notifier = createNotifier(() => model.settings, {
    away: () => presence.away(),
    stillWorthSaying: (posts) => model.stillUnread(posts),
    onOpened: (post) => {
      model.markRead([post.uri])
      // An outage the checks measured has no web page; its place is the dashboard.
      const serviceId = probeServiceId(post)
      if (serviceId) showNetwork(serviceId)
    },
    onCatchUp: showTimeline,
    // The banner's own buttons. *Mark as read* deliberately opens nothing at all: the
    // whole point of it is that the update can be dealt with without the machine taking
    // the screen away from whatever is on it.
    onMarkRead: (post) => model.markRead([post.uri]),
    onShowNetwork: showNetwork,
    onFailed: (reason) => console.warn('The system refused a notification:', reason)
  })

  model.on('notify', (posts) => notifier.notify(posts))
  // Resuming from a snooze or shortening quiet hours in Settings should not leave what
  // they were holding back waiting for a timer. Cheap when nothing is held, which is
  // nearly always, so every state change can ask.
  model.on('change', () => notifier.reconsider())

  tray.create()
  const ipc = registerIpc({
    model,
    popover,
    onQuit: quit,
    // The popover is the only part of this app that can read the OS's reduced-motion
    // preference, and the tray icon is the thing that has to honour it.
    onReduceMotion: (reduce) => tray.setReducedMotion(reduce),
    // A right-click menu's *Show on the network dashboard* lands in the same place a
    // notification's does.
    onShowNetwork: showNetwork
  })
  popover.create()

  // `show()` places the popover against the displays as they are at that moment, which
  // is enough until they change while it is open: undocking a laptop or unplugging a
  // projector can strand it somewhere no display covers. After `tray.create()`,
  // because it anchors to the icon the same way `show()` does.
  followDisplayChanges(popover, () => tray.bounds())

  applyTheme(model.getState())
  // High contrast is switched on and off while the app is running — it is a mode people
  // turn on to read something difficult and off again afterwards — and `updated` is the
  // only notice of it there is. Re-applying is what stands the theme pin down when it
  // comes on and hands it back when it goes off. It re-enters once through the write
  // above and then settles, because the answer depends only on the mode and the setting.
  nativeTheme.on('updated', () => applyTheme(model.getState()))

  tray.update(model.getState())
  loginItemApplied = readLoginItem()
  model.setLoginItem({ registered: loginItemApplied, error: null })

  // Asked for at startup rather than waited for: the shortcut is off by default, so for
  // anybody who has turned it on the next `change` is a poll result a couple of minutes
  // away, and until then the key they chose would do nothing.
  syncShortcut(model.settings.globalShortcut)

  /**
   * The `statusky://` scheme, in both directions it can arrive from.
   *
   * Everything a link may ask for is one of these four calls, and nothing it carries is
   * ever loaded, navigated to or forwarded to the page: `openDeepLink` turns a URL into
   * one of a closed set of intentions and a service id it has checked against what this
   * app actually measures. It shares a word with the `app://statusky` origin the IPC
   * layer trusts and has nothing else whatsoever in common with it — see the header of
   * src/main/deep-link.ts.
   */
  const deepLinkTarget: DeepLinkTarget = {
    open: () => popover.show(tray.bounds()),
    timeline: showTimeline,
    network: showNetwork,
    knows: (serviceId) =>
      model.networkSnapshot().services.some((service) => service.id === serviceId)
  }

  deepLinks.route((url) => void openDeepLink(url, deepLinkTarget))
  // Windows has no `open-url` and Forge writes no registry entries, so the running app
  // claims the scheme itself, every launch. The `'--'` is a security mitigation rather
  // than a formality; `registerProtocolClient` says why, and it is a no-op everywhere
  // else.
  registerProtocolClient()

  /**
   * Everything the OS will tell us about this machine, and what it costs us to listen:
   * the schedules go down with the lid, widen on battery, stand aside while the machine
   * is too hot to measure from, and banners wait for somebody to be there to see them.
   * See src/main/power.ts, which is where all of that is decided.
   *
   * Before `model.start()` on purpose: the first sweep is booked in there, and a laptop
   * that has been on battery since breakfast should be treated as one by then rather
   * than after the user next happens to plug in and out.
   */
  const presence = watchPower({
    suspend: () => model.pause(),
    resume: () => {
      model.resume()
      // A machine coming back has a stale feed and stale measurements. If the Wi-Fi is
      // not back yet, the checks notice they are offline and retry until it is.
      void model.refresh()
      void model.runNetworkChecks()
    },
    restrain: (restraint) => model.restrainNetwork(restraint),
    returned: () => notifier.release(),
    // The OS asking politely before a logout or a reboot. Same teardown as the tray's
    // Quit, because it is the same thing happening for a different reason.
    shutdown: quit
  })

  model.start()

  /**
   * Keeping this install up to date, in whichever of the two ways it can be.
   *
   * On macOS and Windows this is a real background download and a restart; everywhere
   * else — and on those two whenever Squirrel turns out to be unable to do it, which
   * includes every ad-hoc signed local build — it is a slow check against GitHub and a
   * sentence telling the user to go and fetch the new one. Exactly one of the two is
   * ever running, and src/main/update.ts is where that is decided and why.
   *
   * Neither of them ever raises a notification. The result lands on `AppState.update`,
   * which the tray menu and the Settings panel read; see `UpdateStatus`.
   */
  const updates = watchUpdates({
    onAvailable: (version) => model.setUpdate({ stage: 'available', version }),
    onReady: (version) => model.setUpdate({ stage: 'ready', version })
  })

  /**
   * A second copy of the app starting, which on Windows and Linux is how a deep link
   * arrives while the app is already running: the OS launches the registered handler
   * with the URL appended, the single-instance lock turns that launch into this event,
   * and the URL is the last thing on its command line. Without a link it is somebody
   * running the app again, which means they want to see it.
   */
  app.on('second-instance', (_event, commandLine) => {
    const url = deepLinkFromCommandLine(commandLine)
    if (url) openDeepLink(url, deepLinkTarget)
    else popover.show(tray.bounds())
  })

  app.on('activate', () => popover.show())

  // Registering any listener here suppresses Electron's default "quit when the
  // last window closes" behaviour, which is wrong for a menu bar app: the popover
  // is hidden, not closed, and the tray icon must outlive it.
  app.on('window-all-closed', () => {})

  app.on('before-quit', () => {
    model.stop()
    updates.stop()
    // A banner held for a snooze or a grace period has no business going up on the way out.
    notifier.dispose()
  })

  // A global shortcut is held against the whole session rather than against this
  // window, and `will-quit` is the last event before the process goes. Left registered,
  // the combination can stay dead for other applications until the user logs out.
  app.on('will-quit', () => releaseGlobalShortcut())

  // Last, so the app is fully up before a dialog can appear. On macOS a message box with
  // no parent window runs modally. This still happens in the same task that started
  // loading the popover, so the log comes before the first refused call.
  reportWiringMismatch()
}
