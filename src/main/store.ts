import { safeStorage } from 'electron'
import ElectronStore from 'electron-store'
import { BUILTIN_ACCOUNTS, DEFAULT_SETTINGS } from '../shared/defaults'
import { sanitizeProbeTargets } from '../shared/probe-targets'
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
  /** Incidents whose start got a banner, so their follow-ups can. See `applyFollowUps`. */
  openIncidents: string[]
  /**
   * The unguessable path segment of the webhook endpoint, sealed by the OS credential
   * store — Keychain on macOS, libsecret on Linux, DPAPI on Windows — and held here as
   * base64, because the config file is JSON and the ciphertext is bytes.
   *
   * It is the only credential protecting the receiver, so it is minted once per install
   * and never logged. It used to sit beside this key in the clear, where anything
   * running as the user could read it out of `statusky.json`; schema 5 moved it.
   *
   * Optional, like `webhookSecret`, because `writeWebhookSecret` deletes whichever of the
   * two it did not use, and a deleted key reads back as `undefined` rather than as its
   * default until the next launch merges the defaults back in.
   */
  webhookSecretEncrypted?: string
  /**
   * The same secret in the clear, and only on a machine that has nowhere better to put
   * it: a Linux desktop with no secret service running is a real configuration, and
   * refusing to start on one would be a worse answer than this. Exactly one of these
   * two keys ever holds the secret — `writeWebhookSecret` decides which and deletes
   * the other — so a value here is a statement that `safeStorage` had nothing to offer.
   */
  webhookSecret?: string
}

/**
 * An account as any build since schema 1 may have left it on disk, which is what
 * `reconcile` reads before it has had the chance to bring it up to date.
 */
type StoredAccount = Omit<Account, 'notify' | 'kind'> & {
  /** Schema 5 and earlier had a switch here rather than a level. */
  notify: Account['notify'] | boolean
  /** Schema 2 predates pushed sources, and wrote none. */
  kind?: Account['kind']
}

const SCHEMA_VERSION = 6

/**
 * The schema version that replaced the flat `unread` list with read cursors.
 *
 * Pinned rather than read off `SCHEMA_VERSION`: every later bump would otherwise send
 * an up-to-date config back through `migrateRead`, which would find no `unread` key,
 * conclude that nothing was unread, and quietly mark the whole feed as read.
 */
const READ_CURSORS_SCHEMA = 4

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
      openIncidents: [],
      // Minted by `readWebhookSecret` rather than here, so that one place decides
      // whether it is written sealed or in the clear, and so that nothing is minted
      // at all on an install that never turns the receiver on. See `writeWebhookSecret`.
      webhookSecret: '',
      webhookSecretEncrypted: ''
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

  // The webhook secret is deliberately not settled here, and nothing in this function
  // may read it. `safeStorage` is a synchronous trip into the OS credential store on
  // the thread it is called from, and `createStore()` runs on the main thread early in
  // `bootstrap()`: on macOS an ad-hoc-signed build gets a fresh code identity out of
  // every package, the Keychain ACL written against the previous one no longer matches,
  // and the read parks in `SecItemCopyMatching` behind a modal SecurityAgent prompt.
  // The tray and the popover appear and nothing is ever polled, because bootstrap never
  // returns from here. A signed build does not prompt, but a locked keychain can still
  // make that call slow, and it has no business being on the path that brings the app
  // up. `readWebhookSecret` does the trip — sealing an older plaintext secret included —
  // when something actually needs the value, which on the default settings is never.

  // Host discovery used to add the busiest independent PDSes to the dashboard on top of
  // the catalogue, and cached what it found here. Nothing reads the key now; drop it
  // rather than leave it to drift. Not tied to the schema version: it has to go whatever
  // version wrote it, and deleting a key that is not there costs nothing.
  store.delete('discovery' as keyof PersistedShape & string)

  const accounts: StoredAccount[] = store.get('accounts') ?? []
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
  store.set(
    'accounts',
    merged.map((account): Account => {
      // Typed as `Account`'s own fields rather than inferred, so that a migration writing
      // a value this build has no name for fails the type-check instead of the next push.
      const current: Pick<Account, 'builtin' | 'kind' | 'notify'> = {
        builtin: account.builtin || builtinDids.has(account.did),
        // Schema 2 predates pushed sources; everything it persisted was polled.
        kind: account.kind ?? 'atproto',
        // Schema 5 and earlier had a notify switch rather than a level. On meant
        // "whatever the settings say", which is `default`; off was no banners.
        notify:
          typeof account.notify === 'boolean'
            ? account.notify
              ? 'default'
              : 'off'
            : account.notify
      }
      return Object.assign(account, current)
    })
  )

  store.set('schemaVersion', SCHEMA_VERSION)
}

