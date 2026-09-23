import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '../shared/types'
import { menus, notifications, openedExternally, trays } from './electron'
import { seedStore } from './electron-store'
import { BUILTIN_PROFILES, createHarness, flush, seedFeed, type Harness } from './harness'

/**
 * Whole-app journeys, driven the way the renderer drives the app: through the
 * preload bridge, against a real `Model`, a real store and a fake AppView.
 */

const BSKY = BUILTIN_PROFILES.bsky
const BLACKSKY = BUILTIN_PROFILES.blacksky

let harness: Harness

afterEach(() => {
  harness?.dispose()
})

/**
 * A fixture timestamp counted back from now.
 *
 * These journeys are about what the app is showing at this moment, and the tray only
 * takes its colour from a claim recent enough to still be a report of the present — so
 * a post standing for the current state of the world has to be stamped like one. Tests
 * that only care about ordering keep their fixed dates.
 *
 * Counted from one instant fixed at import, not from the call: a post re-seeded under
 * the same name has to come back with the same timestamp, or the second sync sees it
 * as new and files it unread.
 */
const STARTED = Date.now()
function ago(minutes: number): string {
  return new Date(STARTED - minutes * 60_000).toISOString()
}

/** The latest snapshot the renderer would be holding. */
function rendered(h: Harness): AppState {
  return h.pushes.at(-1) ?? h.state()
}

describe('a first launch', () => {
  it('tracks the shipped accounts, fills the feed and shows a healthy tray', async () => {
    harness = await createHarness()
    // Recent enough to speak for the present, so the tray's colour is these posts' doing.
    seedFeed(harness.appview, BSKY, [
      { text: 'Scheduled maintenance tonight', createdAt: ago(120) },
      { text: 'This incident has been resolved.', createdAt: ago(60) }
    ])
    seedFeed(harness.appview, BLACKSKY, [
      { text: 'All systems are operational', createdAt: ago(180) }
    ])

    await harness.api.Feed.refresh()
    await flush()

    const state = await harness.api.State.get()
    expect(state.posts).toHaveLength(3)
    expect(state.posts[0]?.severity).toBe('resolved')
    // Nothing is unread on a first sync: cursors are seeded silently.
    expect(state.unread).toEqual([])
    expect(notifications).toHaveLength(0)
    expect(trays[0]?.image.path).toContain('trayTemplate.png')
    expect(trays[0]?.tooltip).toContain('All systems operational')
  })
})

describe('an incident arriving while the app is running', () => {
  it('notifies, badges the tray, and clears once the user reads it', async () => {
    harness = await createHarness()
    // What the popover does on mount. The tray assumes reduced motion until a page says
    // otherwise, so without this the heartbeat below would correctly be a badge instead.
    await harness.api.Popover.reduceMotion(false)
    seedFeed(harness.appview, BSKY, [{ text: 'All good', createdAt: ago(30) }])
    await harness.api.Feed.refresh()
    await flush()

    seedFeed(harness.appview, BSKY, [
      { text: 'All good', createdAt: ago(30) },
      { text: 'We are investigating elevated error rates.', createdAt: ago(20) }
    ])
    await harness.api.Feed.refresh()
    await flush()

    // Notified, and the tray is beating because it is unread.
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.options.title).toContain('Investigating')
    expect(rendered(harness).unread).toHaveLength(1)
    expect(trays[0]?.image.path).toMatch(/trayBeat\d+\.png$/)

    // Clicking the notification opens the post and marks it read.
    notifications[0]!.click()
    await flush()

    expect(openedExternally).toHaveLength(1)
    expect(rendered(harness).unread).toEqual([])
    // The beat stops and the icon settles on the colour of the incident itself.
    expect(trays[0]?.image.path).toContain('trayIncident.png')
  })

  it('recovers the tray to amber while monitoring, then to neutral once resolved', async () => {
    harness = await createHarness()
    // Each refresh leaves the new post unread, and an unread post beats over the
    // health colour — so catch up first, then look at what the icon settles on.
    const settle = async (): Promise<string> => {
      await harness.api.Feed.refresh()
      await harness.api.Feed.markAllRead()
      await flush()
      return trays[0]?.image.path ?? ''
    }

    seedFeed(harness.appview, BSKY, [{ text: 'Outage', createdAt: ago(30) }])
    expect(await settle()).toContain('trayIncident.png')

    seedFeed(harness.appview, BSKY, [
      { text: 'Outage', createdAt: ago(30) },
      { text: 'A fix is deployed and we are monitoring.', createdAt: ago(20) }
    ])
    expect(await settle()).toContain('trayMonitoring.png')

    seedFeed(harness.appview, BSKY, [
      { text: 'Outage', createdAt: ago(30) },
      { text: 'A fix is deployed and we are monitoring.', createdAt: ago(20) },
      { text: 'This incident has been resolved.', createdAt: ago(10) }
    ])
    expect(await settle()).toContain('trayTemplate.png')
  })
})

