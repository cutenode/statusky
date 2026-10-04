import { describe, expect, it } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import { SERVICES, probeAccount, probePost } from '@shared/network'
import { webhookAccount } from '@shared/webhook'
import { nav } from '$lib/nav.svelte'
import { makeAccount, makeCheck, makePost, makeSettings } from '../../../test/factories'
import { pushState, renderWith, settle } from '../test/render'
import TimelinePanel from './TimelinePanel.svelte'

const NOW = Date.parse('2026-01-03T12:00:00Z')

/** Whether `first` is rendered above `second`, which is what the two sections mean. */
function order(first: Element, second: Element): boolean {
  return !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
}

const status = makeAccount({
  did: 'did:plc:a',
  handle: 'status.example.test',
  displayName: 'Example Status'
})
const page = webhookAccount(
  { id: 'webhook:page', host: 'status.hosted.test', url: null, description: null },
  '2026-01-01T00:00:00Z'
)

const post = makePost({
  authorDid: status.did,
  authorHandle: status.handle,
  rkey: 'post',
  text: 'We are investigating a problem',
  createdAt: '2026-01-03T09:00:00Z'
})
const pushed = makePost({
  authorDid: page.did,
  authorHandle: page.handle,
  rkey: 'pushed',
  text: 'Pushed from a hosted status page',
  createdAt: '2026-01-03T08:00:00Z'
})
const measured = probePost({
  service: SERVICES[0]!,
  from: 'up',
  to: 'down',
  at: '2026-01-03T07:00:00.000Z',
  since: '2026-01-03T06:00:00.000Z',
  checks: [makeCheck({ label: 'firehose', ok: false, error: 'No commits received' })]
})
const read = makePost({
  authorDid: status.did,
  authorHandle: status.handle,
  rkey: 'read',
  text: 'Dealt with days ago',
  createdAt: '2026-01-02T09:00:00Z'
})

const accounts = [status, page, probeAccount('2026-01-01T00:00:00Z')]
const populated = {
  accounts,
  posts: [post, pushed, measured, read],
  unread: [post.uri, pushed.uri, measured.uri]
}

describe('the timeline', () => {
  it('merges every source back into one chronology', async () => {
    const { getByText } = await renderWith(TimelinePanel, { now: NOW }, populated)

    expect(getByText('We are investigating a problem')).toBeTruthy()
    expect(getByText('Pushed from a hosted status page')).toBeTruthy()
    expect(getByText(/is not responding from this computer/)).toBeTruthy()
  })

  it('carries on into what was already read, under its own heading', async () => {
    const { getByText } = await renderWith(TimelinePanel, { now: NOW }, populated)

    expect(getByText('Read')).toBeTruthy()
    expect(getByText('Dealt with days ago')).toBeTruthy()
  })

  it('keeps the batch it caught up on above the line, not in Read', async () => {
    const { getByText } = await renderWith(TimelinePanel, { now: NOW }, populated)
    await settle()

    // Marked read on open, so only the hold keeps it out of the section below.
    expect(order(getByText('Unread'), getByText('We are investigating a problem'))).toBe(true)
    expect(order(getByText('We are investigating a problem'), getByText('Read'))).toBe(true)
    expect(order(getByText('Read'), getByText('Dealt with days ago'))).toBe(true)
  })

  it('drops the last batch into Read on the next visit', async () => {
    const first = await renderWith(TimelinePanel, { now: NOW }, populated)
    await settle()
    first.unmount()

    // A remount is leaving the tab and coming back: nothing is held any more, and
    // everything the last visit read has fallen below the line.
    const { getByText } = await renderWith(
      TimelinePanel,
      { now: NOW },
      { ...populated, unread: [] }
    )

    expect(order(getByText('Read'), getByText('We are investigating a problem'))).toBe(true)
  })

  it('groups by day, the way the other tabs do', async () => {
    const { getByText } = await renderWith(TimelinePanel, { now: NOW }, populated)
    expect(getByText('Today')).toBeTruthy()
  })

  // A rare poster's thirty posts can reach back more than a year. Grouped by heading,
  // the 10th of September twice over was one key twice, which Svelte throws on.
  it('keeps the same date in two years apart, a year apart', async () => {
    const dated = (rkey: string, createdAt: string): ReturnType<typeof makePost> =>
      makePost({ authorDid: status.did, authorHandle: status.handle, rkey, text: rkey, createdAt })
    const posts = [
      dated('recent', '2025-09-10T12:00:00Z'),
      dated('between', '2025-01-20T12:00:00Z'),
      dated('older', '2024-09-10T12:00:00Z')
    ]

    const { getByText } = await renderWith(
      TimelinePanel,
      { now: NOW },
      { accounts, posts, unread: [] }
    )

    expect(getByText('older')).toBeTruthy()
    expect(getByText(/September 10, 2025/)).toBeTruthy()
    expect(getByText(/September 10, 2024/)).toBeTruthy()
  })

  it('offers no filters — this is the view you read and leave', async () => {
    const { queryByText } = await renderWith(TimelinePanel, { now: NOW }, populated)
    expect(queryByText('All')).toBeNull()
    expect(queryByText('Everyone')).toBeNull()
  })
})