/**
 * Carry old answers forward onto the settings that replaced them.
 *
 * Schema 1 announced unread updates with a count beside the tray icon and schema 2
 * beat the icon instead; schema 4 makes that a choice of four, so each of those two
 * booleans maps onto the style it used to mean, oldest first. Someone who turned the
 * count off wanted a quiet menu bar, and still does. `notifyOnlyIncidents` is gone
 * entirely; drop it rather than persist a key nothing reads. Schema 6 made the sound a
 * choice of three, and a stored boolean maps onto the two ends of it.
 */
function migrateSettings(stored: Settings | undefined): Settings {
  const {
    showTrayCount,
    beatWhenUnread,
    notifyOnlyIncidents: _dropped,
    notificationSound: sound,
    ...rest
  } = (stored ?? {}) as Omit<Partial<Settings>, 'notificationSound'> & {
    showTrayCount?: boolean
    beatWhenUnread?: boolean
    notifyOnlyIncidents?: boolean
    notificationSound?: Settings['notificationSound'] | boolean
  }

  const inherited = beatWhenUnread ?? showTrayCount
  const trayUnreadStyle =
    rest.trayUnreadStyle ??
    (inherited === undefined ? DEFAULT_SETTINGS.trayUnreadStyle : inherited ? 'beat' : 'none')

  // Schema 5 played the sound for every banner or for none. Someone who had it on chose
  // to hear every banner, and keeps doing so rather than being moved to the new default.
  const notificationSound =
    typeof sound === 'boolean'
      ? sound
        ? 'all'
        : 'never'
      : (sound ?? DEFAULT_SETTINGS.notificationSound)

  // An override that no longer validates — edited by hand, or written against a schema
  // this build does not share — must reach neither the probes nor the popover, whose
  // state carries every setting and is validated whole on every push. It is dropped for
  // the checked-in defaults, with a warning, rather than allowed to stop the app.
  const probeTargets = sanitizeProbeTargets(rest.probeTargets)

  return { ...DEFAULT_SETTINGS, ...rest, trayUnreadStyle, notificationSound, probeTargets }
}

/** Rebuild schema 3's flat `unread` list as read cursors, and drop the old key. */
function migrateRead(store: ElectronStore<PersistedShape>): ReadState {
  // The schema version is the only reliable witness: a fresh install's `read` default
  // answers the read as convincingly as a stored one would, and both are empty.
  if (store.get('schemaVersion') >= READ_CURSORS_SCHEMA) return store.get('read')

  // No longer a key of `PersistedShape`, so nothing but this check says what it holds; a
  // hand-edited `5` here would otherwise throw out of `createStore` and stop the app.
  const stored = store.get('unread')
  const unread = Array.isArray(stored)
    ? stored.filter((uri: unknown): uri is string => typeof uri === 'string')
    : []
  const read = readStateFromUnread(store.get('posts') ?? [], unread)
  // Schema 3's key has no reader left; leave nothing behind to drift.
  store.delete('unread' as keyof PersistedShape & string)
  return read
}

