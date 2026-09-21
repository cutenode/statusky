import { describe, expect, it } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import { SERVICES, probeAccount, probePost } from '@shared/network'
import {
  makeAccount,
  makeCheck,
  makeNetworkSummary,
  makePost,
  makeProfile,
  makeService,
  makeSettings,
  makeSnapshot
} from '../../test/factories'
import { chooseOption, pushState, renderApp, settle } from './test/render'
import App from './App.svelte'

/**
 * Whole-UI journeys: everything a user can do from the popover, driven through
 * the rendered app rather than one component at a time.
 */

const bsky = makeAccount({
  did: 'did:plc:bsky',
  handle: 'status.bsky.app',
  displayName: 'Bluesky Status',
  builtin: true
})
const blacksky = makeAccount({
  did: 'did:plc:blacksky',
  handle: 'status.blacksky.community',
  displayName: 'Blacksky Status',
  builtin: true
})

const outage = makePost({
  authorDid: bsky.did,
  authorHandle: bsky.handle,
  rkey: 'outage',
  text: 'We are investigating elevated error rates.',
  createdAt: '2026-01-03T10:00:00Z'
})
const resolved = makePost({
  authorDid: blacksky.did,
  authorHandle: blacksky.handle,
  rkey: 'resolved',
  text: 'This incident has been resolved.',
  createdAt: '2026-01-03T09:00:00Z'
})

const initial = {
  accounts: [bsky, blacksky],
  posts: [outage, resolved],
  unread: [outage.uri],
  sync: { status: 'idle' as const, lastSyncedAt: '2026-01-03T10:05:00Z', error: null },
  // These journeys are about the unread machinery, so they take the manual setting.
  // What the default does instead is its own journey, below.
  settings: makeSettings({ markReadOn: 'never' as const })
}

/** The same state with nothing pinned, so the shipped defaults apply. */
const { settings: _manual, ...outOfTheBox } = initial

describe('reading the timeline', () => {
  it('is already caught up by the time you have looked, out of the box', async () => {
    const { bridge, container } = await renderApp(App, outOfTheBox)

    // The icon was beating; you clicked it; you have now read it. That is the whole
    // transaction for a menu bar app, and it happens before anything is clicked — but
    // what was unread stays on screen, or there would be nothing to have read.
    expect(bridge.api.Feed.markAllRead).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('1 unread')
    expect(container.textContent).toContain('We are investigating elevated error rates.')
  })

  it('shows an incident arriving, lets the user open it, and clears the badge', async () => {
    const { bridge, container, getByRole } = await renderApp(App, { ...initial, unread: [] })

    // It lands while the popover is open, so it is unread in front of you.
    await pushState(bridge, { unread: [outage.uri] })
    expect(getByRole('heading', { level: 1 }).textContent).toContain('Active incident')
    expect(container.textContent).toContain('1 unread')

    // Named specifically: the read chronology below the line carries rows that open
    // the original too, and this journey is about the one that just landed.
    await fireEvent.click(getByRole('button', { name: /elevated error rates.*open the original/ }))

    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(outage.url)
    expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([outage.uri])
    await settle()
    // The count clears as soon as the main process pushes the new state back.
    expect(container.textContent).not.toContain('1 unread')
  })

  it('marks everything read from the header', async () => {
    const { bridge, getByLabelText, queryByLabelText } = await renderApp(App, {
      ...initial,
      unread: []
    })
    await pushState(bridge, { unread: [outage.uri] })

    await fireEvent.click(getByLabelText('Mark all as read'))
    await settle()

    expect(bridge.api.Feed.markAllRead).toHaveBeenCalled()
    expect(queryByLabelText('Mark all as read')).toBeNull()
  })

  it('says so once there is nothing left, and reads on into what came before', async () => {
    const { getByRole, getByText, container } = await renderApp(App, initial)

    // Away and back: the batch the first visit read has fallen below the line, and the
    // top of the timeline says there is nothing new rather than going blank.
    await fireEvent.click(getByRole('tab', { name: 'Feed' }))
    await fireEvent.click(getByRole('tab', { name: 'Timeline' }))

    expect(getByText('All caught up.')).toBeTruthy()
    expect(getByText('Read')).toBeTruthy()
    expect(container.textContent).toContain('We are investigating elevated error rates.')
    expect(container.textContent).toContain('This incident has been resolved.')
  })

  it('points at the feed when there is nothing in the timeline at all', async () => {
    const { getByText, container } = await renderApp(App, { ...initial, posts: [], unread: [] })

    await fireEvent.click(getByText('Browse the feed'))

    expect(container.textContent).toContain('No posts yet')
  })
})

