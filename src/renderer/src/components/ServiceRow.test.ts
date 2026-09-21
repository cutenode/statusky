import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import type { ServiceProbe } from '@shared/types'
import { makeCheck, makeService } from '../../../test/factories'
import { renderWith } from '../test/render'
import ServiceRow from './ServiceRow.svelte'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const PDS = 'pds:amanita.us-east.host.bsky.network'

async function row(service: Partial<ServiceProbe>, props: Record<string, unknown> = {}) {
  const ontoggle = vi.fn()
  const rendered = await renderWith(ServiceRow, {
    service: makeService(service),
    now: NOW,
    ontoggle,
    ...props
  })
  return { ...rendered, ontoggle }
}

const verdict = (container: HTMLElement): string =>
  container.querySelector('[data-verdict]')!.textContent!.trim()

describe('the collapsed row', () => {
  it('sets the distinctive part of a hostname apart from the rest', async () => {
    const { container, getByTitle } = await row({ id: PDS })
    const name = getByTitle('amanita.us-east.host.bsky.network')
    expect(name.children[0]!.textContent).toBe('amanita')
    expect(name.children[1]!.textContent).toBe('.us-east.host.bsky.network')
    expect(container.querySelector('[data-service]')!.getAttribute('data-service')).toBe(PDS)
  })

  it('writes a friendly name whole', async () => {
    const { getByTitle } = await row({ id: 'feed:discover.bsky.app' })
    expect(getByTitle('discover.bsky.app').children[0]!.textContent).toBe('Discover feed')
  })

  it.each<[string, Partial<ServiceProbe>, string]>([
    ['a live service’s latency', { state: 'live', latencyMs: 184 }, '184 ms'],
    ['live, when nothing was timed', { state: 'live', latencyMs: null }, 'Live'],
    ['a slow service’s latency', { state: 'slow', latencyMs: 16_400 }, 'Slow · 16 s'],
    ['slow, when nothing was timed', { state: 'slow', latencyMs: null }, 'Slow'],
    [
      'how many checks a partial failure passes',
      {
        state: 'partial',
        checks: [makeCheck(), makeCheck({ ok: false }), makeCheck({ ok: false })]
      },
      '1 of 3 passing'
    ],
    ['down', { state: 'down' }, 'Down'],
    ['a check in flight', { state: 'pending', startedAt: '2026-01-01T11:59:58Z' }, 'Checking…'],
    [
      'a check in flight for longer than it should be',
      { state: 'pending', startedAt: '2026-01-01T11:59:40Z' },
      'Still waiting…'
    ],
    ['a check in flight with no start time', { state: 'pending', startedAt: null }, 'Checking…'],
    ['a re-check', { state: 'pending', rechecking: true }, 'Re-checking…']
  ])('says %s', async (_name, service, expected) => {
    const { container } = await row(service)
    expect(verdict(container)).toBe(expected)
  })

  it('says nothing alarming about a service while offline', async () => {
    const { container } = await row({ state: 'down' }, { offline: true })
    expect(verdict(container)).toBe('No connection')
    expect(container.querySelector('.animate-ping')).toBeNull()
  })

  it('still shows the control checks failing while offline: they are the evidence', async () => {
    const { container } = await row({ id: 'internet:aws', state: 'down' }, { offline: true })
    expect(verdict(container)).toBe('Down')
  })

  it('toggles open and shut', async () => {
    const { getByRole, ontoggle } = await row({})
    const button = getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await fireEvent.click(button)
    expect(ontoggle).toHaveBeenCalledTimes(1)
  })

  it('glows once when revealed', async () => {
    const { container } = await row({}, { highlighted: true })
    expect(container.querySelector('.highlighted')).not.toBeNull()
  })
})

