import { describe, expect, it } from 'vitest'
import { SERVICES, probeAccount, probePost } from '@shared/network'
import { webhookAccount } from '@shared/webhook'
import { makeAccount, makeCheck, makePost, makeSettings } from '../../../test/factories'
import { renderWith } from '../test/render'
import Feed from './Feed.svelte'

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

const mixed = {
  accounts: [status, page, probeAccount('2026-01-01T00:00:00Z')],
  posts: [post, pushed, measured],
  unread: [],
  settings: makeSettings({ markReadOn: 'never' as const })
}

describe('the feed tab', () => {
  it('shows what the status accounts posted', async () => {
    const { getByText } = await renderWith(Feed, { now: NOW }, mixed)
    expect(getByText('We are investigating a problem')).toBeTruthy()
  })

  it('leaves pushed deliveries and measurements to the alerts tab', async () => {
    const { queryByText } = await renderWith(Feed, { now: NOW }, mixed)

    expect(queryByText('Pushed from a hosted status page')).toBeNull()
    expect(queryByText(/is not responding from this computer/)).toBeNull()
  })

  it('offers chips for the status accounts only', async () => {
    const { queryByText } = await renderWith(Feed, { now: NOW }, mixed)
    expect(queryByText('status.hosted.test')).toBeNull()
    expect(queryByText('Network checks')).toBeNull()
  })

  it('says so when no account has posted yet', async () => {
    const { getByText } = await renderWith(
      Feed,
      { now: NOW },
      { ...mixed, posts: [pushed, measured] }
    )
    expect(getByText('No posts yet')).toBeTruthy()
  })
})