describe('catching up', () => {
  it('reads everything the moment the tab appears', async () => {
    const { bridge } = await renderWith(TimelinePanel, { now: NOW }, populated)

    expect(bridge.api.Feed.markAllRead).toHaveBeenCalledTimes(1)
    expect(bridge.state.unread).toEqual([])
  })

  it('ignores the mark-as-read setting: opening this tab is reading it', async () => {
    const { bridge } = await renderWith(
      TimelinePanel,
      { now: NOW },
      { ...populated, settings: makeSettings({ markReadOn: 'never' }) }
    )

    expect(bridge.api.Feed.markAllRead).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when there was nothing unread, and says so above the line', async () => {
    const { bridge, getByText } = await renderWith(
      TimelinePanel,
      { now: NOW },
      { ...populated, unread: [] }
    )

    expect(bridge.api.Feed.markAllRead).not.toHaveBeenCalled()
    // The section stays, empty and saying why: being caught up is the answer you came
    // for, and dropping the heading would bury it under the chronology.
    expect(getByText('All caught up.')).toBeTruthy()
    expect(order(getByText('Unread'), getByText('All caught up.'))).toBe(true)
    expect(order(getByText('All caught up.'), getByText('Read'))).toBe(true)
  })

  it('catches up again when the popover comes back to the front', async () => {
    const { bridge, getByText, queryByText } = await renderWith(
      TimelinePanel,
      { now: NOW },
      populated
    )
    await pushState(bridge, { unread: [read.uri] })

    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(bridge.api.Feed.markAllRead).toHaveBeenCalledTimes(2)
    // Swept into the batch it is holding, so it stays above the line although it is
    // now read — which leaves nothing below it.
    expect(bridge.state.unread).toEqual([])
    expect(order(getByText('Unread'), getByText('Dealt with days ago'))).toBe(true)
    expect(queryByText('Read')).toBeNull()
  })

  it('stops listening once the tab is gone', async () => {
    const { bridge, unmount } = await renderWith(TimelinePanel, { now: NOW }, populated)
    await pushState(bridge, { unread: [read.uri] })

    unmount()
    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(bridge.api.Feed.markAllRead).toHaveBeenCalledTimes(1)
  })

  it('shows an update that arrives while it is open, badged as unread', async () => {
    const { bridge, getByText, getAllByLabelText } = await renderWith(
      TimelinePanel,
      { now: NOW },
      { ...populated, unread: [] }
    )
    const fresh = makePost({
      authorDid: status.did,
      authorHandle: status.handle,
      rkey: 'fresh',
      text: 'Major outage affecting the AppView.',
      createdAt: '2026-01-03T11:00:00Z'
    })

    await pushState(bridge, { posts: [fresh, ...populated.posts], unread: [fresh.uri] })

    expect(getByText('Major outage affecting the AppView.')).toBeTruthy()
    expect(getAllByLabelText('Unread')).toHaveLength(1)
  })
})

describe('the empty state', () => {
  it('points at the feed when there is nothing to read', async () => {
    const { getByText } = await renderWith(TimelinePanel, { now: NOW }, { accounts, unread: [] })

    await fireEvent.click(getByText('Browse the feed'))

    expect(nav.view).toBe('feed')
  })
})