describe('the open row', () => {
  const checks = [
    makeCheck({
      label: 'getProfile',
      target: 'https://api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did:plc:abc',
      durationMs: 184
    }),
    makeCheck({ label: 'firehose', kind: 'stream', durationMs: 16_000 }),
    makeCheck({ label: '_health', ok: false, error: 'HTTP 502', durationMs: 90 }),
    makeCheck({ label: 'newest post', kind: 'derived', target: null, durationMs: null }),
    makeCheck({ label: 'listRecords', ok: null, durationMs: null })
  ]

  it('lists every request, what it asked, and how long it took', async () => {
    const { container, getByText } = await row({ checks, state: 'partial' }, { expanded: true })
    const items = [...container.querySelectorAll('li')]
    expect(items.map((item) => item.querySelector('.font-mono')!.textContent)).toEqual([
      'getProfile',
      'firehose',
      '_health',
      'newest post',
      'listRecords'
    ])
    expect(items[0]!.textContent).toContain('did:plc:abc')
    expect(items[0]!.textContent).toContain('184 ms')
    expect(items[0]!.title).toBe(checks[0]!.target)
    expect(items[3]!.textContent).toContain('—')
    expect(items[3]!.title).toBe('')
    expect(items[4]!.textContent).toContain('…')
    expect(getByText('Bad gateway')).toBeTruthy()
  })

  it('sets a failure as a code and what it means', async () => {
    const { container, getByText } = await row({ checks, state: 'partial' }, { expanded: true })
    const failure = container.querySelector('li:nth-child(3) p')!
    expect(failure.className).toContain('text-sev-outage')
    expect(failure.textContent!.replace(/\s+/g, ' ').trim()).toBe('502 Bad gateway')
    expect(getByText('502').className).toContain('font-mono')
  })

  it('marks an answer that took the slow threshold', async () => {
    const { container } = await row({ checks }, { expanded: true })
    const firehose = container.querySelectorAll('li')[1]!
    expect(firehose.querySelector('.text-sev-degraded')?.textContent).toBe('16 s')
  })

  it('counts answers while a sweep runs, and passes once it is done', async () => {
    const running = await row({ checks, state: 'partial' }, { expanded: true })
    expect(running.container.textContent).toContain('4 of 5 answered')

    const done = await row({ checks: checks.slice(0, 4), state: 'partial' }, { expanded: true })
    expect(done.container.textContent).toContain('3 of 4 passed')
  })

  it('shows the uptime strip', async () => {
    const { getByRole } = await row({}, { expanded: true })
    expect(getByRole('img', { name: 'Recent checks' })).toBeTruthy()
  })

  it.each<[string, Partial<ServiceProbe>, Record<string, unknown>, string, string]>([
    [
      'down',
      { condition: 'down', since: '2026-01-01T11:48:00Z' },
      {},
      'Unreachable for 12 minutes',
      'text-sev-outage'
    ],
    [
      'partly failing',
      { condition: 'partial', since: '2026-01-01T10:00:00Z' },
      {},
      'Partly failing for 2 hours',
      'text-sev-investigating'
    ],
    [
      'up',
      { condition: 'up', since: '2026-01-01T11:30:00Z' },
      {},
      'Answering for 30 minutes',
      'text-muted-foreground'
    ],
    [
      'being re-checked',
      { rechecking: true },
      {},
      'Failed once. Re-checking before believing it',
      'text-sev-investigating'
    ],
    [
      'offline',
      {},
      { offline: true },
      'Judged again once you are back online',
      'text-muted-foreground'
    ],
    [
      'a control check',
      { id: 'internet:github' },
      {},
      'Control check: judges your connection',
      'text-muted-foreground'
    ]
  ])('says how long it has been %s', async (_name, service, props, text, tone) => {
    const { getByText } = await row(service, { expanded: true, ...props })
    expect(getByText(text).className).toContain(tone)
  })

  it('says a change that just happened happened just now', async () => {
    const { getByText } = await row(
      { condition: 'up', since: '2026-01-01T11:59:40Z' },
      { expanded: true }
    )
    expect(getByText('Answering since just now')).toBeTruthy()
  })

  it('says nothing about a service it has not judged', async () => {
    const unjudged = await row({ condition: 'unknown' }, { expanded: true })
    expect(unjudged.container.textContent).not.toMatch(/for \d/)

    const undated = await row({ condition: 'up', since: null }, { expanded: true })
    expect(undated.container.textContent).not.toContain('Answering for')
  })

  it('leaves the counts out before any request is made', async () => {
    const { container } = await row({ checks: [], state: 'pending' }, { expanded: true })
    expect(container.textContent).not.toMatch(/\d of \d/)
  })
})

describe('the tiers', () => {
  it('marks a community service, and says why its outage is not counted', async () => {
    const { container, getByText } = await row(
      {
        id: 'pds:pds.rip',
        state: 'down',
        condition: 'down',
        since: '2026-01-01T11:00:00Z'
      },
      { expanded: true }
    )
    expect(getByText('community')).toBeTruthy()
    expect(container.textContent).toContain('Unreachable for 1 hour · best effort, so not counted')
  })

  it('leaves the network proper unmarked', async () => {
    const { queryByText } = await row({ id: PDS, state: 'down', condition: 'down' })
    expect(queryByText('community')).toBeNull()
  })
})
