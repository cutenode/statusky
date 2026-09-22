import { afterEach, describe, expect, it } from 'vitest'
import { nav, TAB_ORDER } from './nav.svelte'

afterEach(() => nav.reset())

describe('navigation', () => {
  it('starts on the timeline', () => {
    expect(nav.view).toBe('timeline')
    expect(nav.tab).toBe('timeline')
    expect(nav.pending).toBeNull()
  })

  it('draws the tabs in the order the shortcuts select them', () => {
    expect(TAB_ORDER).toEqual(['timeline', 'feed', 'network'])
  })

  it.each(TAB_ORDER)('switches to the %s tab', (tab) => {
    nav.open(tab)
    expect(nav.view).toBe(tab)
    expect(nav.tab).toBe(tab)
  })

  it('returns from a detour to whichever tab it left', () => {
    nav.open('network')
    nav.toggle('settings')
    expect(nav.view).toBe('settings')
    expect(nav.tab).toBe('network')

    nav.toggle('settings')
    expect(nav.view).toBe('network')
  })

  it('goes from one detour straight to another', () => {
    nav.open('feed')
    nav.toggle('accounts')
    nav.toggle('settings')
    expect(nav.view).toBe('settings')
    nav.toggle('settings')
    expect(nav.view).toBe('feed')
  })

  it('reveals the dashboard, and hands the reveal over exactly once', () => {
    nav.toggle('accounts')
    nav.reveal('relay:bsky.network')
    expect(nav.view).toBe('network')
    expect(nav.tab).toBe('network')

    expect(nav.takeReveal()).toEqual({ serviceId: 'relay:bsky.network' })
    expect(nav.takeReveal()).toBeNull()
  })

  it('treats the same reveal twice as two reveals', () => {
    nav.reveal('relay:bsky.network')
    const first = nav.pending
    nav.reveal('relay:bsky.network')
    expect(nav.pending).not.toBe(first)
  })

  it('resets to a fresh popover', () => {
    nav.reveal(null)
    nav.reset()
    expect(nav.view).toBe('timeline')
    expect(nav.tab).toBe('timeline')
    expect(nav.pending).toBeNull()
  })
})
