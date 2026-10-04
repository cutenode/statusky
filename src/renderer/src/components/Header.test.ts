import { describe, expect, it, vi } from 'vitest'
import { fireEvent, within } from '@testing-library/svelte'
import { HEALTH_LABEL } from '@shared/status'
import { SERVICES, probeAccount, probePost } from '@shared/network'
import { nav } from '$lib/nav.svelte'
import {
  makeAccount,
  makeNetworkSummary,
  makePost,
  makeSettings,
  makeSnapshot
} from '../../../test/factories'
import { pushNetwork, pushState, renderWith, settle } from '../test/render'
import Header from './Header.svelte'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const account = makeAccount({ did: 'did:plc:a' })

describe('the health summary', () => {
  it('reports all systems operational', async () => {
    const { getByRole } = await renderWith(
      Header,
      { now: NOW },
      { accounts: [account], posts: [makePost({ authorDid: account.did, severity: 'resolved' })] }
    )

    expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe(HEALTH_LABEL.operational)
  })

  it('reports an active incident, and pulses the dot', async () => {
    const { getByRole, container } = await renderWith(
      Header,
      { now: NOW },
      { accounts: [account], posts: [makePost({ authorDid: account.did, severity: 'outage' })] }
    )

    expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe(HEALTH_LABEL.incident)
    expect(container.querySelector('[class*="animate-ping"]')).not.toBeNull()
  })

  it('reports no data before the first sync', async () => {
    const { getByRole } = await renderWith(Header, { now: NOW })
    expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe(HEALTH_LABEL.unknown)
  })
})

describe('the status line', () => {
  it('shows when the feed was last checked', async () => {
    const { container } = await renderWith(
      Header,
      { now: NOW },
      { sync: { status: 'idle', lastSyncedAt: '2026-01-01T11:55:00Z', error: null } }
    )
    expect(container.textContent).toContain('Last checked 5 minutes ago')
  })

  it('says "never" before the first sync', async () => {
    const { container } = await renderWith(
      Header,
      { now: NOW },
      { sync: { status: 'idle', lastSyncedAt: null, error: null } }
    )
    expect(container.textContent).toContain('Last checked never')
  })

  it('says it is checking while a sync runs', async () => {
    const { container } = await renderWith(
      Header,
      { now: NOW },
      { sync: { status: 'syncing', lastSyncedAt: null, error: null } }
    )
    expect(container.textContent).toContain('Checking for updates')
  })

  it('shows the unread count when there is one', async () => {
    const post = makePost({ authorDid: account.did })
    const { container } = await renderWith(
      Header,
      { now: NOW },
      { accounts: [account], posts: [post], unread: [post.uri] }
    )
    expect(container.textContent).toContain('1 unread')
  })

  it('surfaces the refresh error and the failure detail', async () => {
    const { container } = await renderWith(
      Header,
      { now: NOW },
      { sync: { status: 'error', lastSyncedAt: null, error: '@status.bsky.app: offline' } }
    )

    expect(container.textContent).toContain('Refresh failed')
    expect(container.textContent).toContain('@status.bsky.app: offline')
  })
})

