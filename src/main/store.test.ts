import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_ACCOUNTS, DEFAULT_SETTINGS } from '../shared/defaults'
import { DEFAULT_PROBE_TARGETS } from '../shared/probe-targets'
import { unreadUris } from './state'
import { createStore, readWebhookSecret, reconcile, writeWebhookSecret } from './store'
import FakeElectronStore, { seedStore } from '../test/electron-store'
import type { PersistedShape } from './store'
import { makeAccount, makePost } from '../test/factories'
import { SEALED_PREFIX, safeStorage } from '../test/electron'

describe('createStore', () => {
  it('seeds the builtin accounts and default settings on a fresh install', () => {
    const store = createStore() as unknown as FakeElectronStore<PersistedShape>

    expect(store.get('accounts').map((a) => a.did)).toEqual(BUILTIN_ACCOUNTS.map((a) => a.did))
    expect(store.get('accounts').every((a) => a.builtin)).toBe(true)
    expect(store.get('accounts').every((a) => Date.parse(a.addedAt) > 0)).toBe(true)
    expect(store.get('settings')).toEqual(DEFAULT_SETTINGS)
    expect(store.get('posts')).toEqual([])
    expect(store.get('read')).toEqual({ cursors: {}, above: [] })
    expect(store.get('cursors')).toEqual({})
    expect(store.get('openIncidents')).toEqual([])
    expect(readWebhookSecret(store as never)).toMatch(/^[\w-]{20,}$/)
    expect(store.get('schemaVersion')).toBe(6)
  })

  // The one thing that must not happen on the way up: `safeStorage` is synchronous,
  // and a Keychain round trip here hangs `bootstrap()` before anything is polled.
  it('opens no credential store on the way up', () => {
    seedStore('statusky', { schemaVersion: 4, webhookSecret: 'secret-from-schema-4' })

    createStore()

    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it('names the config file so it can be found on disk', () => {
    const store = createStore() as unknown as FakeElectronStore<PersistedShape>
    expect(store.name).toBe('statusky')
  })

  it('keeps a user config and fills in settings added since it was written', () => {
    const custom = makeAccount({ did: 'did:plc:custom', handle: 'custom.test' })
    seedStore('statusky', {
      schemaVersion: 1,
      accounts: [custom],
      // An older build that predates `trayUnreadStyle` and `postsPerAccount`.
      settings: { pollIntervalSec: 300, notificationsEnabled: false },
      posts: [],
      unread: [],
      cursors: {}
    })

    const store = createStore() as unknown as FakeElectronStore<PersistedShape>

    expect(store.get('settings')).toEqual({
      ...DEFAULT_SETTINGS,
      pollIntervalSec: 300,
      notificationsEnabled: false
    })
    expect(store.get('accounts').map((a) => a.did)).toEqual([
      'did:plc:custom',
      ...BUILTIN_ACCOUNTS.map((a) => a.did)
    ])
  })

  it('preserves per-account preferences across a reconcile', () => {
    seedStore('statusky', {
      accounts: [
        makeAccount({
          did: BUILTIN_ACCOUNTS[0]!.did,
          handle: BUILTIN_ACCOUNTS[0]!.handle,
          muted: true,
          notify: 'off',
          builtin: true
        })
      ]
    })

    const store = createStore() as unknown as FakeElectronStore<PersistedShape>
    const account = store.get('accounts').find((a) => a.did === BUILTIN_ACCOUNTS[0]!.did)

    expect(account?.muted).toBe(true)
    expect(account?.notify).toBe('off')
  })
})

/** A store with no reconciliation applied, seeded with exactly `data`. */
function bare(data: Partial<PersistedShape>): FakeElectronStore<PersistedShape> {
  return new FakeElectronStore<PersistedShape>({
    name: 'reconcile-test',
    defaults: {
      schemaVersion: 0,
      accounts: [],
      settings: { ...DEFAULT_SETTINGS },
      posts: [],
      cursors: {},
      ...data
    } as PersistedShape
  })
}

describe('reconcile', () => {
  it('promotes a user-added account that now ships with the app', () => {
    const store = bare({
      accounts: [
        makeAccount({
          did: BUILTIN_ACCOUNTS[1]!.did,
          handle: BUILTIN_ACCOUNTS[1]!.handle,
          builtin: false
        })
      ]
    })

    reconcile(store as never)

    expect(store.get('accounts')).toHaveLength(2)
    expect(store.get('accounts').find((a) => a.did === BUILTIN_ACCOUNTS[1]!.did)?.builtin).toBe(
      true
    )
  })

  it('stamps the current schema version', () => {
    const store = bare({})
    reconcile(store as never)
    expect(store.get('schemaVersion')).toBe(6)
  })

  it('carries a schema 1 tray-count preference over to the tray style', () => {
    const { trayUnreadStyle: _dropped, ...schema1 } = DEFAULT_SETTINGS
    const store = bare({
      settings: { ...schema1, showTrayCount: false } as unknown as PersistedShape['settings']
    })

    reconcile(store as never)

    expect(store.get('settings').trayUnreadStyle).toBe('none')
    expect(store.get('settings')).not.toHaveProperty('showTrayCount')
  })

  it('carries a schema 2 heartbeat preference over the older key', () => {
    const { trayUnreadStyle: _dropped, ...schema2 } = DEFAULT_SETTINGS
    const store = bare({
      settings: {
        ...schema2,
        beatWhenUnread: true,
        showTrayCount: false
      } as unknown as PersistedShape['settings']
    })

    reconcile(store as never)

    expect(store.get('settings').trayUnreadStyle).toBe('beat')
    expect(store.get('settings')).not.toHaveProperty('beatWhenUnread')
  })

  it('keeps an explicit tray style over both old keys', () => {
    const store = bare({
      settings: {
        ...DEFAULT_SETTINGS,
        trayUnreadStyle: 'dot',
        beatWhenUnread: true,
        showTrayCount: true
      } as unknown as PersistedShape['settings']
    })

    reconcile(store as never)

    expect(store.get('settings').trayUnreadStyle).toBe('dot')
  })

  it('carries a schema 5 sound switch over to the matching end of the choice', () => {
    const on = bare({
      settings: {
        ...DEFAULT_SETTINGS,
        notificationSound: true
      } as unknown as PersistedShape['settings']
    })
    const off = bare({
      settings: {
        ...DEFAULT_SETTINGS,
        notificationSound: false
      } as unknown as PersistedShape['settings']
    })

    reconcile(on as never)
    reconcile(off as never)

    expect(on.get('settings').notificationSound).toBe('all')
    expect(off.get('settings').notificationSound).toBe('never')
  })

  it('fills in the notification settings a schema 5 install never had', () => {
    const {
      notifySeverities: _severities,
      quietHoursEnabled: _quiet,
      pinnedServices: _pinned,
      ...schema5
    } = DEFAULT_SETTINGS
    const store = bare({ settings: schema5 as PersistedShape['settings'] })

    reconcile(store as never)

    expect(store.get('settings')).toMatchObject({
      notifySeverities: DEFAULT_SETTINGS.notifySeverities,
      quietHoursEnabled: false,
      pinnedServices: []
    })
  })

  it('turns a schema 5 notify switch into a level', () => {
    const store = bare({
      accounts: [
        makeAccount({ did: 'did:plc:on', notify: true as never }),
        makeAccount({ did: 'did:plc:off', notify: false as never })
      ]
    })

    reconcile(store as never)

    const levels = Object.fromEntries(store.get('accounts').map((a) => [a.did, a.notify]))
    expect(levels['did:plc:on']).toBe('default')
    expect(levels['did:plc:off']).toBe('off')
  })

  it('is idempotent', () => {
    const store = bare({})
    reconcile(store as never)
    const first = store.get('accounts')
    reconcile(store as never)
    expect(store.get('accounts').map((a) => a.did)).toEqual(first.map((a) => a.did))
  })

  it('leaves no trace of the discovery cache it no longer keeps', () => {
    // Written by a build that probed discovered PDSes on top of the catalogue. Nothing
    // reads it now, and it goes whatever schema version wrote it.
    seedStore('statusky', {
      schemaVersion: 4,
      accounts: [],
      settings: { ...DEFAULT_SETTINGS },
      posts: [],
      cursors: {},
      discovery: { at: new Date().toISOString(), pdses: ['pds.si46.world'] }
    })

    const store = createStore() as unknown as FakeElectronStore<PersistedShape>

    expect(store.data).not.toHaveProperty('discovery')
  })
})

describe("rebuilding schema 3's unread list as read cursors", () => {
  const DID = 'did:plc:migrating'
  const older = makePost({ authorDid: DID, rkey: 'older', createdAt: '2026-09-02T00:00:00.000Z' })
  const newer = makePost({ authorDid: DID, rkey: 'newer', createdAt: '2026-09-06T00:00:00.000Z' })

  it('keeps exactly the posts that were unread unread', () => {
    const store = bare({ posts: [newer, older], unread: [newer.uri] } as Partial<PersistedShape>)

    reconcile(store as never)

    const read = store.get('read')
    expect(unreadUris([newer, older], read)).toEqual([newer.uri])
    // The read one below it folded into the cursor rather than staying an exception.
    expect(read.cursors[DID]).toBe(older.createdAt)
    expect(read.above).toEqual([])
  })

  it('reads a source whose posts were all read', () => {
    const store = bare({ posts: [newer, older], unread: [] } as Partial<PersistedShape>)

    reconcile(store as never)

    expect(store.get('read')).toEqual({ cursors: { [DID]: newer.createdAt }, above: [] })
  })

  it('keeps a source unread from the very first post it had', () => {
    const store = bare({
      posts: [newer, older],
      unread: [newer.uri, older.uri]
    } as Partial<PersistedShape>)

    reconcile(store as never)

    expect(unreadUris([newer, older], store.get('read'))).toEqual([newer.uri, older.uri])
  })

  it('leaves nothing of the old key on disk', () => {
    // Through a real config file rather than `bare`'s defaults: `delete` removes what
    // was written, and a default would answer the read either way.
    seedStore('statusky', {
      schemaVersion: 3,
      accounts: [],
      settings: { ...DEFAULT_SETTINGS },
      posts: [newer],
      unread: [newer.uri],
      cursors: {}
    })

    const store = createStore() as unknown as FakeElectronStore<PersistedShape>

    expect(store.data).not.toHaveProperty('unread')
    expect(unreadUris([newer], store.get('read'))).toEqual([newer.uri])
  })

  it('tolerates a config with neither key', () => {
    // Defaults that mention neither: `bare` would answer `posts` from its own, and
    // deleting the key only removes what was written, not what the defaults say.
    const store = new FakeElectronStore<PersistedShape>({
      name: 'postless',
      defaults: {
        schemaVersion: 3,
        accounts: [],
        settings: { ...DEFAULT_SETTINGS },
        cursors: {}
      } as unknown as PersistedShape
    })

    reconcile(store as never)

    expect(store.get('read')).toEqual({ cursors: {}, above: [] })
  })

  it('gives no cursor to a source with nothing cached', () => {
    const store = bare({ posts: [], unread: [] } as Partial<PersistedShape>)
    reconcile(store as never)
    expect(store.get('read')).toEqual({ cursors: {}, above: [] })
  })

  it('skips a cached post whose timestamp does not parse', () => {
    const broken = makePost({ authorDid: DID, rkey: 'broken', createdAt: 'not a date' })
    const store = bare({ posts: [broken], unread: [] } as Partial<PersistedShape>)

    reconcile(store as never)

    expect(store.get('read')).toEqual({ cursors: {}, above: [] })
  })

  it('leaves read state that is already in the new shape alone', () => {
    const read = { cursors: { [DID]: older.createdAt }, above: [newer.uri] }
    const store = bare({ schemaVersion: 4, posts: [newer, older], read })

    reconcile(store as never)

    expect(store.get('read')).toEqual(read)
  })
})

describe('a config with no settings at all', () => {
  it('falls back to the defaults', () => {
    // Defaults that never mentioned `settings`, so `get` returns undefined.
    const store = new FakeElectronStore<PersistedShape>({
      name: 'settingless',
      defaults: {
        schemaVersion: 0,
        accounts: [],
        posts: [],
        unread: [],
        cursors: {}
      } as unknown as PersistedShape
    })

    reconcile(store as never)

    expect(store.get('settings')).toEqual(DEFAULT_SETTINGS)
  })
})

describe('a config with no accounts array at all', () => {
  it('falls back to an empty list before adding the builtins', () => {
    // A store whose defaults do not mention `accounts`, so `get` returns undefined.
    const store = new FakeElectronStore<PersistedShape>({
      name: 'accountless',
      defaults: {
        schemaVersion: 0,
        settings: { ...DEFAULT_SETTINGS },
        posts: [],
        unread: [],
        cursors: {}
      } as unknown as PersistedShape
    })

    reconcile(store as never)

    expect(store.get('accounts').map((a) => a.did)).toEqual(BUILTIN_ACCOUNTS.map((a) => a.did))
  })
})

/** A config file with exactly `data` in it, and no defaults to answer a read. */
function secretStore(data: Partial<PersistedShape> = {}): FakeElectronStore<PersistedShape> {
  const store = new FakeElectronStore<PersistedShape>({
    name: `secret-${Math.random().toString(36).slice(2)}`
  })
  store.set(data as Record<string, unknown>)
  return store
}

/** What the sealed key actually holds, once the envelope is off. */
function unsealed(store: FakeElectronStore<PersistedShape>): string {
  return Buffer.from(String(store.data.webhookSecretEncrypted), 'base64').toString('utf8')
}

describe('the webhook secret', () => {
  it('mints one on a fresh install and seals it before it reaches the disk', () => {
    const store = secretStore()

    const secret = readWebhookSecret(store as never)

    expect(secret).toMatch(/^[\w-]{20,}$/)
    expect(unsealed(store)).toBe(`${SEALED_PREFIX}${secret}`)
    // The whole point: nothing readable is left in statusky.json.
    expect(store.data).not.toHaveProperty('webhookSecret')
    expect(JSON.stringify(store.data)).not.toContain(secret)
  })

  // Regenerating instead would silently break whatever tunnel the user had already
  // pointed at their endpoint, with nothing anywhere to say why deliveries stopped.
  // The re-sealing happens at the first read rather than during `reconcile()`, so an
  // install that never turns the receiver on is never migrated — and never pays for a
  // credential store trip it has no use for. See the test below.
  it('carries a schema 4 plaintext secret into the credential store unchanged', () => {
    const store = secretStore({ schemaVersion: 4, webhookSecret: 'secret-from-schema-4' })
    reconcile(store as never)

    expect(readWebhookSecret(store as never)).toBe('secret-from-schema-4')

    expect(unsealed(store)).toBe(`${SEALED_PREFIX}secret-from-schema-4`)
    expect(store.data).not.toHaveProperty('webhookSecret')
  })

  // `reconcile()` runs inside `createStore()`, early in `bootstrap()` and on the main
  // thread, where a `safeStorage` read is a synchronous round trip into the OS
  // credential store: on macOS an ad-hoc-signed build can be left parked behind a modal
  // Keychain prompt with its tray up and nothing ever polled.
  it('leaves a schema 4 secret where it is until something asks for it', () => {
    const store = secretStore({ schemaVersion: 4, webhookSecret: 'secret-from-schema-4' })

    reconcile(store as never)

    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
    expect(store.data.webhookSecret).toBe('secret-from-schema-4')
  })

  it('reads a sealed secret back out again', () => {
    const store = secretStore()
    writeWebhookSecret(store as never, 'round-trip')

    // A second store over the same file: nothing is remembered in this process.
    const reopened = secretStore({
      webhookSecretEncrypted: store.data.webhookSecretEncrypted as string
    })

    expect(readWebhookSecret(reopened as never)).toBe('round-trip')
  })

  // Not an error. On Linux `isEncryptionAvailable()` is false until a secret service
  // is running and reachable, and refusing to start there would be the worse answer.
  it('keeps the secret in the clear on a machine with no credential store', () => {
    safeStorage.available = false
    const store = secretStore()

    const secret = readWebhookSecret(store as never)

    expect(store.data.webhookSecret).toBe(secret)
    expect(store.data).not.toHaveProperty('webhookSecretEncrypted')
  })

  it('seals a secret that was kept in the clear as soon as a credential store appears', () => {
    safeStorage.available = false
    const store = secretStore()
    const secret = readWebhookSecret(store as never)

    // The secret service is running this time. A new store, because the old one has
    // the answer in memory and will never ask again.
    safeStorage.available = true
    const reopened = secretStore({ webhookSecret: store.data.webhookSecret as string })

    expect(readWebhookSecret(reopened as never)).toBe(secret)
    expect(reopened.data).not.toHaveProperty('webhookSecret')
  })

  // A config carried to another machine, or one whose secret service has been reset.
  // The URL inside that ciphertext can never be shown to the user again, so there is
  // nothing to preserve — only something to say.
  it('mints a new secret when the sealed one cannot be opened, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = secretStore({
      webhookSecretEncrypted: Buffer.from('not ours', 'utf8').toString('base64')
    })

    const secret = readWebhookSecret(store as never)

    expect(secret).toMatch(/^[\w-]{20,}$/)
    expect(unsealed(store)).toBe(`${SEALED_PREFIX}${secret}`)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be decrypted'))
    warn.mockRestore()
  })

  it('mints a new secret when the credential store that sealed it has gone away', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = secretStore()
    const original = readWebhookSecret(store as never)

    safeStorage.available = false
    const reopened = secretStore({
      webhookSecretEncrypted: store.data.webhookSecretEncrypted as string
    })
    const secret = readWebhookSecret(reopened as never)

    expect(secret).not.toBe(original)
    expect(reopened.data.webhookSecret).toBe(secret)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be decrypted'))
    warn.mockRestore()
  })

  // A credential store that answers yes and then refuses the write. Starting without a
  // webhook endpoint would be a worse outcome than storing it the way schema 4 did.
  it('falls back to the clear when the credential store refuses the write', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    safeStorage.encryptThrows = new Error('the keyring is locked')
    const store = secretStore()

    const secret = readWebhookSecret(store as never)

    expect(store.data.webhookSecret).toBe(secret)
    expect(store.data).not.toHaveProperty('webhookSecretEncrypted')
    expect(warn).toHaveBeenCalledWith(
      'The OS credential store refused to hold the webhook secret:',
      expect.any(Error)
    )
    warn.mockRestore()
  })

  // Every request to the receiver asks for this, and every `AppState` carries the
  // endpoint URL built from it. One trip through the OS is all it may cost.
  it('answers later reads from memory rather than from the credential store', () => {
    const store = secretStore()
    const secret = readWebhookSecret(store as never)
    safeStorage.decryptString.mockClear()
    safeStorage.encryptString.mockClear()

    expect(readWebhookSecret(store as never)).toBe(secret)
    expect(readWebhookSecret(store as never)).toBe(secret)

    expect(safeStorage.decryptString).not.toHaveBeenCalled()
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
  })

  it('replaces the secret in place when a new one is minted', () => {
    const store = secretStore()
    readWebhookSecret(store as never)

    writeWebhookSecret(store as never, 'the-new-one')

    expect(readWebhookSecret(store as never)).toBe('the-new-one')
    expect(unsealed(store)).toBe(`${SEALED_PREFIX}the-new-one`)
  })

  it('leaves exactly one representation behind, whichever one it used', () => {
    const store = secretStore({ webhookSecret: 'in the clear' })
    writeWebhookSecret(store as never, 'sealed now')
    expect(Object.keys(store.data)).not.toContain('webhookSecret')

    safeStorage.available = false
    writeWebhookSecret(store as never, 'clear again')
    expect(Object.keys(store.data)).not.toContain('webhookSecretEncrypted')
  })
})

