import { describe, expect, it } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import { SERVICES, probeAccount, probePost } from '@shared/network'
import { webhookAccount } from '@shared/webhook'
import { nav } from '$lib/nav.svelte'
import { SEVERITY_STYLE } from '$lib/severity'
import { makeAccount, makeCheck, makeEmbed, makePost, makeSettings } from '../../../test/factories'
import { renderWith } from '../test/render'
import TimelineRow from './TimelineRow.svelte'

const NOW = Date.parse('2026-01-03T12:00:00Z')

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
  text: 'We are investigating elevated error rates.',
  createdAt: '2026-01-03T09:00:00Z',
  embed: makeEmbed('external')
})
const measured = probePost({
  service: SERVICES.find((s) => s.id === 'relay:europe.firehose.network')!,
  from: 'up',
  to: 'down',
  at: '2026-01-03T10:30:00.000Z',
  since: '2026-01-03T09:00:00.000Z',
  checks: [makeCheck({ label: 'firehose', ok: false, error: 'No commits received' })]
})

const manual = makeSettings({ markReadOn: 'never' as const })

/** The gutter: the severity node, and the thread running on from it to the next stop. */
const node = (container: HTMLElement): Element =>
  container.querySelector('[aria-hidden="true"] > span')!
const thread = (container: HTMLElement): Element | null =>
  container.querySelector('[aria-hidden="true"] > span.w-px')

describe('what a screen reader hears', () => {
  // The unread dot is inside the button, under a label that covered it.
  it('says a row is unread, ahead of the rest', async () => {
    const { getByRole } = await renderWith(
      TimelineRow,
      { post, now: NOW },
      { accounts: [status], posts: [post], unread: [post.uri], settings: manual }
    )

    expect(getByRole('button').getAttribute('aria-label')).toBe(
      'Unread. Investigating: We are investigating elevated error rates. — open the original'
    )
  })

  it('says nothing of the sort once it is read', async () => {
    const { getByRole } = await renderWith(
      TimelineRow,
      { post, now: NOW },
      { accounts: [status], posts: [post], unread: [], settings: manual }
    )

    expect(getByRole('button').getAttribute('aria-label')).toBe(
      'Investigating: We are investigating elevated error rates. — open the original'
    )
  })
})

describe('a timeline row', () => {
  it('leads with the severity, the source and when', async () => {
    const { container, getByText } = await renderWith(
      TimelineRow,
      { post, now: NOW },
      { accounts: [status], posts: [post], unread: [post.uri], settings: manual }
    )

    expect(getByText('Investigating')).toBeTruthy()
    expect(getByText('@status.example.test')).toBeTruthy()
    expect(container.querySelector('time')?.textContent).toBe('3h')
  })

  it('writes a status page’s host without an @, since it is not a handle', async () => {
    const pushed = makePost({
      authorDid: page.did,
      authorHandle: page.handle,
      rkey: 'pushed',
      text: 'Pushed from a hosted status page'
    })
    const { getByText } = await renderWith(
      TimelineRow,
      { post: pushed, now: NOW },
      { accounts: [page], posts: [pushed], unread: [pushed.uri], settings: manual }
    )

    expect(getByText('status.hosted.test')).toBeTruthy()
  })

  it('stays a summary: the text, and none of the card’s trimmings', async () => {
    const { container, queryByLabelText } = await renderWith(
      TimelineRow,
      { post, now: NOW },
      { accounts: [status], posts: [post], unread: [post.uri], settings: manual }
    )

    expect(container.querySelector('p')?.className).toContain('line-clamp-2')
    expect(container.textContent).toContain('We are investigating elevated error rates.')
    // No embed card, no avatar, no mark-read-to-here control.
    expect(container.querySelector('img')).toBeNull()
    expect(queryByLabelText('Mark this and everything older as read')).toBeNull()
    expect(container.textContent).not.toContain('Incident 42')
  })

  it('opens the original and marks it read', async () => {
    const { bridge, getByRole } = await renderWith(
      TimelineRow,
      { post, now: NOW },
      { accounts: [status], posts: [post], unread: [post.uri], settings: manual }
    )

    await fireEvent.click(getByRole('button'))

    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(post.url)
    expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([post.uri])
  })

  it('opens a post already read without marking it again', async () => {
    const { bridge, getByRole } = await renderWith(
      TimelineRow,
      { post, now: NOW },
      { accounts: [status], posts: [post], unread: [], settings: manual }
    )

    await fireEvent.click(getByRole('button'))

    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(post.url)
    expect(bridge.api.Feed.markRead).not.toHaveBeenCalled()
  })

  it('sends a measurement to the dashboard instead of the web', async () => {
    const { bridge, getByRole } = await renderWith(
      TimelineRow,
      { post: measured, now: NOW },
      {
        accounts: [probeAccount('2026-01-01T00:00:00Z')],
        posts: [measured],
        unread: [measured.uri],
        settings: manual
      }
    )

    await fireEvent.click(getByRole('button'))

    expect(nav.view).toBe('network')
    expect(nav.pending).toEqual({ serviceId: 'relay:europe.firehose.network' })
    expect(bridge.api.Host.openExternal).not.toHaveBeenCalled()
    expect(bridge.api.Feed.markRead).toHaveBeenCalledWith([measured.uri])
  })

  it('is not a button when there is nothing to open', async () => {
    const orphan = makePost({
      authorDid: page.did,
      authorHandle: page.handle,
      rkey: 'orphan',
      text: 'A delivery with no link back',
      url: ''
    })
    const { queryByRole, getByText } = await renderWith(
      TimelineRow,
      { post: orphan, now: NOW },
      { accounts: [page], posts: [orphan], unread: [orphan.uri], settings: manual }
    )

    expect(queryByRole('button')).toBeNull()
    expect(getByText('A delivery with no link back')).toBeTruthy()
  })

  it('badges only a post that is still unread', async () => {
    const unread = await renderWith(
      TimelineRow,
      { post, now: NOW },
      { accounts: [status], posts: [post], unread: [post.uri], settings: manual }
    )
    expect(unread.queryByLabelText('Unread')).not.toBeNull()
    unread.unmount()

    const { queryByLabelText } = await renderWith(
      TimelineRow,
      { post, now: NOW },
      { accounts: [status], posts: [post], unread: [], settings: manual }
    )
    expect(queryByLabelText('Unread')).toBeNull()
  })
})

describe('its place on the thread', () => {
  const state = { accounts: [status], posts: [post], unread: [], settings: manual }

  it('recedes below the line, where it was read before this visit', async () => {
    const above = await renderWith(TimelineRow, { post, now: NOW }, state)
    expect(above.getByRole('button').className).toContain(SEVERITY_STYLE.investigating.wash)
    expect(node(above.container).className).not.toContain('opacity-65')
    above.unmount()

    const { container, getByRole, getByText } = await renderWith(
      TimelineRow,
      { post, now: NOW, dimmed: true },
      state
    )
    expect(getByRole('button').className).not.toContain(SEVERITY_STYLE.investigating.wash)
    expect(node(container).className).toContain('opacity-65')
    expect(getByText(post.text).className).toContain('text-foreground/65')
  })

  it('runs the thread on to the next stop, and ends it at the last one of a day', async () => {
    const middle = await renderWith(TimelineRow, { post, now: NOW }, state)
    expect(thread(middle.container)).not.toBeNull()
    middle.unmount()

    const { container } = await renderWith(TimelineRow, { post, now: NOW, last: true }, state)
    expect(thread(container)).toBeNull()
  })
})
