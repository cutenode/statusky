import { describe, expect, it } from 'vitest'
import { segmentRichText, segmentsToPlainText, type RawFacet } from './richtext'

function link(byteStart: number, byteEnd: number, uri: string): RawFacet {
  return {
    index: { byteStart, byteEnd },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri }]
  }
}

describe('segmentRichText', () => {
  it('returns a single text segment when there are no facets', () => {
    expect(segmentRichText('hello', undefined)).toEqual([{ kind: 'text', text: 'hello' }])
    expect(segmentRichText('hello', [])).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('returns nothing for empty text', () => {
    expect(segmentRichText('', undefined)).toEqual([])
  })

  it('splits a trailing link out of the surrounding text', () => {
    const text = 'This incident has been resolved.\n\nstatus.bsky.app'
    const start = new TextEncoder().encode('This incident has been resolved.\n\n').length
    const segments = segmentRichText(text, [
      link(start, start + 'status.bsky.app'.length, 'https://status.bsky.app')
    ])

    expect(segments).toEqual([
      { kind: 'text', text: 'This incident has been resolved.\n\n' },
      { kind: 'link', text: 'status.bsky.app', uri: 'https://status.bsky.app' }
    ])
  })

  it('uses byte offsets, not code-unit offsets', () => {
    // "🌩" is 4 UTF-8 bytes but 2 UTF-16 code units; a naive slice would be off by two.
    const text = '🌩 status.bsky.app now'
    const bytes = new TextEncoder()
    const start = bytes.encode('🌩 ').length
    const end = start + bytes.encode('status.bsky.app').length

    const segments = segmentRichText(text, [link(start, end, 'https://status.bsky.app')])
    expect(segments).toEqual([
      { kind: 'text', text: '🌩 ' },
      { kind: 'link', text: 'status.bsky.app', uri: 'https://status.bsky.app' },
      { kind: 'text', text: ' now' }
    ])
  })

  it('handles mentions and tags', () => {
    const text = '@alice.test #outage'
    const segments = segmentRichText(text, [
      {
        index: { byteStart: 0, byteEnd: 11 },
        features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:alice' }]
      },
      {
        index: { byteStart: 12, byteEnd: 19 },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'outage' }]
      }
    ])

    expect(segments).toEqual([
      { kind: 'mention', text: '@alice.test', did: 'did:plc:alice' },
      { kind: 'text', text: ' ' },
      { kind: 'tag', text: '#outage', tag: 'outage' }
    ])
  })

  it('sorts facets that arrive out of order', () => {
    const text = 'a.com and b.com'
    const segments = segmentRichText(text, [
      link(10, 15, 'https://b.com'),
      link(0, 5, 'https://a.com')
    ])
    expect(segments.map((s) => s.text)).toEqual(['a.com', ' and ', 'b.com'])
  })

  it.each([
    ['a missing index', { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'x' }] }],
    ['a reversed range', link(9, 3, 'https://x.test')],
    ['a zero-width range', link(3, 3, 'https://x.test')],
    ['a negative start', link(-2, 4, 'https://x.test')],
    ['a range past the end', link(0, 9999, 'https://x.test')],
    [
      'a non-integer index',
      {
        index: { byteStart: 0.5, byteEnd: 4 },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'x' }]
      }
    ],
    [
      'an unknown feature type',
      {
        index: { byteStart: 0, byteEnd: 4 },
        features: [{ $type: 'app.bsky.richtext.facet#weird' }]
      }
    ],
    [
      'a link feature with no uri',
      { index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: 'app.bsky.richtext.facet#link' }] }
    ]
  ])('drops %s without losing the post body', (_name, facet) => {
    const text = 'plain body text'
    expect(segmentsToPlainText(segmentRichText(text, [facet as RawFacet]))).toBe(text)
  })

  it('drops a facet that overlaps one already emitted', () => {
    const text = 'abcdefghij'
    const segments = segmentRichText(text, [
      link(0, 5, 'https://first.test'),
      link(3, 8, 'https://overlapping.test')
    ])

    expect(segments).toEqual([
      { kind: 'link', text: 'abcde', uri: 'https://first.test' },
      { kind: 'text', text: 'fghij' }
    ])
    expect(segmentsToPlainText(segments)).toBe(text)
  })

  it('always round-trips to the original text', () => {
    const text = 'Update: see status.bsky.app for 🌩 details'
    const start = new TextEncoder().encode('Update: see ').length
    const segments = segmentRichText(text, [link(start, start + 15, 'https://status.bsky.app')])
    expect(segmentsToPlainText(segments)).toBe(text)
  })
})

describe('facets missing the field their type needs', () => {
  it('drops a mention with no did', () => {
    const text = 'hello @nobody'
    const segments = segmentRichText(text, [
      {
        index: { byteStart: 6, byteEnd: 13 },
        features: [{ $type: 'app.bsky.richtext.facet#mention' }]
      }
    ])
    expect(segments).toEqual([{ kind: 'text', text }])
  })

  it('drops a tag with no tag', () => {
    const text = 'see #outage'
    const segments = segmentRichText(text, [
      { index: { byteStart: 4, byteEnd: 11 }, features: [{ $type: 'app.bsky.richtext.facet#tag' }] }
    ])
    expect(segments).toEqual([{ kind: 'text', text }])
  })

  it('drops a link with no uri', () => {
    const text = 'see status.bsky.app'
    const segments = segmentRichText(text, [
      {
        index: { byteStart: 4, byteEnd: 19 },
        features: [{ $type: 'app.bsky.richtext.facet#link' }]
      }
    ])
    expect(segments).toEqual([{ kind: 'text', text }])
  })

  it('picks the first usable feature when a facet carries several', () => {
    const text = 'see status.bsky.app'
    const segments = segmentRichText(text, [
      {
        index: { byteStart: 4, byteEnd: 19 },
        features: [
          { $type: 'app.bsky.richtext.facet#mention' },
          { $type: 'app.bsky.richtext.facet#link', uri: 'https://status.bsky.app' }
        ]
      }
    ])
    expect(segments).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'status.bsky.app', uri: 'https://status.bsky.app' }
    ])
  })
})
