import type { Account, MarkReadTrigger, Platform, Settings, TrayUnreadStyle } from './types'

/** Accounts the app ships with. These can be muted or silenced but not removed. */
export const BUILTIN_ACCOUNTS: readonly Omit<Account, 'addedAt'>[] = [
  {
    did: 'did:plc:4dtbz2ivhp5app3sbntcccxc',
    handle: 'status.bsky.app',
    displayName: 'Bluesky Status',
    avatar: null,
    description: 'Status page for the Bluesky AppView, PDS fleet and relay.',
    notify: true,
    muted: false,
    builtin: true,
    kind: 'atproto'
  },
  {
    did: 'did:plc:njxo6cs5a6jjk4c2z6dhecsc',
    handle: 'status.blacksky.community',
    displayName: 'Blacksky Status',
    avatar: null,
    description: 'Status page for outages or updates affecting Blacksky.',
    notify: true,
    muted: false,
    builtin: true,
    kind: 'atproto'
  }
]

/**
 * Default port for the webhook receiver. Unregistered, and fixed rather than
 * ephemeral so that a tunnel pointed at it survives a restart of the app.
 */
export const DEFAULT_WEBHOOK_PORT = 7385

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalSec: 120,
  notificationsEnabled: true,
  notificationSound: true,
  theme: 'system',
  launchAtLogin: false,
  trayUnreadStyle: 'beat',
  markReadOn: 'open',
  postsPerAccount: 30,
  webhookEnabled: false,
  webhookPort: DEFAULT_WEBHOOK_PORT,
  networkChecks: true,
  networkIntervalSec: 600,
  globalShortcut: ''
}

/**
 * How the menu bar announces unread updates, worded as the menu bar's own behaviour
 * rather than as a feature name — the setting is read next to the thing it changes.
 */
export const TRAY_UNREAD_STYLE_CHOICES: {
  value: TrayUnreadStyle
  label: string
  /** Why you would pick this one, for the row under the control. */
  hint: string
}[] = [
  { value: 'beat', label: 'Beat the icon', hint: 'Red, at 150 bpm, until you have caught up.' },
  { value: 'dot', label: 'Badge the icon', hint: 'A dot on the health icon. The quiet version.' },
  { value: 'count', label: 'Show a count', hint: 'The number beside the icon. macOS only.' },
  { value: 'none', label: 'Leave it alone', hint: 'The icon reports health and nothing else.' }
]

/**
 * When a post stops being unread on its own, in the Feed tab.
 *
 * The Timeline is not governed by this: it exists to be opened, read and left, so
 * opening it always catches you up. This is about the tab you browse.
 */
export const MARK_READ_CHOICES: { value: MarkReadTrigger; label: string; hint: string }[] = [
  { value: 'open', label: 'When I open a tab', hint: 'Showing a tab counts as reading it.' },
  { value: 'never', label: 'Only when I say', hint: 'Clicking an update, or Mark all as read.' },
  { value: 'seen', label: 'When it scrolls past', hint: 'Each update, once it has been on screen.' }
]

/**
 * The key combinations offered for summoning the popover, and nothing else.
 *
 * A free-text accelerator field would be the flexible answer and the wrong one here.
 * The popover hides the moment it loses focus, so a capture control inside it would be
 * fighting the window it lives in; an accelerator typed by hand can be syntactically
 * invalid in ways Electron only reports by refusing; and every combination offered here
 * is one somebody has already thought about. `''` is off, and is the default.
 *
 * None of these can be promised: a global shortcut belongs to whichever application
 * asked for it first, so the registration is attempted and then reported. See
 * `ShortcutStatus` and src/main/shortcut.ts.
 */
export const GLOBAL_SHORTCUT_CHOICES: readonly string[] = [
  '',
  'CommandOrControl+Shift+S',
  'CommandOrControl+Alt+S',
  'Alt+Shift+S'
]

/** Modifier spellings, by platform, for `formatAccelerator`. */
const MODIFIER_SYMBOLS: Record<string, { darwin: string; other: string }> = {
  CommandOrControl: { darwin: '⌘', other: 'Ctrl' },
  CmdOrCtrl: { darwin: '⌘', other: 'Ctrl' },
  Command: { darwin: '⌘', other: 'Cmd' },
  Cmd: { darwin: '⌘', other: 'Cmd' },
  Control: { darwin: '⌃', other: 'Ctrl' },
  Ctrl: { darwin: '⌃', other: 'Ctrl' },
  Alt: { darwin: '⌥', other: 'Alt' },
  Option: { darwin: '⌥', other: 'Alt' },
  Shift: { darwin: '⇧', other: 'Shift' },
  Super: { darwin: '⌘', other: 'Win' },
  Meta: { darwin: '⌘', other: 'Win' }
}

/**
 * Write an Electron accelerator the way the platform writes it.
 *
 * `CommandOrControl+Shift+S` is the string the OS needs and is not a thing to show
 * anybody: macOS writes that combination `⌘⇧S`, with no separators and in a fixed
 * modifier order, and Windows and Linux write it `Ctrl+Shift+S`. Showing the raw
 * accelerator instead would also be a small lie on one platform or the other, since
 * `CommandOrControl` is exactly the part that means something different on each.
 */
export function formatAccelerator(accelerator: string, platform: Platform): string {
  if (!accelerator) return 'Off'
  const mac = platform === 'darwin'
  const parts = accelerator.split('+').map((part) => {
    const modifier = MODIFIER_SYMBOLS[part]
    return modifier ? (mac ? modifier.darwin : modifier.other) : part
  })
  return parts.join(mac ? '' : '+')
}

export const POLL_INTERVAL_CHOICES = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' }
] as const

/**
 * How often the network dashboard re-measures everything in the background. A sweep is
 * around a hundred small requests and five brief firehose connections, so the default
 * leans towards being a good citizen; opening the popover refreshes a stale one anyway.
 */
export const NETWORK_INTERVAL_CHOICES = [
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' }
] as const

/** Cap on how many posts we keep in the store, across all accounts. */
export const MAX_STORED_POSTS = 500

/** Cap on how many pushed sources may register themselves, hostile payload included. */
export const MAX_WEBHOOK_SOURCES = 25

/** Public AppView. Read-only, unauthenticated, no rate-limit key needed. */
export const PUBLIC_APPVIEW = 'https://public.api.bsky.app'

/**
 * Where releases are published, in the one spelling everything else is built from.
 *
 * Three things have to name this repository and they must not drift: `package.json`'s
 * `repository` field, which is what `update-electron-app` reads to find its feed; the
 * GitHub publisher in `forge.config.ts`, which is what puts releases there in the first
 * place; and the two URLs below. The first two belong to their own tools and cannot be
 * built from this, so the comment in each of them points back here.
 */
export const RELEASE_REPO = 'cutenode/statusky'

/**
 * The page a user is sent to when they have to fetch a new build themselves.
 *
 * Shared rather than main-only because the Settings panel offers the same link the tray
 * menu does, and a download page spelled two ways is a download page that will one day
 * be spelled two ways wrongly.
 */
export const LATEST_RELEASE_URL = `https://github.com/${RELEASE_REPO}/releases/latest`

/**
 * The unauthenticated GitHub API endpoint the release check asks.
 *
 * Unauthenticated calls are rate limited to 60 an hour per IP address, shared with
 * everything else on that address — which is why `UPDATE_CHECK_INTERVAL_MS` is measured
 * in hours rather than minutes. A `404` here is the ordinary answer for a repository
 * that has not published a release yet, not an error. See src/main/update.ts.
 */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`