/** A store whose config on disk had these probe targets in its settings. */
function loaded(probeTargets: unknown): FakeElectronStore<PersistedShape> {
  seedStore('statusky', { settings: { ...DEFAULT_SETTINGS, probeTargets } })
  return createStore() as unknown as FakeElectronStore<PersistedShape>
}

describe('the probe targets override', () => {
  /** The checked-in targets with the accounts replaced, as a user's override would be. */
  const override = {
    ...structuredClone(DEFAULT_PROBE_TARGETS),
    accounts: [{ did: 'did:plc:someone', handle: 'someone.test' }]
  }

  it('is absent on a fresh install, and on a config written before there was one', () => {
    expect(createStore().get('settings').probeTargets).toBeNull()
    const { probeTargets: _none, ...older } = DEFAULT_SETTINGS
    seedStore('statusky', { settings: older })
    expect(createStore().get('settings').probeTargets).toBeNull()
  })

  it('survives a restart when it is valid', () => {
    expect(loaded(override).get('settings').probeTargets).toEqual(override)
  })

  it('is dropped for the defaults, with a warning, when it no longer validates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = loaded({ ...override, accounts: [{ did: 'someone', handle: 'someone.test' }] })

    expect(store.get('settings')).toEqual({ ...DEFAULT_SETTINGS, probeTargets: null })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toMatch(/accounts\[0\]\.did/)
    warn.mockRestore()
  })

  it('is dropped, not thrown about, when it is not even an object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => loaded('corrupted')).not.toThrow()
    expect(createStore().get('settings').probeTargets).toBeNull()
    warn.mockRestore()
  })

  it('is stored as none when it says exactly what the defaults say', () => {
    expect(loaded(structuredClone(DEFAULT_PROBE_TARGETS)).get('settings').probeTargets).toBeNull()
  })
})
