import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import { SEVERITY_STYLE } from '$lib/severity'
import { nav } from '$lib/nav.svelte'
import { SERVICES, probePost } from '@shared/network'
import { makeCheck, makeEmbed, makePost, makeSettings } from '../../../test/factories'
import { pushState, renderWith } from '../test/render'
import { scrollIntoView } from '../test/setup'
import PostCard from './PostCard.svelte'

const NOW = Date.parse('2026-01-01T12:00:00Z')

describe('PostCard', () => {
  it('shows the severity badge, handle, body and relative time', async () => {
    const post = makePost({
      text: 'We are investigating elevated error rates.',
      authorHandle: 'status.bsky.app',
      createdAt: '2026-01-01T11:30:00Z'
    })
    const { getByText } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })

    expect(getByText('Investigating')).toBeTruthy()
    expect(getByText('@status.bsky.app')).toBeTruthy()
    expect(getByText('We are investigating elevated error rates.')).toBeTruthy()
    expect(getByText('30m')).toBeTruthy()
  })

  it('gives the timestamp a machine-readable datetime and an absolute title', async () => {
    const post = makePost({ createdAt: '2026-01-01T11:30:00Z' })
    const { container } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })

    const time = container.querySelector('time')
    expect(time?.getAttribute('datetime')).toBe('2026-01-01T11:30:00Z')
    expect(time?.getAttribute('title')).toBeTruthy()
  })

  it('colours the severity rail', async () => {
    const post = makePost({ severity: 'outage' })
    const { container } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })

    const rail = container.querySelector('[aria-hidden="true"]')
    expect(rail?.className).toContain(SEVERITY_STYLE.outage.rail)
  })

  describe('unread state', () => {
    it('marks an unread post and drops the marker once read', async () => {
      const post = makePost()
      const { bridge, queryByLabelText, container } = await renderWith(
        PostCard,
        { post, now: NOW },
        { posts: [post], unread: [post.uri] }
      )

      expect(queryByLabelText('Unread')).not.toBeNull()
      expect(container.querySelector('article')?.className).toContain('bg-primary')

      await pushState(bridge, { unread: [] })

      expect(queryByLabelText('Unread')).toBeNull()
    })

    it('shows no marker for a post that is already read', async () => {
      const post = makePost()
      const { queryByLabelText } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })
      expect(queryByLabelText('Unread')).toBeNull()
    })
  })

  describe('the open button', () => {
    it('opens the post on Bluesky and marks it read', async () => {
      const post = makePost()
      const { bridge, getByLabelText } = await renderWith(
        PostCard,
        { post, now: NOW },
        { posts: [post], unread: [post.uri] }
      )

      await fireEvent.click(getByLabelText('Open the original'))

      expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(post.url)
      expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([post.uri])
    })

    it('does not mark an already-read post read again', async () => {
      const post = makePost()
      const { bridge, getByLabelText } = await renderWith(
        PostCard,
        { post, now: NOW },
        { posts: [post] }
      )

      await fireEvent.click(getByLabelText('Open the original'))

      expect(bridge.api.Host.openExternal).toHaveBeenCalled()
      expect(bridge.api.Feed.markRead).not.toHaveBeenCalled()
    })
  })

  describe('the avatar', () => {
    it('falls back to initials from the display name', async () => {
      const post = makePost({ authorDisplayName: 'Bluesky Status', authorAvatar: null })
      const { getByText } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })
      expect(getByText('BS')).toBeTruthy()
    })

    it('uses the handle when the display name has no letters to take', async () => {
      const post = makePost({
        authorDisplayName: '',
        authorHandle: 'status.bsky.app',
        authorAvatar: null
      })
      const { getByText } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })
      expect(getByText('ST')).toBeTruthy()
    })

    it('renders the avatar image without leaking a referrer', async () => {
      const post = makePost({ authorAvatar: 'https://cdn.bsky.app/a.jpg' })
      const { container } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })
      const img = container.querySelector('img')
      expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
    })
  })

  describe('embeds', () => {
    it('renders one when the post has it', async () => {
      const post = makePost({ embed: makeEmbed('external') })
      const { getByText } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })
      expect(getByText('Incident 42')).toBeTruthy()
    })

    it('renders nothing extra when the post has none', async () => {
      const post = makePost({ embed: null })
      const { queryByText } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })
      expect(queryByText('Incident 42')).toBeNull()
    })
  })

  describe('a pushed update', () => {
    it('is attributed to its status page, without an @', async () => {
      const post = makePost({
        authorDid: 'webhook:pg_bsky',
        authorHandle: 'status.bsky.app',
        uri: 'webhook:pg_bsky/incident/inc_1/u1',
        url: 'https://status.bsky.app/incidents/inc_1'
      })
      const { getByText, queryByText } = await renderWith(
        PostCard,
        { post, now: NOW },
        { posts: [post] }
      )

      expect(getByText('status.bsky.app')).toBeTruthy()
      expect(queryByText('@status.bsky.app')).toBeNull()
    })

    it('falls back to the raw text when it has no segments', async () => {
      const post = makePost({ text: 'A component is in a major outage.', segments: [] })
      const { getByText } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })

      expect(getByText('A component is in a major outage.')).toBeTruthy()
    })

    it('offers nothing to open when it carries no link', async () => {
      const post = makePost({
        authorDid: 'webhook:pg_bsky',
        authorHandle: 'status.bsky.app',
        uri: 'webhook:pg_bsky/component/cmp_1/x',
        url: ''
      })
      const { queryByLabelText } = await renderWith(PostCard, { post, now: NOW }, { posts: [post] })

      expect(queryByLabelText('Open the original')).toBeNull()
    })
  })

  describe('an entry from the network checks', () => {
    const relay = SERVICES.find((s) => s.id === 'relay:europe.firehose.network')!
    const post = probePost({
      service: relay,
      from: 'up',
      to: 'down',
      at: '2026-01-01T11:00:00.000Z',
      since: null,
      checks: [makeCheck({ label: 'firehose', ok: false, error: 'No commits received' })]
    })

    it('is attributed to the checks, wearing its colour instead of a face', async () => {
      const { container, getByText } = await renderWith(
        PostCard,
        { post, now: NOW },
        { posts: [post] }
      )
      expect(getByText('Network checks')).toBeTruthy()
      expect(container.querySelector('[data-slot="avatar"], .rounded-full img')).toBeNull()
      const tile = container.querySelector('span.grid.rounded-full')!
      expect(tile.className).toContain(SEVERITY_STYLE.outage.bg)
      expect(tile.className).toContain(SEVERITY_STYLE.outage.text)
    })

    it('links back into the dashboard, and marks itself read', async () => {
      const { bridge, getByLabelText, queryByLabelText } = await renderWith(
        PostCard,
        { post, now: NOW },
        { posts: [post], unread: [post.uri] }
      )
      expect(queryByLabelText('Open the original')).toBeNull()

      await fireEvent.click(getByLabelText('Show on the network dashboard'))

      expect(nav.view).toBe('network')
      expect(nav.pending).toEqual({ serviceId: 'relay:europe.firehose.network' })
      expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([post.uri])
      expect(bridge.api.Host.openExternal).not.toHaveBeenCalled()
    })

    it('does not mark an entry already read', async () => {
      const { bridge, getByLabelText } = await renderWith(
        PostCard,
        { post, now: NOW },
        { posts: [post] }
      )
      await fireEvent.click(getByLabelText('Show on the network dashboard'))
      expect(bridge.api.Feed.markRead).not.toHaveBeenCalled()
    })
  })
})

