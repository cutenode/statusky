import { join } from 'node:path'
import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { LATEST_RELEASE_URL } from '../shared/defaults'
import { reportHeadline } from '../shared/network'
import { formatClock, SNOOZE_CHOICES, snoozedUntil, type SnoozeChoice } from '../shared/notify'
import type { Health } from '../shared/status'
import type {
  AppState,
  NetworkSummary,
  Settings,
  TrayUnreadStyle,
  UpdateStatus
} from '../shared/types'
import { restartToUpdate } from './update'
import type { PopoverWindow } from './window'

/**
 * The default announcement is the icon beating rather than a number beside it, so one
 * cardiac cycle is played on a loop out of `BEAT_FRAMES` pre-rendered frames. 150 bpm
 * is severe tachycardia: fast enough to read as distress rather than as decoration.
 * The frames themselves come from `scripts/gen-icons.mjs`, which must agree with this
 * frame count. `Settings.trayUnreadStyle` decides whether they are played at all.
 */
const BEAT_BPM = 150
const BEAT_FRAMES = 10
const BEAT_INTERVAL_MS = Math.round(60_000 / BEAT_BPM / BEAT_FRAMES)

const BEAT_STEMS = Array.from({ length: BEAT_FRAMES }, (_, frame) => `trayBeat${frame}`)

/** Icon file stem per health state. Non-macOS platforms get the coloured variants too. */
const ICON_FOR: Record<Health, string> = {
  operational: 'trayTemplate',
  unknown: 'trayTemplate',
  // Being offline is not the Atmosphere's fault, so it gets no colour; the tooltip says.
  offline: 'trayTemplate',
  monitoring: 'trayMonitoring',
  maintenance: 'trayMonitoring',
  degraded: 'trayMonitoring',
  incident: 'trayIncident'
}

/**
 * The badged twin of each health icon, for the `dot` style. Same glyph, same colour,
 * one filled dot in the corner — so the icon still reports health while it says there
 * is something unread.
 */
const BADGED = (stem: string): string => `${stem}Dot`

/**
 * Degrade an announcement style this machine cannot honour, to the nearest one it can.
 *
 * `Tray.setTitle` is implemented on macOS and nowhere else, so asking for a count on
 * Windows or Linux would silently announce nothing at all. Badge the icon instead: it
 * is the same statement in the only form those platforms can make it.
 *
 * `beat` degrades the same way when the OS has been asked for reduced motion. Ten icon
 * swaps a second, in the corner of the screen, all day, is close to the top of the list
 * of things that setting exists to stop — it is an accessibility and a photosensitivity
 * concern, not a taste one — and `beat` is this app's *default*, so most of the people
 * it would reach never chose it. The badge says the same thing and holds still.
 *
 * Neither degradation touches `Settings.trayUnreadStyle`. The stored preference stays
 * exactly what the user picked, and starts working again the moment the machine can
 * honour it; this is the app declining to shout, not the app editing their preference.
 */
function resolveStyle(
  style: TrayUnreadStyle,
  platform: string,
  reduceMotion: boolean
): TrayUnreadStyle {
  if (style === 'count' && platform !== 'darwin') return 'dot'
  if (style === 'beat' && reduceMotion) return 'dot'
  return style
}

/** The tooltip's line about the network checks, or null when they have nothing to say. */
function networkLine(network: NetworkSummary): string | null {
  switch (network.health) {
    case 'off':
      return null
    case 'offline':
      return 'Network checks resume when you are back online'
    case 'unknown':
      return network.running ? 'Checking the network…' : null
    default:
      return `Network: ${network.reachable} of ${network.total} services reachable`
  }
}

/**
 * What the machine's own condition is doing to the sweep schedule, when it is doing
 * anything. Worth a line of its own: a tooltip saying the network was last checked forty
 * minutes ago, under a setting that says ten, otherwise reads as the app being broken.
 */
function restraintLine(network: NetworkSummary): string | null {
  if (network.health === 'off') return null
  switch (network.restraint) {
    case 'battery':
      return 'Checking less often on battery'
    case 'thermal':
      return 'Checks paused while this machine is under load'
    default:
      return null
  }
}

