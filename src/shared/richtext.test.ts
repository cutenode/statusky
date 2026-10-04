import { describe, expect, it } from 'vitest'
import { safeHttpUrl, segmentRichText, segmentsToPlainText, type RawFacet } from './richtext'

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
      link(start, start + 'status.bsky.app'.length, 'https://status.bsky.app/')
    ])

    expect(segments).toEqual([
      { kind: 'text', text: 'This incident has been resolved.\n\n' },
      { kind: 'link', text: 'status.bsky.app', uri: 'https://status.bsky.app/' }
    ])
  })

  it('uses byte offsets, not code-unit offsets', () => {
    // "🌩" is 4 UTF-8 bytes but 2 UTF-16 code units; a naive slice would be off by two.
    const text = '🌩 status.bsky.app now'
    const bytes = new TextEncoder()
    const start = bytes.encode('🌩 ').length
    const end = start + bytes.encode('status.bsky.app').length

    const segments = segmentRichText(text, [link(start, end, 'https://status.bsky.app/')])
    expect(segments).toEqual([
      { kind: 'text', text: '🌩 ' },
      { kind: 'link', text: 'status.bsky.app', uri: 'https://status.bsky.app/' },
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
      link(10, 15, 'https://b.com/'),
      link(0, 5, 'https://a.com/')
    ])
    expect(segments.map((s) => s.text)).toEqual(['a.com', ' and ', 'b.com'])
  })

  it.each([
    [
      'a missing index',
      { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.test/' }] }
    ],
    ['a reversed range', link(9, 3, 'https://x.test/')],
    ['a zero-width range', link(3, 3, 'https://x.test/')],
    ['a negative start', link(-2, 4, 'https://x.test/')],
    ['a range past the end', link(0, 9999, 'https://x.test/')],
    [
      'a non-integer index',
      {
        index: { byteStart: 0.5, byteEnd: 4 },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.test/' }]
      }
    ],
    [
      'an unknown feature type',
      {
        index: { byteStart: 0, byteEnd: 4 },
        features: [{ $type: 'app.bsky.richtext.facet#weird' }]
      }
    ]
  ])('drops %s without losing the post body', (_name, facet) => {
    const text = 'plain body text'
    expect(segmentsToPlainText(segmentRichText(text, [facet as RawFacet]))).toBe(text)
  })

  it('drops a facet that overlaps one already emitted', () => {
    const text = 'abcdefghij'
    const segments = segmentRichText(text, [
      link(0, 5, 'https://first.test/'),
      link(3, 8, 'https://overlapping.test/')
    ])

    expect(segments).toEqual([
      { kind: 'link', text: 'abcde', uri: 'https://first.test/' },
      { kind: 'text', text: 'fghij' }
    ])
    expect(segmentsToPlainText(segments)).toBe(text)
  })

  // Each segment is decoded on its own, and a decoder left to its defaults takes a U+FEFF
  // at the start of one for a byte-order mark.
  it('keeps a zero-width no-break space that starts a segment', () => {
    const text = 'a\uFEFFbc \uFEFF'
    const segments = segmentRichText(text, [
      link(0, 1, 'https://a.test/'),
      link(7, 10, 'https://b.test/')
    ])

    expect(segments).toEqual([
      { kind: 'link', text: 'a', uri: 'https://a.test/' },
      { kind: 'text', text: '\uFEFFbc ' },
      { kind: 'link', text: '\uFEFF', uri: 'https://b.test/' }
    ])
  })

  // What a client that counted UTF-16 units, not bytes, would send for text after "é".
  it('drops a facet that starts or ends inside a character, keeping the text whole', () => {
    expect(segmentRichText('é!', [link(1, 3, 'https://start.test/')])).toEqual([
      { kind: 'text', text: 'é!' }
    ])
    expect(segmentRichText('!é', [link(0, 2, 'https://end.test/')])).toEqual([
      { kind: 'text', text: '!é' }
    ])
  })

  it('always round-trips to the original text', () => {
    const text = 'Update: see status.bsky.app for 🌩 details'
    const start = new TextEncoder().encode('Update: see ').length
    const segments = segmentRichText(text, [link(start, start + 15, 'https://status.bsky.app/')])
    expect(segmentsToPlainText(segments)).toBe(text)
  })
})

