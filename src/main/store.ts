import ElectronStore from 'electron-store'
import { BUILTIN_ACCOUNTS, DEFAULT_SETTINGS } from '../shared/defaults'
import type { Account, Settings, StatusPost } from '../shared/types'
import { EMPTY_READ, readStateFromUnread, type Cursors, type ReadState } from './state'
import { generateWebhookSecret } from './webhook'

export interface PersistedShape extends Record<string, unknown> {
  schemaVersion: number
  accounts: Account[]
  settings: Settings
  posts: StatusPost[]
  /** How far through each source the user has read. See `ReadState`. */
  read: ReadState
  cursors: Cursors
  /**
   * The unguessable path segment of the webhook endpoint. It is the only credential
   * protecting the receiver, so it is minted once per install and never logged.
   */
  webhookSecret: string
}

const SCHEMA_VERSION = 4

function seedAccounts(): Account[] {
  const addedAt = new Date().toISOString()
  return BUILTIN_ACCOUNTS.map((account) => ({ ...account, addedAt }))
}

export function createStore(): ElectronStore<PersistedShape> {
  const store = new ElectronStore<PersistedShape>({
    name: 'statusky',
    defaults: {
      schemaVersion: SCHEMA_VERSION,
      accounts: seedAccounts(),
      settings: { ...DEFAULT_SETTINGS },
      posts: [],
      read: { ...EMPTY_READ },
      cursors: {},
      webhookSecret: generateWebhookSecret()
    },
    clearInvalidConfig: true
  })

  reconcile(store)
  return store
}

/**
 * Bring an existing config file up to date with the current build:
 * fill in settings added since it was written, migrate renamed ones, and adopt
 * any status accounts that shipped in a newer version.
 */
export function reconcile(store: ElectronStore<PersistedShape>): void {
  store.set('settings', migrateSettings(store.get('settings')))
  store.set('read', migrateRead(store))

  // A config written before webhooks existed has no secret; mint one rather than
  // leave the receiver unable to start.
  if (!store.get('webhookSecret')) store.set('webhookSecret', generateWebhookSecret())

  // Host discovery used to add the busiest independent PDSes to the dashboard on top of
  // the catalogue, and cached what it found here. Nothing reads the key now; drop it
  // rather than leave it to drift. Not tied to the schema version: it has to go whatever
  // version wrote it, and deleting a key that is not there costs nothing.
  store.delete('discovery' as keyof PersistedShape & string)

  const accounts = store.get('accounts') ?? []
  const known = new Set(accounts.map((a) => a.did))
  const addedAt = new Date().toISOString()

  const merged = [...accounts]
  for (const builtin of BUILTIN_ACCOUNTS) {
    if (!known.has(builtin.did)) {
      merged.push({ ...builtin, addedAt })
    }
  }
  // A previously user-added account that later ships with the app becomes builtin.
  const builtinDids = new Set(BUILTIN_ACCOUNTS.map((a) => a.did))
  for (const account of merged) {
    if (builtinDids.has(account.did)) account.builtin = true
    // Schema 2 predates pushed sources; everything it persisted was polled.
    account.kind ??= 'atproto'
  }
  store.set('accounts', merged)

  store.set('schemaVersion', SCHEMA_VERSION)
}

/**
 * Carry old answers forward onto the settings that replaced them.
 *
 * Schema 1 announced unread updates with a count beside the tray icon and schema 2
 * beat the icon instead; schema 4 makes that a choice of four, so each of those two
 * booleans maps onto the style it used to mean, oldest first. Someone who turned the
 * count off wanted a quiet menu bar, and still does. `notifyOnlyIncidents` is gone
 * entirely; drop it rather than persist a key nothing reads.
 */
function migrateSettings(stored: Settings | undefined): Settings {
  const {
    showTrayCount,
    beatWhenUnread,
    notifyOnlyIncidents: _dropped,
    ...rest
  } = (stored ?? {}) as Partial<Settings> & {
    showTrayCount?: boolean
    beatWhenUnread?: boolean
    notifyOnlyIncidents?: boolean
  }

  const inherited = beatWhenUnread ?? showTrayCount
  const trayUnreadStyle =
    rest.trayUnreadStyle ??
    (inherited === undefined ? DEFAULT_SETTINGS.trayUnreadStyle : inherited ? 'beat' : 'none')

  return { ...DEFAULT_SETTINGS, ...rest, trayUnreadStyle }
}

/** Rebuild schema 3's flat `unread` list as read cursors, and drop the old key. */
function migrateRead(store: ElectronStore<PersistedShape>): ReadState {
  // The schema version is the only reliable witness: a fresh install's `read` default
  // answers the read as convincingly as a stored one would, and both are empty.
  if (store.get('schemaVersion') >= SCHEMA_VERSION) return store.get('read')

  const unread = (store.get('unread') as string[] | undefined) ?? []
  const read = readStateFromUnread(store.get('posts') ?? [], unread)
  // Schema 3's key has no reader left; leave nothing behind to drift.
  store.delete('unread' as keyof PersistedShape & string)
  return read
}

export type { Settings, Account }