/**
 * `@electron/packager` copies an `extraResource` under its own basename and offers no
 * way to rename it, so the packaged copy of the repository's `resources/` keeps that
 * name rather than electron-builder's old `assets/`. Both branches now name the same
 * directory, which is the point: every icon the tray can show lives there, and a
 * mismatch here empties the menu bar rather than failing loudly.
 */
function resourcesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(import.meta.dirname, '../../resources')
}

function loadIcon(stem: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(resourcesDir(), `${stem}.png`))
  // Only the neutral icon — badged or not — is a template; the coloured ones must
  // keep their colour rather than being tinted to the menu bar's foreground.
  image.setTemplateImage(stem.startsWith('trayTemplate'))
  return image
}

/**
 * What the icon shows while text is being dragged onto it.
 *
 * Written beside the icon with `setTitle`, which is the only thing this app can change
 * about the menu bar quickly enough to be feedback: the icon itself is a health report
 * and turning it into something else for the duration of a drag would be saying
 * something untrue about the network. A `+` next to a menu bar item is what macOS uses
 * everywhere else to mean "let go here and this gets added", which is exactly what
 * happens. Nothing is needed for the other platforms: `drop-text` is macOS-only in
 * Electron, and so is `setTitle`.
 */
const DROP_CUE = '+'

export interface TrayDeps {
  popover: PopoverWindow
  onRefresh(): void
  onMarkAllRead(): void
  onRunNetworkChecks(): void
  /** Show the popover on the network dashboard. */
  onShowNetwork(): void
  /** Text was dragged onto the icon and let go: a handle, a DID or a profile link. */
  onDropText(text: string): void
  /** Hold banners for a while, or stop holding them when `choice` is null. */
  onSnooze(choice: SnoozeChoice | null): void
  onQuit(): void
}

export class TrayController {
  private tray: Tray | null = null
  private currentIcon = ''
  private beatFrames: Electron.NativeImage[] = []
  private beatTimer: ReturnType<typeof setInterval> | null = null
  private beatFrame = 0
  /** Last title written beside the icon, so an unchanged one is not rewritten. */
  private currentTitle = ''
  /** Whether text is currently being dragged over the icon. See `DROP_CUE`. */
  private dragging = false
  /** The title the icon would be showing if it were not showing the drop cue. */
  private titleBeforeDrag = ''
  /** Whether network checks are on, so the menu can offer to run them. */
  private networkChecks = true
  /** Whether banners are on at all, and until when they are snoozed. */
  private notifications: Pick<Settings, 'notificationsEnabled' | 'notificationsSnoozedUntil'> = {
    notificationsEnabled: true,
    notificationsSnoozedUntil: null
  }
  /**
   * Whether there is a newer Statusky, which the menu offers to do something about.
   *
   * The menu bar is where this belongs and an OS notification is where it does not. Every
   * banner this app raises means *the Atmosphere is broken* — a relay stopped answering,
   * an operator posted an incident — and that is a channel worth keeping expensive. Spend
   * it on "version 0.2.0 is out" and the next time one of these interrupts somebody, the
   * cost of ignoring it has gone down, because last time it was housekeeping. The menu is
   * where the app's own verbs already live, it is one click away at all times, and it
   * waits indefinitely without ever taking the screen. See `UpdateStatus`.
   */
  private updateStatus: UpdateStatus = { stage: 'current', version: null }
  /**
   * Whether the OS has asked for reduced motion, as reported by the popover.
   *
   * True until a page says otherwise, which is the opposite of the optimistic default
   * everywhere else in this app and is deliberate. There is no main-process API for this
   * — `nativeTheme` covers dark mode and high contrast and stops — so the only thing that
   * can answer is a renderer, and a renderer may not have run yet, or may never run at
   * all: the popover is built at startup but its page takes a moment to load, and one
   * whose renderer has died three times over stops being rebuilt entirely. Guessing
   * wrong in the optimistic direction means flashing an icon at ten hertz at somebody who
   * asked the OS, system-wide, for that not to happen. Guessing wrong the other way costs
   * them a badge instead of a heartbeat for the second before the page reports in.
   */
  private reduceMotion = true
  /**
   * The last state `update` was given, so an answer arriving from outside the model —
   * the reduced-motion report — can be applied without waiting for the next poll.
   */
  private lastState: AppState | null = null

  constructor(private readonly deps: TrayDeps) {}

