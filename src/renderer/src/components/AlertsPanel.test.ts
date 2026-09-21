import { describe, expect, it } from 'vitest'
import { within } from '@testing-library/svelte'
import { SERVICES, probeAccount, probePost } from '@shared/network'
import { webhookAccount } from '@shared/webhook'
import { makeAccount, makeCheck, makePost, makeSettings } from '../../../test/factories'
import { renderWith } from '../test/render'
import AlertsPanel from './AlertsPanel.svelte'

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

describe('the alerts tab', () => {
  it('carries what arrived on its own: pushed deliveries and measurements', async () => {
    const { getByText } = await renderWith(AlertsPanel, { now: NOW }, mixed)

    expect(getByText('Pushed from a hosted status page')).toBeTruthy()
    expect(getByText(/is not responding from this computer/)).toBeTruthy()
  })

  it('leaves the status accounts’ posts to the feed tab', async () => {
    const { queryByText } = await renderWith(AlertsPanel, { now: NOW }, mixed)
    expect(queryByText('We are investigating a problem')).toBeNull()
  })

  it('offers chips for the sources that push rather than post', async () => {
    const { container } = await renderWith(AlertsPanel, { now: NOW }, mixed)
    const chips = within(container.querySelector('.chip-scroller') as HTMLElement)

    expect(chips.getByText('status.hosted.test')).toBeTruthy()
    expect(chips.getByText('Network checks')).toBeTruthy()
    expect(chips.queryByText('Example Status')).toBeNull()
  })

  it('says so when nothing has come in', async () => {
    const { getByText } = await renderWith(AlertsPanel, { now: NOW }, { ...mixed, posts: [post] })
    expect(getByText('No alerts')).toBeTruthy()
  })
})
