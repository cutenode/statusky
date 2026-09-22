/**
 * What the model does with a pushed delivery.
 *
 * The socket itself is covered in `webhook.test.ts`; everything here is about the
 * consequences — which source a delivery is filed under, what becomes unread, what
 * raises a notification, and what a refresh must leave alone.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_WEBHOOK_SOURCES } from '../shared/defaults'
import { BUILTIN_PROFILES, createHarness, flush, seedFeed, waitFor } from '../test/harness'
import type { Harness } from '../test/harness'
import { makeAccount } from '../test/factories'
import { safeStorage } from '../test/electron'

const BSKY = BUILTIN_PROFILES.bsky

let harness: Harness

async function boot(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness({ tray: false, ...options })
  return harness
}

afterEach(() => {
  harness?.dispose()
})

const SOURCE_DID = 'webhook:pg_bsky'

interface UpdateSpec {
  id: string
  status: string
  created_at: string
  body?: string
}

function payload(updates: UpdateSpec[], page = 'pg_bsky'): unknown {
  return {
    page: { id: page, url: 'https://status.bsky.app', status_description: 'Degraded' },
    incident: {
      id: 'inc_1',
      name: 'Elevated error rates',
      status: updates[0]?.status ?? 'INVESTIGATING',
      url: 'https://status.bsky.app/incidents/inc_1',
      created_at: '2026-03-01T09:00:00.000Z',
      incident_updates: updates.map((u) => ({ body: 'Something happened.', ...u }))
    }
  }
}

const FIRST: UpdateSpec = {
  id: 'u1',
  status: 'INVESTIGATING',
  created_at: '2026-03-01T09:00:00.000Z'
}
const SECOND: UpdateSpec = {
  id: 'u2',
  status: 'IDENTIFIED',
  created_at: '2026-03-01T09:30:00.000Z'
}
const THIRD: UpdateSpec = {
  id: 'u3',
  status: 'RESOLVED',
  created_at: '2026-03-01T10:00:00.000Z'
}

describe('the first delivery from a page', () => {
  it('registers it as a tracked source named after its hostname', async () => {
    const h = await boot()

    h.model.ingestWebhook(payload([FIRST]))

    const source = h.state().accounts.find((a) => a.did === SOURCE_DID)
    expect(source).toMatchObject({
      handle: 'status.bsky.app',
      displayName: 'status.bsky.app',
      description: 'Degraded',
      kind: 'webhook',
      builtin: false,
      notify: true,
      muted: false
    })
  })

  it('files its updates into the feed, newest first', async () => {
    const h = await boot()

    h.model.ingestWebhook(payload([THIRD, SECOND, FIRST]))

    const posts = h.state().posts
    expect(posts.map((p) => p.rkey)).toEqual([
      'incident/inc_1/u3',
      'incident/inc_1/u2',
      'incident/inc_1/u1'
    ])
    expect(posts[0]!.severity).toBe('resolved')
  })

  it('announces the newest update but stays quiet about the backlog behind it', async () => {
    const h = await boot()

    h.model.ingestWebhook(payload([THIRD, SECOND, FIRST]))

    expect(h.notified).toHaveLength(1)
    expect(h.notified[0]!.map((p) => p.rkey)).toEqual(['incident/inc_1/u3'])
    expect(h.state().unread).toEqual(['webhook:pg_bsky/incident/inc_1/u3'])
  })

  it('pushes a fresh snapshot to the renderer', async () => {
    const h = await boot()
    const before = h.pushes.length

    h.model.ingestWebhook(payload([FIRST]))

    expect(h.pushes.length).toBeGreaterThan(before)
    expect(h.pushes.at(-1)!.posts).toHaveLength(1)
  })
})

describe('later deliveries', () => {
  it('announces only what the cursor has not already covered', async () => {
    const h = await boot()
    h.model.ingestWebhook(payload([FIRST]))
    h.notified.length = 0

    // A status page resends the whole history every time.
    h.model.ingestWebhook(payload([THIRD, SECOND, FIRST]))

    expect(h.notified).toHaveLength(1)
    expect(h.notified[0]!.map((p) => p.rkey)).toEqual(['incident/inc_1/u2', 'incident/inc_1/u3'])
  })

  it('is free to redeliver: the same payload adds and announces nothing', async () => {
    const h = await boot()
    h.model.ingestWebhook(payload([SECOND, FIRST]))
    h.notified.length = 0
    const posts = h.state().posts.length

    h.model.ingestWebhook(payload([SECOND, FIRST]))

    expect(h.state().posts).toHaveLength(posts)
    expect(h.notified).toEqual([])
  })

  it('keeps the source name current when the page moves host', async () => {
    const h = await boot()
    h.model.ingestWebhook(payload([FIRST]))

    h.model.ingestWebhook({
      page: { id: 'pg_bsky', url: 'https://status.bsky.team', status_description: 'All good' },
      incident: { id: 'inc_2', name: 'Another', status: 'RESOLVED' }
    })

    expect(h.state().accounts.find((a) => a.did === SOURCE_DID)).toMatchObject({
      handle: 'status.bsky.team',
      displayName: 'status.bsky.team',
      description: 'All good'
    })
  })

  it('separates two different pages into two sources', async () => {
    const h = await boot()

    h.model.ingestWebhook(payload([FIRST], 'pg_bsky'))
    h.model.ingestWebhook(payload([FIRST], 'pg_other'))

    expect(
      h
        .state()
        .accounts.filter((a) => a.kind === 'webhook')
        .map((a) => a.did)
    ).toEqual(['webhook:pg_bsky', 'webhook:pg_other'])
  })
})

describe('a delivery the app will not act on', () => {
  it('still pushes, so the delivery counter in settings is honest', async () => {
    const h = await boot()
    const before = h.pushes.length

    h.model.ingestWebhook({ ping: true })

    expect(h.pushes.length).toBe(before + 1)
    expect(h.state().accounts.filter((a) => a.kind === 'webhook')).toEqual([])
    expect(h.state().posts).toEqual([])
  })

  it('caps how many pages may register themselves', async () => {
    const sources = Array.from({ length: MAX_WEBHOOK_SOURCES }, (_, i) =>
      makeAccount({ did: `webhook:pg${i}`, kind: 'webhook', handle: `s${i}.test` })
    )
    const h = await boot({ accounts: sources })

    h.model.ingestWebhook(payload([FIRST], 'one-too-many'))

    expect(h.state().accounts.some((a) => a.did === 'webhook:one-too-many')).toBe(false)
    expect(h.state().posts).toEqual([])
  })

  it('still accepts deliveries from a page that is already registered at the cap', async () => {
    const sources = Array.from({ length: MAX_WEBHOOK_SOURCES }, (_, i) =>
      makeAccount({ did: `webhook:pg${i}`, kind: 'webhook', handle: `s${i}.test` })
    )
    const h = await boot({ accounts: sources })

    h.model.ingestWebhook(payload([FIRST], 'pg0'))

    expect(h.state().posts).toHaveLength(1)
  })
})

describe('a pushed source behaves like any other', () => {
  it('is hidden from the feed while it is muted, and raises nothing unread', async () => {
    const h = await boot({
      accounts: [makeAccount({ did: SOURCE_DID, kind: 'webhook', muted: true })],
      cursors: { [SOURCE_DID]: '2026-03-01T00:00:00.000Z' }
    })

    h.model.ingestWebhook(payload([FIRST]))

    expect(h.state().posts).toEqual([])
    expect(h.state().unread).toEqual([])
    expect(h.notified).toEqual([])
    // Hidden, not forgotten: the posts are still persisted.
    expect(h.store.get('posts')).toHaveLength(1)
  })

  it('marks updates unread but stays silent when its notifications are off', async () => {
    const h = await boot({
      accounts: [makeAccount({ did: SOURCE_DID, kind: 'webhook', notify: false })],
      cursors: { [SOURCE_DID]: '2026-03-01T00:00:00.000Z' }
    })

    h.model.ingestWebhook(payload([FIRST]))

    expect(h.state().unread).toHaveLength(1)
    expect(h.notified).toEqual([])
  })

  it('stays silent while notifications are off altogether', async () => {
    const h = await boot({ settings: { notificationsEnabled: false } })

    h.model.ingestWebhook(payload([FIRST]))

    expect(h.notified).toEqual([])
    expect(h.state().posts).toHaveLength(1)
  })

  it('can be removed, taking its posts and its cursor with it', async () => {
    const h = await boot()
    h.model.ingestWebhook(payload([FIRST]))

    await h.api.Accounts.remove(SOURCE_DID)

    expect(h.state().accounts.some((a) => a.did === SOURCE_DID)).toBe(false)
    expect(h.store.get('posts')).toEqual([])
    expect(h.store.get('cursors')[SOURCE_DID]).toBeUndefined()
  })
})

describe('refreshing while a pushed source is tracked', () => {
  it('never reaches out for one', async () => {
    const h = await boot()
    h.model.ingestWebhook(payload([FIRST]))

    await h.api.Feed.refresh()

    // The fake AppView knows nothing about `webhook:pg_bsky`; asking would fail the sync.
    expect(h.state().sync.error).toBeNull()
  })

  it('leaves its posts in the feed', async () => {
    const h = await boot()
    h.model.ingestWebhook(payload([FIRST]))
    seedFeed(h.appview, BSKY, [{ text: 'Investigating connectivity issues.' }])

    await h.api.Feed.refresh()

    expect(h.state().posts.some((p) => p.authorDid === SOURCE_DID)).toBe(true)
    expect(h.state().posts.some((p) => p.authorDid === BSKY.did)).toBe(true)
  })

  it('is a no-op when there is nothing else left to poll', async () => {
    const h = await boot({
      accounts: [makeAccount({ did: SOURCE_DID, kind: 'webhook' })],
      seedAppView: false
    })
    // The builtins are reconciled back in on every boot; mute is not enough, so drop
    // them and leave the pushed source alone.
    for (const account of h.state().accounts.filter((a) => a.kind !== 'webhook')) {
      h.store.set(
        'accounts',
        h.store.get('accounts').filter((a) => a.did !== account.did)
      )
    }

    await h.api.Feed.refresh()

    expect(h.state().sync).toMatchObject({ status: 'idle', error: null })
  })
})

describe('the receiver lifecycle', () => {
  it('is off until the setting says otherwise', async () => {
    const h = await boot()

    expect(h.state().webhook).toMatchObject({ state: 'off', url: null, port: null })
  })

  // `AppState.webhook.url` embeds the secret, so a state push is the other thing that
  // could have dragged the OS credential store onto the startup path. It cannot: there
  // is no URL to build until the receiver is listening, and reading the secret is a
  // synchronous trip into the credential store — on macOS a Keychain call that can park
  // the main thread. Turning the receiver on is the first moment the value is genuinely
  // needed, by which point the app has been up for as long as the user has been in it.
  it('opens no credential store until the receiver is turned on', async () => {
    const h = await boot()
    h.model.start()
    await flush()

    expect(h.state().webhook.url).toBeNull()
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
    expect(safeStorage.decryptString).not.toHaveBeenCalled()

    await h.api.Preferences.patch({ webhookEnabled: true, webhookPort: 0 })
    await waitFor(() => h.state().webhook.state === 'listening', 'the receiver to bind')

    expect(safeStorage.encryptString).toHaveBeenCalled()
  })

  it('starts listening when the setting is turned on, and stops when it is turned off', async () => {
    const h = await boot()

    await h.api.Preferences.patch({ webhookEnabled: true, webhookPort: 0 })
    await waitFor(() => h.state().webhook.state === 'listening', 'the receiver to bind')

    expect(h.state().webhook.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhook\/.+/)

    await h.api.Preferences.patch({ webhookEnabled: false })
    await waitFor(() => h.state().webhook.state === 'off', 'the receiver to stop')

    expect(h.state().webhook.url).toBeNull()
  })

  it('starts on launch when the setting was already on', async () => {
    const h = await boot({ settings: { webhookEnabled: true, webhookPort: 0 } })

    h.model.start()
    await waitFor(() => h.state().webhook.state === 'listening', 'the receiver to bind')

    expect(h.state().webhook.port).toBeGreaterThan(0)
  })

  it('gives up the socket when the app stops', async () => {
    const h = await boot({ settings: { webhookEnabled: true, webhookPort: 0 } })
    h.model.start()
    await waitFor(() => h.state().webhook.state === 'listening', 'the receiver to bind')
    const url = h.state().webhook.url!

    h.model.stop()
    await waitFor(() => h.model.webhookStatus.state === 'off', 'the receiver to stop')

    await expect(fetch(url)).rejects.toThrow()
  })

  it('leaves the receiver alone when an unrelated setting changes', async () => {
    const h = await boot({ settings: { webhookEnabled: true, webhookPort: 0 } })
    h.model.start()
    await waitFor(() => h.state().webhook.state === 'listening', 'the receiver to bind')
    const port = h.state().webhook.port

    await h.api.Preferences.patch({ theme: 'dark' })
    await flush()

    expect(h.state().webhook.port).toBe(port)
  })

  it('mints a new secret on request, invalidating the URL already given out', async () => {
    const h = await boot({ settings: { webhookEnabled: true, webhookPort: 0 } })
    h.model.start()
    await waitFor(() => h.state().webhook.state === 'listening', 'the receiver to bind')
    const before = h.state().webhook.url!

    const after = await h.api.Webhook.regenerateSecret()

    expect(after.url).not.toBe(before)
    expect(h.state().webhook.url).toBe(after.url)
    expect((await fetch(before)).status).toBe(404)
    expect((await fetch(after.url!)).status).toBe(200)
  })
})

describe('end to end, over a real socket', () => {
  it('turns an HTTP delivery into a feed entry and a notification', async () => {
    const h = await boot({ settings: { webhookEnabled: true, webhookPort: 0 } })
    h.model.start()
    await waitFor(() => h.state().webhook.state === 'listening', 'the receiver to bind')
    const url = h.state().webhook.url!

    const seed = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload([FIRST]))
    })
    expect(seed.status).toBe(200)

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload([SECOND, FIRST]))
    })

    expect(response.status).toBe(200)
    expect(h.state().webhook.deliveries).toBe(2)
    expect(h.state().posts.map((p) => p.rkey)).toEqual(['incident/inc_1/u2', 'incident/inc_1/u1'])
    expect(h.state().accounts.find((a) => a.did === SOURCE_DID)?.handle).toBe('status.bsky.app')
    expect(h.notified.at(-1)!.map((p) => p.severity)).toEqual(['identified'])
  })
})