  create(): void {
    const tray = new Tray(loadIcon('trayTemplate'))
    this.currentIcon = 'trayTemplate'
    tray.setToolTip('Statusky')
    tray.setIgnoreDoubleClickEvents(true)

    tray.on('click', () => this.deps.popover.toggle(tray.getBounds()))
    tray.on('right-click', () => tray.popUpContextMenu(this.buildMenu()))

    /**
     * Dragging a handle onto the menu bar icon, which is the shortest path there is from
     * "I should watch this" to watching it: select `status.blacksky.community` in a
     * browser, drag it to the icon, done — no popover, no Accounts panel, no typing a
     * handle out by hand into a field that is one character from resolving to nothing.
     * `Model.addAccount` already takes exactly the three things somebody would have
     * selected: a handle, a DID, or a bsky.app profile link.
     *
     * All three events are macOS-only in Electron and are simply never emitted
     * elsewhere, which is why none of this is conditional on the platform: there is
     * nothing to guard against.
     */
    tray.on('drag-enter', () => this.showDropCue(tray))
    tray.on('drag-leave', () => this.clearDropCue(tray))
    tray.on('drop-text', (_event, text) => {
      this.clearDropCue(tray)
      this.deps.onDropText(text)
    })

    this.syncContextMenu(tray)

    this.tray = tray
  }

  /**
   * On Linux, attach the menu to the icon; everywhere else, leave the icon alone.
   *
   * Most Linux desktops now speak StatusNotifierItem/AppIndicator rather than the old
   * XEmbed tray — GNOME through the AppIndicator extension, KDE natively, and most of the
   * rest. Under it, a left click is not delivered to the application at all, so the
   * `click` handler above never fires; and an item that has never had a menu set through
   * `setContextMenu` may show nothing on right-click either, because the host asks the
   * item for its menu rather than waiting to be told to pop one up. Between the two, the
   * app ends up in the menu bar with no way in. Setting the menu means *Open Statusky* is
   * always reachable, which is the one thing that must never stop working.
   *
   * Deliberately not done on macOS or Windows: `setContextMenu` on macOS replaces the
   * left-click toggle with a menu, and this app's whole interaction is clicking the icon
   * to get the popover. The `click` and `right-click` handlers stay registered on Linux
   * as well, because a session still running an XEmbed tray does deliver them.
   */
  private syncContextMenu(tray: Tray): void {
    if (process.platform !== 'linux') return
    tray.setContextMenu(this.buildMenu())
  }

  /** Where the icon is, to anchor the popover to it; undefined before `create()`. */
  bounds(): Electron.Rectangle | undefined {
    return this.tray?.getBounds()
  }

  /**
   * Tell the tray that the OS's reduced-motion preference has changed.
   *
   * Arrives from the popover over IPC rather than from the model, because a page is the
   * only part of this app that can read it; see `Popover` in schemas/statusky.eipc. The
   * last state is re-applied rather than waited on, since the next one is a poll interval
   * away and this decides whether an icon is currently flashing.
   */
  setReducedMotion(reduce: boolean): void {
    if (reduce === this.reduceMotion) return
    this.reduceMotion = reduce
    if (this.lastState) this.update(this.lastState)
  }

