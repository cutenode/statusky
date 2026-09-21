import { join } from 'node:path'
import { app, dialog, nativeTheme, net, powerMonitor } from 'electron'
import { IPC_ENVIRONMENT } from '@ipc/environment'
import { probeServiceId } from '../shared/network'
import type { AppState } from '../shared/types'
import { registerIpc } from './ipc'
import { Model } from './model'
import { notifyPosts } from './notifications'
import type { ProbeSocket, ProbeTransport } from './probes'
import { registerAppScheme, serveRenderer } from './protocol'
import { createStore } from './store'
import { TrayController } from './tray'
import { PopoverWindow } from './window'

/**
 * The network checks go through Chromium's network stack rather than Node's, so they
 * take the same route a browser tab would — system proxy, certificate store and all.
 * That is the point of measuring from here: it tests the user's own path to each
 * service, the way status.feeds.blue does from the page.
 */
const chromiumTransport: ProbeTransport = {
  fetch: (url, init) => net.fetch(url, init),
  // The DOM's WebSocket types its handlers more narrowly than the checks need.
  openSocket: (url) => new net.WebSocket(url) as unknown as ProbeSocket
}

/** The renderer mirrors this onto its `dark` class via `prefers-color-scheme`. */
function applyTheme(state: AppState): void {
  nativeTheme.themeSource = state.settings.theme
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

// A tray app should never have a second copy fighting over the same icon.
if (!app.requestSingleInstanceLock()) {
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

  const store = createStore()
  const model = new Model(store, app.getVersion(), { network: { transport: chromiumTransport } })
  const popover = new PopoverWindow()

  /** Open the popover on the network dashboard, scrolled to one service if given. */
  const showNetwork = (serviceId: string | null): void => {
    popover.show(tray.bounds())
    ipc.revealNetwork(serviceId)
  }

  const quit = (): void => {
    model.stop()
    tray.destroy()
    app.quit()
  }

  const tray = new TrayController({
    popover,
    onRefresh: () => void model.refresh(),
    onMarkAllRead: () => model.markAllRead(),
    onRunNetworkChecks: () => void model.runNetworkChecks(),
    onShowNetwork: () => showNetwork(null),
    onQuit: quit
  })

  // Only re-register the login item when the preference actually changes:
  // `setLoginItemSettings` hits the OS every call and fails noisily in dev,
  // where the binary is not a registerable app bundle.
  let loginItemApplied: boolean | null = null
  const syncLoginItem = (openAtLogin: boolean): void => {
    if (openAtLogin === loginItemApplied) return
    loginItemApplied = openAtLogin
    try {
      app.setLoginItemSettings({ openAtLogin })
    } catch (error) {
      console.warn('Could not update the login item:', error)
    }
  }

  model.on('change', (state) => {
    tray.update(state)
    ipc.publish(state)
    applyTheme(state)
    syncLoginItem(state.settings.launchAtLogin)
  })

  model.on('network', (snapshot) => ipc.publishNetwork(snapshot))

  model.on('notify', (posts) => {
    notifyPosts(posts, model.settings, {
      onOpened: (post) => {
        model.markRead([post.uri])
        // An outage the checks measured has no web page; its place is the dashboard.
        const serviceId = probeServiceId(post)
        if (serviceId) showNetwork(serviceId)
      },
      onFailed: (reason) => console.warn('The system refused a notification:', reason)
    })
  })

  tray.create()
  const ipc = registerIpc({ model, popover, onQuit: quit })
  popover.create()

  applyTheme(model.getState())
  tray.update(model.getState())
  loginItemApplied = app.getLoginItemSettings().openAtLogin
  model.start()

  // A laptop waking from sleep has a stale feed and stale measurements. If the Wi-Fi is
  // not back yet, the checks notice they are offline and retry until it is.
  const wake = (): void => {
    void model.refresh()
    void model.runNetworkChecks()
  }
  powerMonitor.on('resume', wake)
  powerMonitor.on('unlock-screen', wake)

  app.on('second-instance', () => popover.show())
  app.on('activate', () => popover.show())

  // Registering any listener here suppresses Electron's default "quit when the
  // last window closes" behaviour, which is wrong for a menu bar app: the popover
  // is hidden, not closed, and the tray icon must outlive it.
  app.on('window-all-closed', () => {})

  app.on('before-quit', () => {
    model.stop()
  })

  // Last, so the app is fully up before a dialog can appear. On macOS a message box with
  // no parent window runs modally. This still happens in the same task that started
  // loading the popover, so the log comes before the first refused call.
  reportWiringMismatch()
}
