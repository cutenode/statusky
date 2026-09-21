import { join } from 'node:path'
import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { headline, networkForHealth } from '../shared/network'
import { deriveHealth, overallHealth, type Health } from '../shared/status'
import type { AppState, NetworkSummary, TrayUnreadStyle } from '../shared/types'
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
 * `Tray.setTitle` is implemented on macOS and nowhere else, so asking for a count on
 * Windows or Linux would silently announce nothing at all. Badge the icon instead: it
 * is the same statement in the only form those platforms can make it.
 */
function resolveStyle(style: TrayUnreadStyle, platform: string): TrayUnreadStyle {
  if (style === 'count' && platform !== 'darwin') return 'dot'
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

function resourcesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'assets')
    : join(import.meta.dirname, '../../resources')
}

function loadIcon(stem: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(resourcesDir(), `${stem}.png`))
  // Only the neutral icon — badged or not — is a template; the coloured ones must
  // keep their colour rather than being tinted to the menu bar's foreground.
  image.setTemplateImage(stem.startsWith('trayTemplate'))
  return image
}

export interface TrayDeps {
  popover: PopoverWindow
  onRefresh(): void
  onMarkAllRead(): void
  onRunNetworkChecks(): void
  /** Show the popover on the network dashboard. */
  onShowNetwork(): void
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
  /** Whether network checks are on, so the menu can offer to run them. */
  private networkChecks = true

  constructor(private readonly deps: TrayDeps) {}

  create(): void {
    const tray = new Tray(loadIcon('trayTemplate'))
    this.currentIcon = 'trayTemplate'
    tray.setToolTip('Statusky')
    tray.setIgnoreDoubleClickEvents(true)

    tray.on('click', () => this.deps.popover.toggle(tray.getBounds()))
    tray.on('right-click', () => tray.popUpContextMenu(this.buildMenu()))

    this.tray = tray
  }

  /** Where the icon is, to anchor the popover to it; undefined before `create()`. */
  bounds(): Electron.Rectangle | undefined {
    return this.tray?.getBounds()
  }

  /** Reflect the latest state in the icon, the heartbeat and the tooltip. */
  update(state: AppState): void {
    const tray = this.tray
    if (!tray) return

    // The checks' own entries say what changed, not what is true now; their health
    // comes from the live measurement instead, through `headline`.
    const reported = overallHealth(
      state.accounts
        .filter((account) => !account.muted && account.kind !== 'probe')
        .map((account) => deriveHealth(state.posts.filter((p) => p.authorDid === account.did)))
    )
    const { health, label } = headline(reported, networkForHealth(state.accounts, state.network))
    this.networkChecks = state.settings.networkChecks

    const unread = state.unread.length
    const style =
      unread > 0 ? resolveStyle(state.settings.trayUnreadStyle, process.platform) : 'none'

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

  private setTitle(tray: Tray, title: string): void {
    if (title === this.currentTitle) return
    tray.setTitle(title)
    this.currentTitle = title
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
        label: 'Atmosphere status (status.feeds.blue)',
        click: () => void shell.openExternal('https://status.feeds.blue')
      },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: 'Quit Statusky', accelerator: 'CommandOrControl+Q', click: () => this.deps.onQuit() }
    ])
  }

  destroy(): void {
    this.stopBeat()
    this.tray?.destroy()
    this.tray = null
  }
}