  /** Reflect the latest state in the icon, the heartbeat and the tooltip. */
  update(state: AppState): void {
    this.lastState = state
    const tray = this.tray
    if (!tray) return

    // The checks' own entries say what changed, not what is true now; their health
    // comes from the live measurement instead, through `reportHeadline` — which also
    // stops counting a claim once its author has been quiet long enough for it to be
    // history, so the icon is not left coloured by a fortnight-old maintenance post.
    // Nothing schedules that moment: state is pushed on every poll, which is oftener
    // than any claim's window, so the icon stands down within one refresh of going stale.
    const { health, label } = reportHeadline(state.accounts, state.posts, state.network, Date.now())

    // `buildMenu` reads `networkChecks`, `update` and the snooze and nothing else, so that is the
    // whole of the menu's dependence on state — and on Linux the menu is set once rather
    // than built per right-click, so it goes stale unless it is rebuilt when either
    // moves. Anything `buildMenu` starts reading later has to be compared here too.
    if (
      state.settings.networkChecks !== this.networkChecks ||
      state.update.stage !== this.updateStatus.stage ||
      state.update.version !== this.updateStatus.version ||
      state.settings.notificationsEnabled !== this.notifications.notificationsEnabled ||
      state.settings.notificationsSnoozedUntil !== this.notifications.notificationsSnoozedUntil
    ) {
      this.networkChecks = state.settings.networkChecks
      this.updateStatus = state.update
      this.notifications = {
        notificationsEnabled: state.settings.notificationsEnabled,
        notificationsSnoozedUntil: state.settings.notificationsSnoozedUntil
      }
      this.syncContextMenu(tray)
    }

    const unread = state.unread.length
    const style =
      unread > 0
        ? resolveStyle(state.settings.trayUnreadStyle, process.platform, this.reduceMotion)
        : 'none'

    if (style === 'beat') {
      // The beat outranks the health colour: unread updates are the thing asking to
      // be dealt with, and it is red whatever the accounts are currently reporting.
      this.startBeat(tray)
    } else {
      this.stopBeat()
      this.setIcon(tray, style === 'dot' ? BADGED(ICON_FOR[health]) : ICON_FOR[health])
    }
    this.setTitle(tray, style === 'count' ? String(unread) : '')

    const lines = [`Statusky — ${label}`]
    const network = networkLine(state.network)
    if (network) lines.push(network)
    const restraint = restraintLine(state.network)
    if (restraint) lines.push(restraint)
    if (unread > 0) lines.push(`${unread} unread update${unread === 1 ? '' : 's'}`)
    if (state.sync.lastSyncedAt) {
      lines.push(`Last checked ${new Date(state.sync.lastSyncedAt).toLocaleTimeString()}`)
    }
    if (state.sync.error) lines.push('Last refresh failed')
    tray.setToolTip(lines.join('\n'))
  }

  private setIcon(tray: Tray, stem: string): void {
    if (stem === this.currentIcon) return
    tray.setImage(loadIcon(stem))
    this.currentIcon = stem
  }

  /**
   * Write the count beside the icon, in digits that all take the same width.
   *
   * Without `monospacedDigit` the title is set in the menu bar's proportional font, where
   * a 1 is much narrower than a 0 — so every time the number changes width, everything to
   * the left of Statusky's icon shuffles sideways. Going from 9 unread to 10 moves the
   * clock. macOS only, which costs nothing to say: `setTitle` itself is macOS only, and
   * `resolveStyle` has already turned `count` into `dot` everywhere else.
   */
  private setTitle(tray: Tray, title: string): void {
    // While the icon is standing in as a drop target it is showing the cue instead.
    // Remember what it should be showing, so the end of the drag restores the title the
    // state asked for and not the one from before it — a poll can land mid-drag.
    if (this.dragging) {
      this.titleBeforeDrag = title
      return
    }
    this.writeTitle(tray, title)
  }

  private writeTitle(tray: Tray, title: string): void {
    if (title === this.currentTitle) return
    tray.setTitle(title, { fontType: 'monospacedDigit' })
    this.currentTitle = title
  }

  /** Say the icon will take what is being dragged. Idempotent: `drag-enter` can repeat. */
  private showDropCue(tray: Tray): void {
    if (this.dragging) return
    this.titleBeforeDrag = this.currentTitle
    this.dragging = true
    this.writeTitle(tray, DROP_CUE)
  }

  /** Put the icon back, whether the drag ended in a drop or left again. */
  private clearDropCue(tray: Tray): void {
    if (!this.dragging) return
    this.dragging = false
    this.writeTitle(tray, this.titleBeforeDrag)
  }

  /** Play the heartbeat until everything has been read. */
  private startBeat(tray: Tray): void {
    if (this.beatTimer) return
    if (!this.beatFrames.length) this.beatFrames = BEAT_STEMS.map(loadIcon)
    const frames = this.beatFrames
    // Whatever the icon was, it will have to be re-applied once the beat stops.
    this.currentIcon = ''
    this.beatFrame = 0

    const tick = (): void => {
      tray.setImage(frames[this.beatFrame % frames.length]!)
      this.beatFrame++
    }
    tick()
    this.beatTimer = setInterval(tick, BEAT_INTERVAL_MS)
    // An animation should never be the reason the process stays alive.
    this.beatTimer.unref()
  }

