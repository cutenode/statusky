import { describe, expect, it, vi, type Mock } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import Inbox from '@lucide/svelte/icons/inbox'
import { makeAccount, makePost, makeSettings } from '../../../test/factories'
import { pushState, renderWith, settle } from '../test/render'
import { scrollIntoView } from '../test/setup'
import PostList from './PostList.svelte'

const NOW = Date.parse('2026-01-03T12:00:00Z')

const accountA = makeAccount({ did: 'did:plc:a', handle: 'a.test', displayName: 'Alpha Status' })
const accountB = makeAccount({ did: 'did:plc:b', handle: 'b.test', displayName: 'Beta Status' })

const today = makePost({
  authorDid: accountA.did,
  authorHandle: accountA.handle,
  rkey: 'today',
  text: 'We are investigating a problem',
  createdAt: '2026-01-03T09:00:00Z'
})
const yesterday = makePost({
  authorDid: accountB.did,
  authorHandle: accountB.handle,
  rkey: 'yesterday',
  text: 'This incident has been resolved.',
  createdAt: '2026-01-02T09:00:00Z'
})

const EMPTY = {
  emptyIcon: Inbox,
  emptyTitle: 'No updates yet',
  emptyDescription: 'Statusky is fetching posts from your tracked accounts.'
}

/** The tab's own slice, handed in the way `Feed` hands it in. */
function props(
  posts = [today, yesterday],
  accounts = [accountA, accountB]
): Record<string, unknown> {
  return { now: NOW, posts, accounts, ...EMPTY }
}

const populated = {
  accounts: [accountA, accountB],
  posts: [today, yesterday],
  unread: [today.uri],
  // Manual, so an unread post is still unread by the time a test looks at it. The
  // default catches up on open, which `marking read on open` covers on its own.
  settings: makeSettings({ markReadOn: 'never' as const })
}

describe('the list', () => {
  it('renders every post it is given, grouped by day', async () => {
    const { getByText } = await renderWith(PostList, props(), populated)

    expect(getByText('Today')).toBeTruthy()
    expect(getByText('Yesterday')).toBeTruthy()
    expect(getByText('We are investigating a problem')).toBeTruthy()
    expect(getByText('This incident has been resolved.')).toBeTruthy()
  })

  it('keeps consecutive posts from one day in a single group', async () => {
    const second = makePost({
      authorDid: accountA.did,
      rkey: 'today2',
      text: 'Second update today',
      createdAt: '2026-01-03T08:00:00Z'
    })
    const { getAllByText } = await renderWith(PostList, props([today, second, yesterday]), {
      ...populated,
      posts: [today, second, yesterday]
    })

    expect(getAllByText('Today')).toHaveLength(1)
  })

  it('updates when new posts arrive', async () => {
    const fresh = makePost({
      authorDid: accountA.did,
      rkey: 'new',
      text: 'Fresh outage',
      createdAt: '2026-01-03T11:00:00Z'
    })
    const { queryByText, rerender } = await renderWith(PostList, props(), populated)
    expect(queryByText('Fresh outage')).toBeNull()

    await rerender(props([fresh, today, yesterday]))

    expect(queryByText('Fresh outage')).not.toBeNull()
  })
})

describe('the status filters', () => {
  it('starts on All, with every post shown', async () => {
    const { getByText, queryByText } = await renderWith(PostList, props(), populated)
    expect(getByText('All').className).toContain('bg-elevated')
    expect(queryByText('This incident has been resolved.')).not.toBeNull()
  })

  it('narrows to unread', async () => {
    const { getByText, queryByText } = await renderWith(PostList, props(), populated)

    await fireEvent.click(getByText('Unread'))

    expect(queryByText('We are investigating a problem')).not.toBeNull()
    expect(queryByText('This incident has been resolved.')).toBeNull()
  })

  it('counts only this tab’s unread beside the Unread filter, and hides it at zero', async () => {
    const { bridge, getByText } = await renderWith(PostList, props(), populated)
    const badge = (): Element | null => getByText('Unread').querySelector('span')

    expect(badge()?.textContent).toBe('1')

    await pushState(bridge, { unread: [] })

    expect(badge()).toBeNull()
  })
})

describe('the account chips', () => {
  it('appear only when more than one account is visible', async () => {
    const single = await renderWith(PostList, props([today], [accountA]), {
      accounts: [accountA],
      posts: [today]
    })
    expect(single.queryByText('Everyone')).toBeNull()
    single.unmount()

    const { queryByText } = await renderWith(PostList, props(), populated)
    expect(queryByText('Everyone')).not.toBeNull()
    expect(queryByText('Alpha Status')).not.toBeNull()
  })

  it('hide muted accounts', async () => {
    const { queryByText } = await renderWith(
      PostList,
      props([today, yesterday], [accountA, { ...accountB, muted: true }]),
      populated
    )
    expect(queryByText('Beta Status')).toBeNull()
  })

  it('filter the list to one account', async () => {
    const { getByText, queryByText } = await renderWith(PostList, props(), populated)

    await fireEvent.click(getByText('Alpha Status'))

    expect(queryByText('We are investigating a problem')).not.toBeNull()
    expect(queryByText('This incident has been resolved.')).toBeNull()
  })

  it('toggle off when clicked twice', async () => {
    const { getByText, queryByText } = await renderWith(PostList, props(), populated)

    await fireEvent.click(getByText('Alpha Status'))
    await fireEvent.click(getByText('Alpha Status'))

    expect(queryByText('This incident has been resolved.')).not.toBeNull()
  })

  it('reset to everyone', async () => {
    const { getByText, queryByText } = await renderWith(PostList, props(), populated)

    await fireEvent.click(getByText('Beta Status'))
    await fireEvent.click(getByText('Everyone'))

    expect(queryByText('We are investigating a problem')).not.toBeNull()
    expect(queryByText('This incident has been resolved.')).not.toBeNull()
  })

  it('combine with the status filter', async () => {
    const { getByText, queryByText } = await renderWith(PostList, props(), populated)

    await fireEvent.click(getByText('Unread'))
    await fireEvent.click(getByText('Beta Status'))

    expect(queryByText('We are investigating a problem')).toBeNull()
    expect(queryByText('This incident has been resolved.')).toBeNull()
    expect(queryByText('All caught up')).not.toBeNull()
  })

  it('label each chip with the full handle', async () => {
    const { getByText } = await renderWith(PostList, props(), populated)
    expect(getByText('Alpha Status').getAttribute('title')).toBe('@a.test')
  })
})

