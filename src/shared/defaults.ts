import type { Account, MarkReadTrigger, Settings, TrayUnreadStyle } from './types'

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
  networkIntervalSec: 600
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
 * When a post stops being unread on its own, in the Feed and Alerts tabs.
 *
 * The Unread tab is not governed by this: it exists to be opened, read and left, so
 * opening it always catches you up. This is about the tabs you browse.
 */
export const MARK_READ_CHOICES: { value: MarkReadTrigger; label: string; hint: string }[] = [
  { value: 'open', label: 'When I open a tab', hint: 'Showing a tab counts as reading it.' },
  { value: 'never', label: 'Only when I say', hint: 'Clicking an update, or Mark all as read.' },
  { value: 'seen', label: 'When it scrolls past', hint: 'Each update, once it has been on screen.' }
]

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