  private stopBeat(): void {
    if (!this.beatTimer) return
    clearInterval(this.beatTimer)
    this.beatTimer = null
  }

  /**
   * The update entry, or an empty list when there is nothing to offer.
   *
   * Two stages, two different verbs, and the difference between them is the whole of
   * what this app can honestly promise on the platform it is running on. `ready` means
   * macOS or Windows has already downloaded a build and the only thing left is a
   * restart, so the entry does it. `available` means nothing has been or will be
   * downloaded — a Linux install, or one where Squirrel refused — so the entry can only
   * open the page the new build is downloaded from. It deliberately does not say
   * *Update*, because it does not update anything. See src/main/update.ts.
   *
   * It sits above *About Statusky* rather than at the top, because it is never the
   * reason anybody opened this menu: the icon is a health report and the entries above
   * are what to do about health. This is the app talking about itself.
   */
  private updateItems(): Electron.MenuItemConstructorOptions[] {
    // Squirrel.Windows does not always name the version it has downloaded, so the label
    // has to read without one. See `downloadedVersion` in src/main/update.ts.
    const named = this.updateStatus.version ? ` ${this.updateStatus.version}` : ''

    switch (this.updateStatus.stage) {
      case 'ready':
        return [
          { label: `Restart to update${named}`, click: () => restartToUpdate() },
          { type: 'separator' }
        ]
      case 'available':
        return [
          {
            label: `Download Statusky${named}`,
            click: () => void shell.openExternal(LATEST_RELEASE_URL)
          },
          { type: 'separator' }
        ]
      default:
        return []
    }
  }

  /**
   * Pausing banners, which belongs here because the moment somebody wants it — a call
   * starting, a screen about to be shared — is not a moment to open Settings.
   *
   * Nothing is offered while banners are off altogether, since there is nothing to pause.
   * The label on a paused menu says until when, and is read when the menu is built: a
   * snooze that has run out reads as over even if nothing has rebuilt the menu yet.
   */
  private snoozeItems(): Electron.MenuItemConstructorOptions[] {
    if (!this.notifications.notificationsEnabled) return []
    const now = new Date()
    const until = snoozedUntil(this.notifications, now)
    if (until) {
      return [
        {
          label: `Resume notifications (paused until ${formatClock(until, now)})`,
          click: () => this.deps.onSnooze(null)
        }
      ]
    }
    return [
      {
        label: 'Pause notifications',
        submenu: SNOOZE_CHOICES.map((choice) => ({
          label: choice.label,
          click: () => this.deps.onSnooze(choice.value)
        }))
      }
    ]
  }

  private buildMenu(): Electron.Menu {
    return Menu.buildFromTemplate([
      {
        label: 'Open Statusky',
        click: () => this.deps.popover.show(this.tray?.getBounds())
      },
      { type: 'separator' },
      { label: 'Refresh now', click: () => this.deps.onRefresh() },
      {
        label: 'Run network checks',
        enabled: this.networkChecks,
        click: () => this.deps.onRunNetworkChecks()
      },
      { label: 'Mark all as read', click: () => this.deps.onMarkAllRead() },
      ...this.snoozeItems(),
      { type: 'separator' },
      { label: 'Show network status', click: () => this.deps.onShowNetwork() },
      { type: 'separator' },
      {
        label: 'Bluesky status page',
        click: () => void shell.openExternal('https://status.bsky.app')
      },
      {
        label: 'Blacksky status page',
        click: () => void shell.openExternal('https://status.blacksky.community')
      },
      {
        label: 'Northsky status page',
        click: () => void shell.openExternal('https://status.northsky.social')
      },
      {
        label: 'Atmosphere status (status.feeds.blue)',
        click: () => void shell.openExternal('https://status.feeds.blue')
      },
      { type: 'separator' },
      ...this.updateItems(),
      {
        label: 'About Statusky',
        // The native panel — version, copyright and what the app is — rather than the
        // dead row that used to sit here saying the version and nothing else.
        // `configureAboutPanel` in src/main/menu.ts is what fills it in.
        click: () => app.showAboutPanel()
      },
      { label: 'Quit Statusky', accelerator: 'CommandOrControl+Q', click: () => this.deps.onQuit() }
    ])
  }

  destroy(): void {
    this.stopBeat()
    this.tray?.destroy()
    this.tray = null
  }
}
