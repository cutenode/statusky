import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/svelte'
import { motion } from '$lib/motion.svelte'
import { nav } from '$lib/nav.svelte'
import { targetsDraft } from '$lib/probe-targets-draft.svelte'
import {
  makeNetworkSummary,
  makeService,
  makeSettings,
  makeSnapshot
} from '../../../test/factories'
import type { BridgeOptions } from '../../../test/bridge'
import { renderWith } from '../test/render'
import NetworkPanel from './NetworkPanel.svelte'

const NOW = Date.parse('2026-01-01T12:00:00Z')

const services = [
  makeService({ id: 'relay:bsky.network' }),
  makeService({ id: 'relay:europe.firehose.network', state: 'down' }),
  makeService({ id: 'appview:api.bsky.app' }),
  makeService({ id: 'internet:aws' })
]

const measured: BridgeOptions = {
  snapshot: makeSnapshot({ finishedAt: '2026-01-01T11:59:00Z', services })
}

const panel = (options: BridgeOptions = measured) => renderWith(NetworkPanel, { now: NOW }, options)

const rowButton = (container: HTMLElement, id: string): HTMLButtonElement =>
  container.querySelector(`[data-service="${id}"] > button`)!

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the dashboard', () => {
  it('lays services out in their groups, and skips empty ones', async () => {
    const { container } = await panel()
    const headings = [...container.querySelectorAll('section h2[id^="group-"]')]
    expect(headings.map((h) => h.textContent?.trim())).toEqual(['Relays', 'AppViews', 'Internet'])
    expect(container.querySelector('#group-relays')!.closest('section')!.textContent).toContain(
      '1/2'
    )
  })

  it('marks a panel left out of the menu bar, and never the control group', async () => {
    const { container } = await panel({
      ...measured,
      settings: makeSettings({ countedProbeGroups: ['appviews'] })
    })
    const heading = (id: string): string =>
      container.querySelector(`#group-${id}`)!.textContent!.replace(/\s+/g, ' ').trim()
    expect(heading('relays')).toBe('Relays · not counted')
    expect(heading('appviews')).toBe('AppViews')
    expect(heading('internet')).toBe('Internet')
  })

  it('says when an account the checks read has gone, and offers Settings', async () => {
    const toggle = vi.spyOn(nav, 'toggle')
    const { getByRole } = await panel({
      ...measured,
      network: makeNetworkSummary({
        vanished: [
          { did: 'did:plc:gone', part: 'account' },
          { did: 'did:plc:gone', part: 'handle' }
        ]
      })
    })
    expect(getByRole('status').textContent).toMatch(/^An account the checks read has been deleted/)
    await fireEvent.click(getByRole('button', { name: 'Replace in Settings' }))
    expect(toggle).toHaveBeenCalledWith('settings')
    // And asks the editor there to open on its accounts, not on the top of Settings.
    expect(targetsDraft.expanded.has('accounts')).toBe(true)
    expect(targetsDraft.reveal).toBe('accounts')
  })

  it('explains the control group, and only that one', async () => {
    const { container } = await panel()
    const internet = container.querySelector('#group-internet')!.closest('section')!
    expect(internet.textContent).toContain('the problem is your connection')
    const relays = container.querySelector('#group-relays')!.closest('section')!
    expect(relays.querySelector('p')).toBeNull()
  })

  it('leaves a group’s tally out until something in it is measured', async () => {
    const { container } = await panel({
      snapshot: makeSnapshot({ services: [makeService({ state: 'pending' })] })
    })
    const relays = container.querySelector('#group-relays')!.closest('section')!
    expect(relays.textContent).not.toMatch(/\d\/\d/)
  })

  it('opens and shuts a row', async () => {
    const { container } = await panel()
    const button = rowButton(container, 'relay:europe.firehose.network')
    await fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(
      container.querySelector('[data-service="relay:europe.firehose.network"] ul')
    ).not.toBeNull()

    await fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('credits status.feeds.blue, and links to it', async () => {
    const { getByText, bridge } = await panel()
    await fireEvent.click(getByText('status.feeds.blue'))
    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith('https://status.feeds.blue')
  })

  it('shows only the invitation to turn on when checks are off', async () => {
    const { container } = await panel({
      ...measured,
      settings: makeSettings({ networkChecks: false })
    })
    expect(container.querySelector('[data-service]')).toBeNull()
    expect(container.textContent).toContain('Network checks are off')
  })

  it('draws every row neutral while offline', async () => {
    const { container } = await panel({
      snapshot: makeSnapshot({ ...measured.snapshot, offline: true })
    })
    expect(rowButton(container, 'relay:europe.firehose.network').textContent).toContain(
      'No connection'
    )
  })

  it('jumps to a group from the summary', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { container } = await panel()
    const chip = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Relays')
    )!
    await fireEvent.click(chip)
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(scroll.mock.contexts[0]).toBe(container.querySelector('#group-relays'))
  })
})

describe('being revealed', () => {
  it('opens the service it was asked for, scrolls to it and makes it glow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { container } = await panel()

    nav.reveal('relay:europe.firehose.network')
    await act()
    await act()

    const row = container.querySelector('[data-service="relay:europe.firehose.network"]')!
    expect(row.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
    expect(row.className).toContain('highlighted')
    expect(scroll.mock.contexts).toContain(row)
    expect(nav.pending).toBeNull()

    await vi.advanceTimersByTimeAsync(1800)
    expect(row.className).not.toContain('highlighted')
  })

  it('keeps the glow on the newest reveal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { container } = await panel()
    nav.reveal('relay:bsky.network')
    await act()
    await vi.advanceTimersByTimeAsync(1000)
    nav.reveal('relay:europe.firehose.network')
    await act()

    // The first reveal's timer runs out while the second service is glowing.
    await vi.advanceTimersByTimeAsync(900)
    const second = container.querySelector('[data-service="relay:europe.firehose.network"]')!
    expect(second.className).toContain('highlighted')
  })

  // Svelte's transitions and a smooth scroll are script, which the stylesheet's
  // reduced-motion rule cannot reach.
  it('goes straight there, rather than smoothly, when asked for less motion', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { container } = await panel()
    motion.reduced = true

    nav.reveal('relay:europe.firehose.network')
    await act()
    await act()
    const chip = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Relays')
    )!
    await fireEvent.click(chip)

    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' })
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  })

  it('goes back to the top when asked for the dashboard itself', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollTo')
    await panel()
    nav.reveal(null)
    await act()
    expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })
})