describe('reading the feed', () => {
  it('stays read when the post cache is trimmed out from under it', async () => {
    harness = await createHarness()
    seedFeed(harness.appview, BSKY, [{ text: 'All good', createdAt: ago(30) }])
    await harness.api.Feed.refresh()
    await flush()

    seedFeed(harness.appview, BSKY, [
      { text: 'All good', createdAt: ago(30) },
      { text: 'We are investigating elevated error rates.', createdAt: ago(20) }
    ])
    await harness.api.Feed.refresh()
    await flush()
    expect(rendered(harness).unread).toHaveLength(1)

    await harness.api.Feed.markAllRead()
    await flush()
    expect(rendered(harness).unread).toEqual([])

    // The incident ages out of the cache — and is fetched again on the next sync,
    // which under a list of unread URIs is exactly how it used to come back unread.
    harness.store.set('posts', [])
    await harness.api.Feed.refresh()
    await flush()

    expect(rendered(harness).posts).toHaveLength(2)
    expect(rendered(harness).unread).toEqual([])
    expect(trays[0]?.image.path).toContain('trayIncident.png')
  })

  it('reads one update without reading the older ones under it', async () => {
    harness = await createHarness()
    seedFeed(harness.appview, BSKY, [{ text: 'All good', createdAt: '2026-01-01T09:00:00Z' }])
    await harness.api.Feed.refresh()
    await flush()

    seedFeed(harness.appview, BSKY, [
      { text: 'All good', createdAt: '2026-01-01T09:00:00Z' },
      { text: 'Investigating errors', createdAt: '2026-01-01T10:00:00Z' },
      { text: 'A fix is deployed and we are monitoring.', createdAt: '2026-01-01T11:00:00Z' }
    ])
    await harness.api.Feed.refresh()
    await flush()

    const [newest, middle] = rendered(harness).unread
    expect(rendered(harness).unread).toHaveLength(2)

    await harness.api.Feed.markRead([newest!])
    await flush()
    expect(rendered(harness).unread).toEqual([middle])

    // And "everything older than this" clears the rest in one go.
    await harness.api.Feed.markReadThrough(middle!)
    await flush()
    expect(rendered(harness).unread).toEqual([])
  })
})

describe('tracking another account', () => {
  it('adds it, syncs it, and forgets it again on request', async () => {
    harness = await createHarness()
    const custom = { did: 'did:plc:custom', handle: 'status.example.test' }
    harness.appview.setFeed(custom, [])
    seedFeed(harness.appview, custom, [{ text: 'Degraded performance' }])

    const added = await harness.api.Accounts.add('https://bsky.app/profile/status.example.test')
    expect(added).toMatchObject({ did: custom.did, handle: custom.handle })
    await flush()

    expect((await harness.api.State.get()).accounts).toHaveLength(3)
    expect((await harness.api.State.get()).posts.some((p) => p.authorDid === custom.did)).toBe(true)

    await harness.api.Accounts.remove(custom.did)

    const state = await harness.api.State.get()
    expect(state.accounts).toHaveLength(2)
    expect(state.posts.some((p) => p.authorDid === custom.did)).toBe(false)
  })

  it('refuses to forget a shipped account, but will hide it', async () => {
    harness = await createHarness()
    seedFeed(harness.appview, BSKY, [{ text: 'Outage' }])
    await harness.api.Feed.refresh()
    // Coloured by the outage for as long as the account is heard.
    expect(trays[0]?.image.path).toContain('trayIncident.png')

    await expect(harness.api.Accounts.remove(BSKY.did)).rejects.toThrow(/muted but not removed/)

    await harness.api.Accounts.patch(BSKY.did, { muted: true })

    const state = await harness.api.State.get()
    expect(state.accounts.find((a) => a.did === BSKY.did)?.muted).toBe(true)
    expect(state.posts.some((p) => p.authorDid === BSKY.did)).toBe(false)
    // Muted accounts do not colour the tray.
    expect(trays[0]?.image.path).toContain('trayTemplate.png')
  })
})