describe('marking read up to here', () => {
  const newer = makePost({ rkey: 'newer', createdAt: '2026-01-01T11:00:00Z' })
  const older = makePost({ rkey: 'older', createdAt: '2026-01-01T09:00:00Z' })

  it('offers it while something older is still unread', async () => {
    const { bridge, getByLabelText } = await renderWith(
      PostCard,
      { post: newer, now: NOW },
      { posts: [newer, older], unread: [newer.uri, older.uri] }
    )

    await fireEvent.click(getByLabelText('Mark this and everything older as read'))

    expect(bridge.api.Feed.markReadThrough).toHaveBeenCalledWith(newer.uri)
    expect(bridge.state.unread).toEqual([])
  })

  it('is not offered on the oldest unread post', async () => {
    const { queryByLabelText } = await renderWith(
      PostCard,
      { post: older, now: NOW },
      { posts: [newer, older], unread: [newer.uri, older.uri] }
    )

    expect(queryByLabelText('Mark this and everything older as read')).toBeNull()
  })

  it('is not offered when everything below is already read', async () => {
    const { queryByLabelText } = await renderWith(
      PostCard,
      { post: newer, now: NOW },
      { posts: [newer, older], unread: [newer.uri] }
    )

    expect(queryByLabelText('Mark this and everything older as read')).toBeNull()
  })
})

describe('marking read once it has been on screen', () => {
  const post = makePost({ rkey: 'seen-me' })

  it('marks an unread post read when it comes into view', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, container } = await renderWith(
        PostCard,
        { post, now: NOW },
        { posts: [post], unread: [post.uri], settings: makeSettings({ markReadOn: 'seen' }) }
      )

      expect(scrollIntoView(container.querySelector('article')!)).toBe(true)
      // Collected rather than sent per card; the flush is what makes the call.
      expect(bridge.api.Feed.markRead).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(500)

      expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([post.uri])
    } finally {
      vi.useRealTimers()
    }
  })

  it('watches nothing while the setting is off', async () => {
    const { container } = await renderWith(
      PostCard,
      { post, now: NOW },
      { posts: [post], unread: [post.uri] }
    )

    expect(scrollIntoView(container.querySelector('article')!)).toBe(false)
  })

  it('watches nothing for a post that is already read', async () => {
    const { container } = await renderWith(
      PostCard,
      { post, now: NOW },
      { posts: [post], settings: makeSettings({ markReadOn: 'seen' }) }
    )

    expect(scrollIntoView(container.querySelector('article')!)).toBe(false)
  })

  it('stops watching once it has counted the post', async () => {
    vi.useFakeTimers()
    try {
      const { container } = await renderWith(
        PostCard,
        { post, now: NOW },
        { posts: [post], unread: [post.uri], settings: makeSettings({ markReadOn: 'seen' }) }
      )
      const article = container.querySelector('article')!

      expect(scrollIntoView(article)).toBe(true)
      expect(scrollIntoView(article)).toBe(false)

      await vi.advanceTimersByTimeAsync(500)
    } finally {
      vi.useRealTimers()
    }
  })
})
