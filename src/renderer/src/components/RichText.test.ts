import { describe, expect, it } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import type { RichSegment } from '@shared/types'
import { renderWith } from '../test/render'
import RichText from './RichText.svelte'

describe('RichText', () => {
  it('renders plain text', async () => {
    const segments: RichSegment[] = [{ kind: 'text', text: 'Everything is fine.' }]
    const { getByText } = await renderWith(RichText, { segments, text: 'Everything is fine.' })
    expect(getByText('Everything is fine.')).toBeTruthy()
  })

  it('falls back to the raw text when segmentation produced nothing', async () => {
    const { container } = await renderWith(RichText, { segments: [], text: 'Raw body' })
    expect(container.textContent).toContain('Raw body')
  })

  it('renders a link with its target as the href and the title', async () => {
    const segments: RichSegment[] = [
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'status.bsky.app', uri: 'https://status.bsky.app' }
    ]
    const { getByRole } = await renderWith(RichText, { segments, text: 'See status.bsky.app' })

    const link = getByRole('link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://status.bsky.app')
    expect(link.getAttribute('title')).toBe('https://status.bsky.app')
    expect(link.textContent).toBe('status.bsky.app')
  })

  it('links a mention to the profile and a tag to the hashtag feed', async () => {
    const segments: RichSegment[] = [
      { kind: 'mention', text: '@bsky.app', did: 'did:plc:abc' },
      { kind: 'text', text: ' ' },
      { kind: 'tag', text: '#outage', tag: 'outage' }
    ]
    const { getAllByRole } = await renderWith(RichText, { segments, text: '@bsky.app #outage' })

    const [mention, tag] = getAllByRole('link') as HTMLAnchorElement[]
    expect(mention?.getAttribute('href')).toBe('https://bsky.app/profile/did:plc:abc')
    expect(tag?.getAttribute('href')).toBe('https://bsky.app/hashtag/outage')
  })

  it.each([
    [
      'link',
      { kind: 'link', text: 'here', uri: 'https://status.bsky.app' },
      'https://status.bsky.app'
    ],
    [
      'mention',
      { kind: 'mention', text: '@x', did: 'did:plc:abc' },
      'https://bsky.app/profile/did:plc:abc'
    ],
    ['tag', { kind: 'tag', text: '#x', tag: 'outage' }, 'https://bsky.app/hashtag/outage']
  ] as [string, RichSegment, string][])(
    'opens a %s in the real browser instead of navigating',
    async (_kind, segment, expected) => {
      const { bridge, getByRole } = await renderWith(RichText, {
        segments: [segment],
        text: segment.text
      })

      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      await fireEvent(getByRole('link'), event)

      expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(expected)
      expect(event.defaultPrevented).toBe(true)
    }
  )

  /**
   * Left to Chromium a middle click is "open in a new tab", which in Electron is a popup
   * request that never passes through `onclick` and reaches main with whatever the href
   * says. It is taken here instead, and opened the way a left click is.
   */
  it.each([
    [
      'link',
      { kind: 'link', text: 'here', uri: 'https://status.bsky.app/' },
      'https://status.bsky.app/'
    ],
    [
      'mention',
      { kind: 'mention', text: '@x', did: 'did:plc:abc' },
      'https://bsky.app/profile/did:plc:abc'
    ],
    ['tag', { kind: 'tag', text: '#x', tag: 'outage' }, 'https://bsky.app/hashtag/outage']
  ] as [string, RichSegment, string][])(
    'opens a %s in the real browser on a middle click, instead of as a popup',
    async (_kind, segment, expected) => {
      const { bridge, getByRole } = await renderWith(RichText, {
        segments: [segment],
        text: segment.text
      })

      const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
      await fireEvent(getByRole('link'), event)

      expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(expected)
      expect(event.defaultPrevented).toBe(true)
    }
  )

  it('does nothing a browser would with any other button, and opens nothing', async () => {
    const segments: RichSegment[] = [
      { kind: 'link', text: 'here', uri: 'https://status.bsky.app/' }
    ]
    const { bridge, getByRole } = await renderWith(RichText, { segments, text: 'here' })

    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 })
    await fireEvent(getByRole('link'), event)

    expect(bridge.api.Host.openExternal).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  // A link dragged out of the popover is a URL dropped wherever the cursor ends up.
  it('makes no link draggable', async () => {
    const segments: RichSegment[] = [
      { kind: 'link', text: 'here', uri: 'https://status.bsky.app/' },
      { kind: 'mention', text: '@x', did: 'did:plc:abc' },
      { kind: 'tag', text: '#x', tag: 'outage' }
    ]
    const { getAllByRole } = await renderWith(RichText, { segments, text: '' })

    const links = getAllByRole('link') as HTMLAnchorElement[]
    expect(links).toHaveLength(3)
    expect(links.map((link) => link.getAttribute('draggable'))).toEqual(['false', 'false', 'false'])
  })

  it('preserves newlines and renders every segment in order', async () => {
    const segments: RichSegment[] = [
      { kind: 'text', text: 'Line one\nLine two ' },
      { kind: 'link', text: 'details', uri: 'https://status.bsky.app' },
      { kind: 'text', text: ' end' }
    ]
    const { container } = await renderWith(RichText, { segments, text: '' })

    expect(container.textContent).toBe('Line one\nLine two details end')
    expect(container.querySelector('p')?.className).toContain('whitespace-pre-wrap')
  })

  it('escapes rather than interprets HTML in post text', async () => {
    const segments: RichSegment[] = [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]
    const { container } = await renderWith(RichText, { segments, text: '' })

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('<img src=x onerror=alert(1)>')
  })
})