describe('the actions', () => {
  it('refreshes on demand', async () => {
    const { bridge, getByLabelText } = await renderWith(Header, { now: NOW })
    await fireEvent.click(getByLabelText('Refresh now'))
    expect(bridge.api.Feed.refresh).toHaveBeenCalled()
  })

  it('disables refresh while a sync is running', async () => {
    const { getByLabelText, container } = await renderWith(
      Header,
      { now: NOW },
      { sync: { status: 'syncing', lastSyncedAt: null, error: null } }
    )

    expect((getByLabelText('Refresh now') as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('offers mark-all-read only when something is unread', async () => {
    const post = makePost({ authorDid: account.did })
    const { bridge, queryByLabelText } = await renderWith(
      Header,
      { now: NOW },
      { accounts: [account], posts: [post], unread: [post.uri] }
    )

    const button = queryByLabelText('Mark all as read')
    expect(button).not.toBeNull()

    await fireEvent.click(button!)
    expect(bridge.api.Feed.markAllRead).toHaveBeenCalled()

    await pushState(bridge, { unread: [] })
    expect(queryByLabelText('Mark all as read')).toBeNull()
  })

  it('closes the popover', async () => {
    const { bridge, getByLabelText } = await renderWith(Header, { now: NOW })
    await fireEvent.click(getByLabelText('Close'))
    expect(bridge.api.Host.hideWindow).toHaveBeenCalled()
  })
})

describe('the panel icons', () => {
  it.each(['Accounts', 'Settings'])('opens the %s panel', async (label) => {
    const { getByLabelText } = await renderWith(Header, { now: NOW })
    const button = getByLabelText(label)
    expect(button.getAttribute('aria-pressed')).toBe('false')

    await fireEvent.click(button)

    expect(getByLabelText(label).getAttribute('aria-pressed')).toBe('true')
  })

  it('presses out again, which sends the popover back to the feed', async () => {
    const { getByLabelText } = await renderWith(Header, { now: NOW })

    await fireEvent.click(getByLabelText('Accounts'))
    await fireEvent.click(getByLabelText('Accounts'))

    expect(getByLabelText('Accounts').getAttribute('aria-pressed')).toBe('false')
  })

  it('shows one panel at a time', async () => {
    const { getByLabelText } = await renderWith(Header, { now: NOW })

    await fireEvent.click(getByLabelText('Accounts'))
    await fireEvent.click(getByLabelText('Settings'))

    expect(getByLabelText('Accounts').getAttribute('aria-pressed')).toBe('false')
    expect(getByLabelText('Settings').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('window dragging', () => {
  it('makes the header a drag region but keeps the buttons clickable', async () => {
    const { container } = await renderWith(Header, { now: NOW })
    expect(container.querySelector('header')?.className).toContain('drag-region')
    expect(container.querySelector('.no-drag')).not.toBeNull()
  })
})

describe('the clock', () => {
  it('re-renders relative time when `now` advances', async () => {
    const { container, rerender } = await renderWith(
      Header,
      { now: NOW },
      { sync: { status: 'idle', lastSyncedAt: '2026-01-01T11:59:00Z', error: null } }
    )
    expect(container.textContent).toContain('1 minute ago')

    await rerender({ now: NOW + 3_600_000 })

    expect(container.textContent).toContain('1 hour ago')
  })
})

describe('who the headline is quoting', () => {
  const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString()
  const bluesky = makeAccount({ did: 'did:plc:bsky', displayName: 'Bluesky Status' })
  const blacksky = makeAccount({ did: 'did:plc:black', displayName: 'Blacksky Status' })

  it('names the source and how long ago, instead of when we last polled', async () => {
    const { container, getByRole } = await renderWith(
      Header,
      { now: NOW },
      {
        accounts: [bluesky],
        posts: [makePost({ authorDid: bluesky.did, severity: 'outage', createdAt: hoursAgo(2) })],
        sync: { status: 'idle', lastSyncedAt: '2026-01-01T11:55:00Z', error: null }
      }
    )

    expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe(HEALTH_LABEL.incident)
    expect(container.textContent).toContain('Bluesky Status · 2 hours ago')
    expect(container.textContent).not.toContain('Last checked')
  })

  it('keeps the claim on screen once it has stopped setting the verdict', async () => {
    const { container, getByRole } = await renderWith(
      Header,
      { now: NOW },
      {
        accounts: [blacksky],
        posts: [
          makePost({ authorDid: blacksky.did, severity: 'maintenance', createdAt: hoursAgo(72) })
        ],
        network: makeNetworkSummary({ health: 'operational' })
      }
    )

    // The verdict has gone back to what this machine measured; the post is still named,
    // with its age, rather than dropped without a word.
    expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe(HEALTH_LABEL.operational)
    expect(container.textContent).toContain('Blacksky Status reported maintenance 3 days ago')
  })

  it('will not claim there is no data while it is quoting somebody', async () => {
    const { getByRole, container } = await renderWith(
      Header,
      { now: NOW },
      {
        accounts: [blacksky],
        posts: [makePost({ authorDid: blacksky.did, severity: 'outage', createdAt: hoursAgo(72) })],
        network: makeNetworkSummary({ health: 'off' })
      }
    )

    expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe('Nothing reported recently')
    expect(container.textContent).toContain('Blacksky Status reported an incident 3 days ago')
  })

  it('counts the other sources saying the same thing', async () => {
    const { container } = await renderWith(
      Header,
      { now: NOW },
      {
        accounts: [bluesky, blacksky],
        posts: [
          makePost({ authorDid: bluesky.did, severity: 'outage', createdAt: hoursAgo(3) }),
          makePost({ authorDid: blacksky.did, severity: 'outage', createdAt: hoursAgo(1) })
        ]
      }
    )

    expect(container.textContent).toContain('Blacksky Status +1 · 1 hour ago')
  })

  it('goes back to the last check when nobody is being quoted', async () => {
    const { container } = await renderWith(
      Header,
      { now: NOW },
      {
        accounts: [bluesky],
        posts: [makePost({ authorDid: bluesky.did, severity: 'resolved', createdAt: hoursAgo(1) })],
        sync: { status: 'idle', lastSyncedAt: '2026-01-01T11:55:00Z', error: null }
      }
    )

    expect(container.textContent).toContain('Last checked 5 minutes ago')
  })

  it('lets a sync failure have the line, since it is about whether any of this is current', async () => {
    const { container } = await renderWith(
      Header,
      { now: NOW },
      {
        accounts: [bluesky],
        posts: [makePost({ authorDid: bluesky.did, severity: 'outage', createdAt: hoursAgo(2) })],
        sync: { status: 'idle', lastSyncedAt: null, error: 'AppView unreachable' }
      }
    )

    expect(container.textContent).toContain('Refresh failed')
    expect(container.textContent).not.toContain('Bluesky Status ·')
  })
})

describe('the network in the headline', () => {
  it('names a service the checks found down while the accounts are quiet', async () => {
    const { getByRole } = await renderWith(
      Header,
      { now: NOW },
      {
        accounts: [account],
        posts: [makePost({ authorDid: account.did, severity: 'resolved' })],
        network: makeNetworkSummary({ health: 'down', down: ['europe.firehose.network'] })
      }
    )
    const heading = getByRole('heading', { level: 1 })
    expect(heading.textContent?.trim()).toBe('europe.firehose.network is unreachable')
    expect(heading.className).toContain('text-sev-outage')
  })

  it('says so when this machine is offline', async () => {
    const { getByRole } = await renderWith(
      Header,
      { now: NOW },
      { network: makeNetworkSummary({ health: 'offline' }) }
    )
    expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe(HEALTH_LABEL.offline)
  })
})

const tab = (getByRole: (role: string, options: { name: RegExp }) => HTMLElement, name: RegExp) =>
  getByRole('tab', { name })

describe('the tabs', () => {
  it('starts on the timeline', async () => {
    const { getByRole } = await renderWith(Header, { now: NOW })
    expect(tab(getByRole, /Timeline/).getAttribute('aria-selected')).toBe('true')
    for (const name of [/^Feed$/, /Network/]) {
      expect(tab(getByRole, name).getAttribute('aria-selected')).toBe('false')
    }
  })

  it.each([
    [/^Feed$/, 'feed', 1],
    [/Network/, 'network', 2]
  ])('switches to %s, sliding the indicator across', async (name, view, index) => {
    const { getByRole, container } = await renderWith(Header, { now: NOW })
    await fireEvent.click(tab(getByRole, name))

    expect(nav.view).toBe(view)
    expect(tab(getByRole, name).getAttribute('aria-selected')).toBe('true')
    const indicator = container.querySelector('[role="tablist"] > span') as HTMLElement
    expect(indicator.style.transform).toBe(`translateX(calc(${index * 100}% + ${index * 2}px))`)
  })

  it('names only the selected tab, leaving the rest to their icons', async () => {
    const { getByRole } = await renderWith(Header, { now: NOW })
    expect(tab(getByRole, /Timeline/).textContent).toContain('Timeline')
    expect(tab(getByRole, /^Feed$/).textContent).not.toContain('Feed')
  })

  it('selects none while a detour is open', async () => {
    const { getByRole, getByLabelText, container } = await renderWith(Header, { now: NOW })
    await fireEvent.click(getByLabelText('Settings'))
    expect(tab(getByRole, /Timeline/).getAttribute('aria-selected')).toBe('false')
    const indicator = container.querySelector('[role="tablist"] > span') as HTMLElement
    expect(indicator.className).toContain('opacity-0')

    await fireEvent.click(tab(getByRole, /Timeline/))
    expect(nav.view).toBe('timeline')
  })

  it('counts unread updates on the tabs they belong to', async () => {
    const post = makePost({ authorDid: account.did })
    const alert = probePost({
      service: SERVICES[0]!,
      from: 'up',
      to: 'down',
      at: '2026-01-03T10:00:00.000Z',
      since: '2026-01-03T09:00:00.000Z',
      checks: []
    })
    const { getByRole } = await renderWith(
      Header,
      { now: NOW },
      {
        accounts: [account, probeAccount('2026-01-01T00:00:00Z')],
        posts: [post, alert],
        unread: [post.uri, alert.uri]
      }
    )

    // Both on the timeline, which shows everything; only the post on the feed, where
    // the measurement is not listed.
    expect(within(tab(getByRole, /Timeline/)).getByText('2 unread')).toBeTruthy()
    expect(within(tab(getByRole, /^Feed$/)).getByText('1 unread')).toBeTruthy()
  })

  // The tab's name is its label, so a count in it went unheard: it is the description.
  it('says each count to a screen reader as the tab’s description', async () => {
    const post = makePost({ authorDid: account.did })
    const { getByRole } = await renderWith(
      Header,
      { now: NOW },
      {
        accounts: [account],
        posts: [post],
        unread: [post.uri],
        network: makeNetworkSummary({ health: 'down', down: ['a'] })
      }
    )

    expect(getByRole('tab', { name: 'Feed', description: '1 unread' })).toBeTruthy()
    expect(getByRole('tab', { name: 'Network', description: '1 with problems' })).toBeTruthy()
  })

  it('points at no description when there is nothing to count', async () => {
    const { getByRole } = await renderWith(Header, { now: NOW })
    expect(tab(getByRole, /^Feed$/).hasAttribute('aria-describedby')).toBe(false)
    expect(tab(getByRole, /Network/).hasAttribute('aria-describedby')).toBe(false)
  })

  it('names each tab in a tooltip, since only the selected one spells itself out', async () => {
    const { getByRole, findByText } = await renderWith(Header, { now: NOW })

    await fireEvent.focus(tab(getByRole, /^Feed$/))

    expect(await findByText('Feed')).toBeTruthy()
  })

  it.each([
    ['says the checks are off', makeNetworkSummary({ health: 'off' }), 'Off'],
    ['shows it is offline', makeNetworkSummary({ health: 'offline' }), 'Offline'],
    ['shows a sweep running', makeNetworkSummary({ health: 'unknown', running: true }), 'Checking'],
    [
      'counts problems in red when anything is down',
      makeNetworkSummary({ health: 'down', down: ['a'], degraded: ['b'] }),
      '2 with problems'
    ],
    [
      'counts problems in amber when nothing is down',
      makeNetworkSummary({ health: 'degraded', degraded: ['b'] }),
      '1 with problems'
    ],
    [
      'shows a green light when all is well',
      makeNetworkSummary({ health: 'operational' }),
      'All reachable'
    ]
  ])('%s on the network tab', async (_name, network, label) => {
    const { getByRole, getByText } = await renderWith(Header, { now: NOW }, { network })
    const networkTab = getByRole('tab', { name: 'Network', description: label })
    expect(networkTab.contains(getByText(label))).toBe(true)
  })

  it.each([
    [makeNetworkSummary({ health: 'down', down: ['a'] }), 'bg-sev-outage'],
    [makeNetworkSummary({ health: 'degraded', degraded: ['a'] }), 'bg-sev-investigating']
  ])('colours the problem count by how bad it is: %o', async (network, colour) => {
    const { getByText } = await renderWith(Header, { now: NOW }, { network })
    expect(getByText('1 with problems').parentElement!.className).toContain(colour)
  })

  it('shows nothing on the network tab before anything is known', async () => {
    const { getByRole } = await renderWith(Header, { now: NOW })
    expect(tab(getByRole, /Network/).textContent?.trim()).toBe('')
  })
})

describe('refreshing on the network tab', () => {
  it('says what refreshing means there, in its tooltip', async () => {
    const { getByLabelText, getByRole, findByText } = await renderWith(Header, { now: NOW })
    await fireEvent.click(getByRole('tab', { name: /Network/ }))

    await fireEvent.focus(getByLabelText('Run network checks'))

    expect(await findByText('Run network checks')).toBeTruthy()
  })

  it('runs the checks instead of polling', async () => {
    const { bridge, getByLabelText, getByRole } = await renderWith(Header, { now: NOW })
    await fireEvent.click(getByRole('tab', { name: /Network/ }))
    await fireEvent.click(getByLabelText('Run network checks'))
    expect(bridge.api.Network.run).toHaveBeenCalledTimes(1)
    expect(bridge.api.Feed.refresh).not.toHaveBeenCalled()
  })

  it('spins while a sweep runs, and waits for it', async () => {
    const { bridge, getByLabelText, getByRole } = await renderWith(Header, { now: NOW })
    await fireEvent.click(getByRole('tab', { name: /Network/ }))
    await pushNetwork(bridge, makeSnapshot({ running: true }))
    const button = getByLabelText('Run network checks') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.querySelector('.animate-spin')).not.toBeNull()
  })

  it('cannot run checks that are switched off', async () => {
    const { getByLabelText, getByRole } = await renderWith(
      Header,
      { now: NOW },
      { settings: makeSettings({ networkChecks: false }) }
    )
    await fireEvent.click(getByRole('tab', { name: /Network/ }))
    expect((getByLabelText('Run network checks') as HTMLButtonElement).disabled).toBe(true)
  })
})

/**
 * A tab list is one stop on the way through the page, with the arrow keys to choose
 * within it — not three stops that only a mouse can tell apart.
 */
describe('the tabs from the keyboard', () => {
  it('makes the open tab the one stop, and the others reachable by arrow', async () => {
    const { getByRole } = await renderWith(Header, { now: NOW })

    expect(tab(getByRole, /Timeline/).tabIndex).toBe(0)
    expect(tab(getByRole, /^Feed$/).tabIndex).toBe(-1)
    expect(tab(getByRole, /Network/).getAttribute('aria-controls')).toBe('view')
  })

  it('keeps the stop on the tab a detour goes back to', async () => {
    const { getByRole, getByLabelText } = await renderWith(Header, { now: NOW })
    await fireEvent.click(tab(getByRole, /^Feed$/))
    await fireEvent.click(getByLabelText('Settings'))

    expect(tab(getByRole, /^Feed$/).tabIndex).toBe(0)
  })

  it.each([
    ['ArrowRight', 'timeline', 'feed'],
    ['ArrowRight', 'network', 'timeline'],
    ['ArrowLeft', 'timeline', 'network'],
    ['ArrowLeft', 'feed', 'timeline'],
    ['Home', 'network', 'timeline'],
    ['End', 'timeline', 'network']
  ] as const)('%s from %s opens %s, and moves focus there', async (key, from, to) => {
    const { getByRole } = await renderWith(Header, { now: NOW })
    nav.open(from)
    await settle()
    const tabs = getByRole('tablist').querySelectorAll<HTMLElement>('[role="tab"]')
    const start = [...tabs].find((node) => node.getAttribute('aria-selected') === 'true')!

    await fireEvent.keyDown(start, { key })

    expect(nav.view).toBe(to)
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-label')?.toLowerCase()).toBe(to)
  })

  it('leaves every other key alone', async () => {
    const { getByRole } = await renderWith(Header, { now: NOW })
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    })

    await fireEvent(tab(getByRole, /Timeline/), event)

    expect(nav.view).toBe('timeline')
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('a button main refuses', () => {
  it('says why under the header when a refresh is refused', async () => {
    const { bridge, getByLabelText, getByRole } = await renderWith(Header, { now: NOW })
    vi.mocked(bridge.api.Feed.refresh).mockRejectedValueOnce(new Error('Already refreshing'))

    await fireEvent.click(getByLabelText('Refresh now'))
    await settle()

    expect(getByRole('alert').textContent).toContain('Already refreshing')
  })

  it('says so for a sweep main will not start, and forgets it once one starts', async () => {
    const { bridge, getByLabelText, getByRole, queryByRole } = await renderWith(Header, {
      now: NOW
    })
    await fireEvent.click(getByRole('tab', { name: /Network/ }))
    vi.mocked(bridge.api.Network.run).mockRejectedValueOnce(new Error('Not allowed'))

    await fireEvent.click(getByLabelText('Run network checks'))
    await settle()
    expect(getByRole('alert').textContent).toContain('Not allowed')

    await fireEvent.click(getByLabelText('Run network checks'))
    await settle()
    expect(queryByRole('alert')).toBeNull()
  })

  it('says why everything could not be marked read', async () => {
    const post = makePost({ authorDid: account.did })
    const { bridge, getByLabelText, getByRole } = await renderWith(
      Header,
      { now: NOW },
      { accounts: [account], posts: [post], unread: [post.uri] }
    )
    vi.mocked(bridge.api.Feed.markAllRead).mockRejectedValueOnce(new Error('Try again'))

    await fireEvent.click(getByLabelText('Mark all as read'))
    await settle()

    expect(getByRole('alert').textContent).toContain('Try again')
  })
})