/**
 * The secret, in the clear, for as long as this store is alive.
 *
 * `WebhookReceiver` asks for it on every request and every `AppState` of a receiver
 * that is listening carries the endpoint URL built from it, so the read is far too hot
 * to go through the OS credential store each time. Whichever of those comes first pays
 * for the one trip through `safeStorage`, and `writeWebhookSecret` keeps this in step
 * afterwards.
 */
const inMemory = new WeakMap<object, string>()

/**
 * The webhook endpoint's secret, minting one if there is nothing usable on disk.
 *
 * Call this only when the value is genuinely wanted — serving a request, or building
 * the endpoint URL for a receiver that is already listening. It is the only thing in
 * this file that touches `safeStorage`, and `reconcile()` explains at length why that
 * must not happen on the way up. `webhookEnabled` is false by default, so on most
 * installs this is never called at all and the credential store is never opened.
 *
 * Reading can write, which is the point: an install whose secret is still in the clear
 * — schema 4, or a machine that had no credential store the last time it ran — is
 * re-sealed the first time it is asked for, carrying the same value across rather than
 * regenerating it. Regenerating would silently break any tunnel the user had already
 * pointed at their endpoint, and they would have no way of knowing why. That migration
 * used to ride on an eager read in `reconcile()`; it now happens at the first real
 * need, because until then there is no plaintext endpoint in use to protect.
 */
export function readWebhookSecret(store: ElectronStore<PersistedShape>): string {
  const remembered = inMemory.get(store)
  if (remembered !== undefined) return remembered

  const secret = recoverWebhookSecret(store) ?? generateWebhookSecret()
  writeWebhookSecret(store, secret)
  return secret
}

/** Persist `secret` in the strongest form this machine offers, and forget the other. */
export function writeWebhookSecret(store: ElectronStore<PersistedShape>, secret: string): void {
  inMemory.set(store, secret)

  const sealed = seal(secret)
  if (sealed === null) {
    store.set('webhookSecret', secret)
    store.delete('webhookSecretEncrypted')
    return
  }

  store.set('webhookSecretEncrypted', sealed)
  // Nothing should be able to find the old plaintext afterwards, least of all a later
  // run of this function deciding the two keys disagree.
  store.delete('webhookSecret')
}

/** Whatever secret is already on disk and readable here, or null if there is none. */
function recoverWebhookSecret(store: ElectronStore<PersistedShape>): string | null {
  const sealed = store.get('webhookSecretEncrypted')
  if (sealed) {
    const opened = unseal(sealed)
    if (opened !== null) return opened

    // Ciphertext this machine cannot open is worth nothing rather than worth keeping:
    // the endpoint URL inside it can never be shown to the user again, so there is no
    // value to preserve and no decision to offer them. It happens when a config is
    // carried to another machine, or when the secret service that sealed it is gone.
    console.warn(
      'The stored webhook secret could not be decrypted, so a new one has been minted. ' +
        'Any status page pointed at the old endpoint URL will need the new one.'
    )
    return null
  }

  // Schema 4 and earlier kept it here in the clear, and so does any run on a machine
  // with no credential store. Either way the value stands and is carried across.
  return store.get('webhookSecret') || null
}

/**
 * Seal `secret` for the config file, or null when this machine cannot.
 *
 * `isEncryptionAvailable()` is asked honestly rather than assumed: on Linux it is
 * false until a secret service (gnome-keyring, kwallet) is both running and reachable,
 * and it is false before the app is ready. A false answer is not an error — it is a
 * machine where the only place to keep the secret is the config file, which is where
 * it lived until schema 5 anyway.
 */
function seal(secret: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null

  try {
    return safeStorage.encryptString(secret).toString('base64')
  } catch (error) {
    // A credential store that says yes and then refuses. Starting without a webhook
    // endpoint would be a worse outcome than storing the secret the way schema 4 did.
    console.warn('The OS credential store refused to hold the webhook secret:', error)
    return null
  }
}

/** Open what `seal` wrote, or null if this machine cannot — see `recoverWebhookSecret`. */
function unseal(sealed: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null

  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    return null
  }
}

export type { Settings, Account }