/**
 * A post view carries the record as its author wrote it, so the facets are only as
 * well-formed as whoever wrote them. A throw here loses the account's whole sync, and a
 * wrong-typed field kept would fail the post's schema on the way to the popover.
 */
describe('facets that are not the shape the lexicon says', () => {
  const text = 'see status.bsky.app'
  const index = { byteStart: 4, byteEnd: 19 }
  const LINK = 'app.bsky.richtext.facet#link'
  const MENTION = 'app.bsky.richtext.facet#mention'
  const TAG = 'app.bsky.richtext.facet#tag'

  it.each([
    ['a facet list that is not a list', { 0: link(4, 19, 'https://x.test/') }],
    ['a null facet', [null]],
    ['a facet that is a string', ['link']],
    ['an index that is not an object', [{ index: 4, features: [] }]],
    [
      'a byteStart that is not a number',
      [
        {
          index: { byteStart: '4', byteEnd: 19 },
          features: [{ $type: LINK, uri: 'https://x.test/' }]
        }
      ]
    ],
    [
      'a byteEnd that is not a number',
      [
        {
          index: { byteStart: 4, byteEnd: null },
          features: [{ $type: LINK, uri: 'https://x.test/' }]
        }
      ]
    ],
    ['features that are not a list', [{ index, features: { $type: 'x' } }]],
    ['a null feature', [{ index, features: [null] }]],
    ['a uri that is not a string', [{ index, features: [{ $type: LINK, uri: 42 }] }]],
    ['a did that is not a string', [{ index, features: [{ $type: MENTION, did: {} }] }]],
    ['a tag that is not a string', [{ index, features: [{ $type: TAG, tag: ['x'] }] }]]
  ])('drops %s, keeping the text whole', (_name, facets) => {
    expect(segmentRichText(text, facets)).toEqual([{ kind: 'text', text }])
  })

  it('still reads the well-formed facets beside a malformed one', () => {
    expect(segmentRichText(text, [null, link(4, 19, 'https://status.bsky.app/')])).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'status.bsky.app', uri: 'https://status.bsky.app/' }
    ])
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
          { $type: 'app.bsky.richtext.facet#link', uri: 'https://status.bsky.app/' }
        ]
      }
    ])
    expect(segments).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'status.bsky.app', uri: 'https://status.bsky.app/' }
    ])
  })
})

/**
 * A link facet's `uri` is whatever the author typed, and the OS opens any scheme it has a
 * handler for. A post links to web pages; anything else keeps its words and loses only
 * the link, so there is nothing for a click — of any button — to hand to the OS.
 */
describe('links to anywhere but the web', () => {
  const text = 'see status.bsky.app'

  it.each([
    ['a file path', 'file:///Applications/Calculator.app'],
    ['a network share', 'smb://attacker.test/share'],
    ['a Windows search', 'search-ms:query=x&crumb=location:\\\\attacker.test\\share'],
    ['a script', 'javascript:alert(1)'],
    ['an app of its own', 'zoommtg://zoom.us/join?confno=1'],
    ['a relative path', '/profile/x'],
    ['something that is not a URL at all', 'status.bsky.app']
  ])('keeps the words of a link to %s and drops the link', (_name, uri) => {
    expect(segmentRichText(text, [link(4, 19, uri)])).toEqual([{ kind: 'text', text }])
  })

  it('keeps a web link as the parser reads it', () => {
    expect(segmentRichText(text, [link(4, 19, 'HTTPS://Status.Bsky.App')])).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'status.bsky.app', uri: 'https://status.bsky.app/' }
    ])
  })
})

describe('safeHttpUrl', () => {
  it('only accepts http and https URLs', () => {
    expect(safeHttpUrl('https://ok.test/x')).toBe('https://ok.test/x')
    expect(safeHttpUrl('http://ok.test/x')).toBe('http://ok.test/x')
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull()
    expect(safeHttpUrl('smb://share.test/x')).toBeNull()
    expect(safeHttpUrl('not a url')).toBeNull()
    expect(safeHttpUrl('')).toBeNull()
    expect(safeHttpUrl(42)).toBeNull()
  })
})