describe('browsing the feed tab', () => {
  it('filters to the unread posts, then back to everything', async () => {
    const { bridge, getByRole, getByText, queryByText } = await renderApp(App, {
      ...initial,
      unread: []
    })
    await fireEvent.click(getByRole('tab', { name: 'Feed' }))
    await pushState(bridge, { unread: [outage.uri] })

    await fireEvent.click(getByText('Unread'))
    expect(queryByText('This incident has been resolved.')).toBeNull()

    await fireEvent.click(getByText('All'))
    expect(queryByText('This incident has been resolved.')).not.toBeNull()
  })
})

describe('managing accounts', () => {
  it('adds an account from the accounts panel', async () => {
    const { bridge, getByLabelText, findByPlaceholderText, getByTitle } = await renderApp(App, {
      ...initial,
      resolves: makeProfile({ did: 'did:plc:new', handle: 'status.example.test' })
    })

    await fireEvent.click(getByLabelText('Accounts'))
    const input = await findByPlaceholderText('handle, DID, or bsky.app profile link')

    await fireEvent.input(input, { target: { value: 'status.example.test' } })
    await fireEvent.click(getByTitle('Track account'))
    await settle()

    expect(bridge.api.Accounts.add).toHaveBeenCalledWith('status.example.test')
    expect(bridge.state.accounts.map((a) => a.handle)).toContain('status.example.test')
  })

  it('hides an account, which drops it out of the health rollup', async () => {
    const { bridge, getByRole, findAllByLabelText, getByLabelText } = await renderApp(App, initial)
    expect(getByRole('heading', { level: 1 }).textContent).toContain('Active incident')

    await fireEvent.click(getByLabelText('Accounts'))
    const [hideBluesky] = await findAllByLabelText('Hide from feed')
    await fireEvent.click(hideBluesky!)
    await settle()

    expect(bridge.api.Accounts.patch).toHaveBeenCalledWith(bsky.did, { muted: true })
    // The muted row flips to "show me again", and the header stops reporting the
    // incident that only that account was reporting.
    expect(getByLabelText('Show in feed')).toBeTruthy()
    expect(getByRole('heading', { level: 1 }).textContent).toContain('All systems operational')
  })
})

describe('changing settings', () => {
  it('turns notifications off and pins the theme', async () => {
    const { bridge, getByLabelText, findByLabelText, getByText } = await renderApp(App, initial)

    await fireEvent.click(getByLabelText('Settings'))

    await fireEvent.click(await findByLabelText('Enable notifications'))
    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ notificationsEnabled: false })

    await chooseOption(getByText('Match system'), 'Dark')
    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('sends a test notification', async () => {
    const { bridge, getByLabelText, findByText } = await renderApp(App, initial)

    await fireEvent.click(getByLabelText('Settings'))
    await fireEvent.click(await findByText('Send test'))

    expect(bridge.api.Host.sendTestNotification).toHaveBeenCalled()
  })
})

describe('when the network goes down and comes back', () => {
  it('shows the failure in the header, then recovers', async () => {
    const { bridge, container, getByRole } = await renderApp(App, initial)

    await pushState(bridge, {
      sync: { status: 'error', lastSyncedAt: null, error: '@status.bsky.app: offline' }
    })

    expect(container.textContent).toContain('Refresh failed')
    expect(container.textContent).toContain('@status.bsky.app: offline')

    await pushState(bridge, {
      sync: { status: 'idle', lastSyncedAt: '2026-01-03T10:10:00Z', error: null }
    })

    expect(container.textContent).not.toContain('Refresh failed')
    expect(getByRole('heading', { level: 1 })).toBeTruthy()
  })
})

