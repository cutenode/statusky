import { describe, expect, it } from 'vitest'
import { BUILTIN_ACCOUNTS, DEFAULT_SETTINGS } from '../shared/defaults'
import { unreadUris } from './state'
import { createStore, reconcile } from './store'
import FakeElectronStore, { seedStore } from '../test/electron-store'
import type { PersistedShape } from './store'
import { makeAccount, makePost } from '../test/factories'

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
    expect(store.get('webhookSecret')).toMatch(/^[\w-]{20,}$/)
    expect(store.get('schemaVersion')).toBe(4)
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
          notify: false,
          builtin: true
        })
      ]
    })

    const store = createStore() as unknown as FakeElectronStore<PersistedShape>
    const account = store.get('accounts').find((a) => a.did === BUILTIN_ACCOUNTS[0]!.did)

    expect(account?.muted).toBe(true)
    expect(account?.notify).toBe(false)
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

  it('tolerates a config with no accounts key at all', () => {
    const store = bare({})
    store.delete('accounts')

    reconcile(store as never)

    expect(store.get('accounts')).toHaveLength(BUILTIN_ACCOUNTS.length)
  })

  it('stamps the current schema version', () => {
    const store = bare({})
    reconcile(store as never)
    expect(store.get('schemaVersion')).toBe(4)
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
    const store = bare({})
    store.delete('posts')

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