describe('settings', () => {
  it('persists across a restart of the app', async () => {
    harness = await createHarness()
    await harness.api.Preferences.patch({
      theme: 'dark',
      pollIntervalSec: 900,
      trayUnreadStyle: 'dot'
    })
    const onDisk = harness.store.data
    harness.dispose()

    // A "restart": the same config file, a brand new process that is told nothing else.
    seedStore('statusky', onDisk)
    harness = await createHarness()

    expect(harness.state().settings).toMatchObject({
      theme: 'dark',
      pollIntervalSec: 900,
      trayUnreadStyle: 'dot'
    })
  })

  it('turning notifications off stops the banners but keeps the unread badge', async () => {
    harness = await createHarness({ settings: { notificationsEnabled: false } })
    seedFeed(harness.appview, BSKY, [{ text: 'Old', createdAt: '2026-01-01T09:00:00Z' }])
    await harness.api.Feed.refresh()

    seedFeed(harness.appview, BSKY, [
      { text: 'Old', createdAt: '2026-01-01T09:00:00Z' },
      { text: 'Investigating', createdAt: '2026-01-01T10:00:00Z' }
    ])
    await harness.api.Feed.refresh()

    expect(notifications).toHaveLength(0)
    expect(rendered(harness).unread).toHaveLength(1)
  })
})

describe('when the network is down', () => {
  it('surfaces the failure and recovers on the next successful refresh', async () => {
    harness = await createHarness()
    harness.appview.fail(BSKY.did, { kind: 'network', message: 'offline' })
    harness.appview.fail(BLACKSKY.did, { kind: 'network', message: 'offline' })

    await harness.api.Feed.refresh()

    expect(rendered(harness).sync.status).toBe('error')
    expect(trays[0]?.tooltip).toContain('Last refresh failed')

    harness.appview.clearFailures()
    seedFeed(harness.appview, BSKY, [{ text: 'Back online' }])
    await harness.api.Feed.refresh()

    expect(rendered(harness).sync).toMatchObject({ status: 'idle', error: null })
    expect(rendered(harness).posts).toHaveLength(1)
  })
})

describe('the tray menu', () => {
  it('refreshes, marks everything read and quits', async () => {
    harness = await createHarness({ cursors: { [BSKY.did]: '2026-01-01T00:00:00Z' } })
    seedFeed(harness.appview, BSKY, [{ text: 'Outage', createdAt: '2026-01-02T00:00:00Z' }])

    trays[0]!.emit('right-click')
    menus[0]!.click('Refresh now')
    await flush()
    expect(rendered(harness).unread).toHaveLength(1)

    menus[0]!.click('Mark all as read')
    expect(rendered(harness).unread).toEqual([])

    menus[0]!.click('Quit Statusky')
    expect(harness.quit).toHaveBeenCalled()
    expect(trays[0]!.destroyed).toBe(true)
  })

  it('opens the popover, and the popover hides itself on request', async () => {
    harness = await createHarness()
    trays[0]!.emit('right-click')

    menus[0]!.click('Open Statusky')
    expect(harness.popover.isVisible()).toBe(true)

    await harness.api.Host.hideWindow()
    expect(harness.popover.isVisible()).toBe(false)
  })
})