describe('a live incident arriving', () => {
  it('appears at the top of the feed, badged and reflected in the header', async () => {
    const calm = makePost({
      authorDid: bsky.did,
      authorHandle: bsky.handle,
      rkey: 'calm',
      text: 'This incident has been resolved.',
      createdAt: '2026-01-03T09:00:00Z'
    })
    const { bridge, container, getByRole, getByText } = await renderApp(App, {
      accounts: [bsky],
      posts: [calm],
      unread: []
    })

    expect(getByRole('heading', { level: 1 }).textContent).toContain('All systems operational')

    const fresh = makePost({
      authorDid: bsky.did,
      authorHandle: bsky.handle,
      rkey: 'fresh',
      text: 'Major outage affecting the AppView.',
      createdAt: '2026-01-03T11:00:00Z'
    })
    await pushState(bridge, { posts: [fresh, calm], unread: [fresh.uri] })

    expect(getByRole('heading', { level: 1 }).textContent).toContain('Active incident')
    expect(getByText('Major outage affecting the AppView.')).toBeTruthy()
    expect(container.textContent).toContain('1 unread')
  })
})

describe('a relay going down, measured', () => {
  it('shows in the header, the alerts and the dashboard, each leading to the next', async () => {
    const relay = SERVICES.find((s) => s.id === 'relay:europe.firehose.network')!
    const entry = probePost({
      service: relay,
      from: 'up',
      to: 'down',
      at: '2026-01-03T10:30:00.000Z',
      since: '2026-01-03T09:00:00.000Z',
      checks: [makeCheck({ label: 'firehose', ok: false, error: 'No commits received' })]
    })
    const snapshot = makeSnapshot({
      finishedAt: '2026-01-03T10:31:00.000Z',
      services: [
        makeService({ id: 'relay:bsky.network' }),
        makeService({
          id: 'relay:europe.firehose.network',
          state: 'down',
          condition: 'down',
          since: '2026-01-03T10:30:00.000Z',
          checks: [
            makeCheck({
              label: 'firehose',
              kind: 'stream',
              ok: false,
              error: 'No commits received'
            })
          ]
        })
      ]
    })
    const { bridge, container, getByRole, getByLabelText, getByText, queryByText } =
      await renderApp(App, {
        accounts: [blacksky, probeAccount('2026-01-01T00:00:00Z')],
        posts: [entry, resolved],
        // Nothing unread at open, then the entry lands: the Timeline catches up on
        // sight, and this journey is about clicking the entry itself marking it read.
        unread: [],
        // Manual, so the Alerts tab does not read it out from under the click either.
        settings: makeSettings({ markReadOn: 'never' as const }),
        snapshot,
        network: makeNetworkSummary({
          health: 'down',
          total: 2,
          reachable: 1,
          down: ['europe.firehose.network'],
          lastSweepAt: snapshot.finishedAt
        })
      })
    await pushState(bridge, { unread: [entry.uri] })

    // The header leads with the measurement, since the status accounts are quiet.
    expect(getByRole('heading', { level: 1 }).textContent).toContain(
      'europe.firehose.network is unreachable'
    )
    expect(getByRole('tab', { name: 'Network' }).textContent).toContain('1')

    // Nobody posted this, so it is filed under Alerts rather than in the feed.
    await fireEvent.click(getByRole('tab', { name: 'Feed' }))
    expect(queryByText(/europe\.firehose\.network is not responding from this computer/)).toBeNull()

    await fireEvent.click(getByRole('tab', { name: 'Alerts' }))
    expect(getByText(/europe\.firehose\.network is not responding from this computer/)).toBeTruthy()

    // And the entry links into the dashboard.
    await fireEvent.click(getByLabelText('Show on the network dashboard'))
    await settle()
    await settle()

    expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([entry.uri])
    const row = container.querySelector('[data-service="relay:europe.firehose.network"]')!
    expect(row.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
    expect(row.textContent).toContain('No commits received')
    expect(row.textContent).toContain('Unreachable for')

    // It comes back: the next push clears the headline.
    await pushState(bridge, {
      network: makeNetworkSummary({ health: 'operational', total: 2, reachable: 2 })
    })
    expect(getByRole('heading', { level: 1 }).textContent).toContain('All systems operational')
  })
})