describe('empty states', () => {
  it('shows whatever the tab says about being empty', async () => {
    const { getByText } = await renderWith(PostList, props([], [accountA]), {
      accounts: [accountA]
    })
    expect(getByText('No updates yet')).toBeTruthy()
  })

  it('celebrates having nothing unread', async () => {
    const { getByText } = await renderWith(PostList, props([yesterday], [accountA]), {
      accounts: [accountA],
      posts: [yesterday]
    })

    await fireEvent.click(getByText('Unread'))

    expect(getByText('All caught up')).toBeTruthy()
  })
})

describe('marking read on open', () => {
  const unreadList = { ...populated, settings: makeSettings() }

  it('catches up as soon as the tab is shown', async () => {
    const { bridge } = await renderWith(PostList, props(), unreadList)

    expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([today.uri])
    expect(bridge.state.unread).toEqual([])
  })

  it('reads only this tab’s posts, leaving another tab’s unread alone', async () => {
    const elsewhere = makePost({
      authorDid: 'did:plc:elsewhere',
      rkey: 'other',
      text: 'Belongs to another tab',
      createdAt: '2026-01-03T10:00:00Z'
    })
    const { bridge } = await renderWith(PostList, props(), {
      ...unreadList,
      posts: [elsewhere, today, yesterday],
      unread: [elsewhere.uri, today.uri]
    })

    expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([today.uri])
    expect(bridge.api.Feed.markAllRead).not.toHaveBeenCalled()
    expect(bridge.state.unread).toEqual([elsewhere.uri])
  })

  it('catches up again when the popover comes back to the front', async () => {
    const { bridge } = await renderWith(PostList, props(), unreadList)
    await pushState(bridge, { unread: [today.uri] })

    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(bridge.api.Feed.markRead).toHaveBeenCalledTimes(2)
  })

  it('stays quiet when there is nothing unread', async () => {
    const { bridge } = await renderWith(PostList, props(), { ...unreadList, unread: [] })

    expect(bridge.api.Feed.markRead).not.toHaveBeenCalled()
  })

  it('is the default, so an ordinary tab catches up', async () => {
    const { settings: _manual, ...outOfTheBox } = populated
    const { bridge } = await renderWith(PostList, props(), outOfTheBox)

    expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([today.uri])
  })

  it('leaves the list alone when reading is set to manual', async () => {
    const { bridge } = await renderWith(PostList, props(), populated)

    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(bridge.api.Feed.markRead).not.toHaveBeenCalled()
    expect(bridge.state.unread).toEqual([today.uri])
  })

  it('stops listening once the tab is gone', async () => {
    const { bridge, unmount } = await renderWith(PostList, props(), unreadList)
    const calls = (bridge.api.Feed.markRead as Mock).mock.calls.length

    unmount()
    window.dispatchEvent(new Event('focus'))

    expect((bridge.api.Feed.markRead as Mock).mock.calls.length).toBe(calls)
  })

  it('sends what scrolled past before the popover was dismissed', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, container, unmount } = await renderWith(PostList, props(), {
        ...populated,
        settings: makeSettings({ markReadOn: 'seen' })
      })

      scrollIntoView(container.querySelector('article')!)
      unmount()

      expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([today.uri])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('marking read once updates scroll past', () => {
  const seenList = { ...populated, settings: makeSettings({ markReadOn: 'seen' as const }) }

  it('coalesces a scroll into a single call', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, container } = await renderWith(PostList, props(), {
        ...seenList,
        unread: [today.uri, yesterday.uri]
      })
      const [first, second] = Array.from(container.querySelectorAll('article'))

      scrollIntoView(first!)
      await vi.advanceTimersByTimeAsync(200)
      scrollIntoView(second!)
      await vi.advanceTimersByTimeAsync(500)

      expect(bridge.api.Feed.markRead).toHaveBeenCalledTimes(1)
      expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([today.uri, yesterday.uri])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not count an update that is only half showing', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, container } = await renderWith(PostList, props(), seenList)

      expect(scrollIntoView(container.querySelector('article')!, 0.2)).toBe(true)
      await vi.advanceTimersByTimeAsync(500)

      expect(bridge.api.Feed.markRead).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
