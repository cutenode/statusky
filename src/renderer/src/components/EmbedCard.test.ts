import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import type { PostEmbed } from '@shared/types'
import { makeEmbed } from '../../../test/factories'
import { renderWith } from '../test/render'
import EmbedCard from './EmbedCard.svelte'

describe('an external embed', () => {
  it('shows the host, title and description', async () => {
    const { getByText } = await renderWith(EmbedCard, { embed: makeEmbed('external') })

    expect(getByText('status.bsky.app')).toBeTruthy()
    expect(getByText('Incident 42')).toBeTruthy()
    expect(getByText('Elevated error rates')).toBeTruthy()
  })

  it('strips a www prefix from the host', async () => {
    const embed: PostEmbed = {
      ...makeEmbed('external'),
      uri: 'https://www.example.test/a'
    } as PostEmbed
    const { getByText } = await renderWith(EmbedCard, { embed })
    expect(getByText('example.test')).toBeTruthy()
  })

  it('falls back to the raw value when the uri is not a URL', async () => {
    const embed = { ...makeEmbed('external'), uri: 'not a url' } as PostEmbed
    const { getByText } = await renderWith(EmbedCard, { embed })
    expect(getByText('not a url')).toBeTruthy()
  })

  it('renders the thumbnail without leaking a referrer', async () => {
    const { container } = await renderWith(EmbedCard, { embed: makeEmbed('external') })
    const img = container.querySelector('img')
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(img?.getAttribute('loading')).toBe('lazy')
  })

  it('omits the thumbnail when there is none', async () => {
    const embed = { ...makeEmbed('external'), thumb: null } as PostEmbed
    const { container } = await renderWith(EmbedCard, { embed })
    expect(container.querySelector('img')).toBeNull()
  })

  it('omits the description when there is none', async () => {
    const embed = { ...makeEmbed('external'), description: '' } as PostEmbed
    const { queryByText } = await renderWith(EmbedCard, { embed })
    expect(queryByText('Elevated error rates')).toBeNull()
  })

  it('opens the link externally, without bubbling to the card behind it', async () => {
    const { bridge, getByRole } = await renderWith(EmbedCard, { embed: makeEmbed('external') })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    // Removed by hand: a listener that is never called would outlive the test.
    const bubbled = vi.fn()
    document.body.addEventListener('click', bubbled)
    try {
      await fireEvent(getByRole('button'), event)
    } finally {
      document.body.removeEventListener('click', bubbled)
    }

    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(
      'https://status.bsky.app/incidents/42'
    )
    expect(bubbled).not.toHaveBeenCalled()
  })
})

describe('an images embed', () => {
  it('shows each image with its alt text', async () => {
    const { container } = await renderWith(EmbedCard, { embed: makeEmbed('images') })
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://cdn.bsky.app/thumb-0.jpg')
    expect(img?.getAttribute('alt')).toBe('Latency graph')
  })

  it('switches to a two-column grid for more than one image', async () => {
    const single = await renderWith(EmbedCard, { embed: makeEmbed('images') })
    expect(single.container.querySelector('.grid')?.className).not.toContain('grid-cols-2')
    single.unmount()

    const embed: PostEmbed = {
      kind: 'images',
      images: Array.from({ length: 2 }, (_, i) => ({
        thumb: `t${i}.jpg`,
        fullsize: `f${i}.jpg`,
        alt: ''
      }))
    }
    const { container } = await renderWith(EmbedCard, { embed })
    expect(container.querySelector('.grid')?.className).toContain('grid-cols-2')
  })

  it('shows at most four images', async () => {
    const embed: PostEmbed = {
      kind: 'images',
      images: Array.from({ length: 6 }, (_, i) => ({
        thumb: `t${i}.jpg`,
        fullsize: `f${i}.jpg`,
        alt: ''
      }))
    }
    const { container } = await renderWith(EmbedCard, { embed })
    expect(container.querySelectorAll('img')).toHaveLength(4)
  })

  it('opens the full-size image externally', async () => {
    const { bridge, getByRole } = await renderWith(EmbedCard, { embed: makeEmbed('images') })
    await fireEvent.click(getByRole('button'))
    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith('https://cdn.bsky.app/full-0.jpg')
  })
})

describe('a quoted record embed', () => {
  it('shows the quoted author and body', async () => {
    const { getByText } = await renderWith(EmbedCard, { embed: makeEmbed('record') })
    expect(getByText('@someone.bsky.social')).toBeTruthy()
    expect(getByText('Quoted post body')).toBeTruthy()
  })

  it('is not clickable, because there is nothing sensible to open', async () => {
    const { container } = await renderWith(EmbedCard, { embed: makeEmbed('record') })
    expect(container.querySelector('button')).toBeNull()
  })
})
