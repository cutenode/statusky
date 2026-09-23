import type { RichSegment } from './types'

/**
 * Raw facet shape as it appears on an `app.bsky.feed.post` record.
 * Indices are byte offsets into the UTF-8 encoding of `text`, not code-unit offsets,
 * so any emoji or non-ASCII character ahead of a facet shifts it.
 */
export interface RawFacet {
  index?: { byteStart?: number; byteEnd?: number }
  features?: { $type?: string; uri?: string; did?: string; tag?: string }[]
}

const encoder = new TextEncoder()
// Every segment is decoded separately, and a default decoder would take a U+FEFF at the
// start of one for a byte-order mark and drop it.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

function decodeSlice(bytes: Uint8Array, start: number, end: number): string {
  return decoder.decode(bytes.subarray(start, end))
}

/** UTF-8 continuation bytes are 10xxxxxx: an offset that lands on one is inside a character. */
function onBoundary(bytes: Uint8Array, index: number): boolean {
  return index === bytes.length || (bytes[index]! & 0xc0) !== 0x80
}

function featureToSegment(
  feature: NonNullable<RawFacet['features']>[number],
  text: string
): RichSegment | null {
  switch (feature.$type) {
    case 'app.bsky.richtext.facet#link':
      return feature.uri ? { kind: 'link', text, uri: feature.uri } : null
    case 'app.bsky.richtext.facet#mention':
      return feature.did ? { kind: 'mention', text, did: feature.did } : null
    case 'app.bsky.richtext.facet#tag':
      return feature.tag ? { kind: 'tag', text, tag: feature.tag } : null
    default:
      return null
  }
}

/**
 * Split post text into renderable segments using its facets.
 *
 * Facets that are malformed, out of range, split a character, or overlap an earlier
 * facet are dropped and their text is emitted as plain text — the AppView does not
 * guarantee well-formed facets, and a bad one should never lose us the post body.
 */
export function segmentRichText(text: string, facets: RawFacet[] | undefined): RichSegment[] {
  const bytes = encoder.encode(text)
  if (!facets?.length) {
    return text ? [{ kind: 'text', text }] : []
  }

  const usable = facets
    .map((facet) => {
      const start = facet.index?.byteStart
      const end = facet.index?.byteEnd
      if (typeof start !== 'number' || typeof end !== 'number') return null
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null
      if (start < 0 || end > bytes.length || start >= end) return null
      // A client that counted UTF-16 units rather than bytes lands mid-character.
      if (!onBoundary(bytes, start) || !onBoundary(bytes, end)) return null
      // The first feature we can render, with its text filled in once it is decoded.
      const segment = facet.features?.map((f) => featureToSegment(f, '')).find((s) => s !== null)
      if (!segment) return null
      return { start, end, segment }
    })
    .filter((f): f is { start: number; end: number; segment: RichSegment } => f !== null)
    .toSorted((a, b) => a.start - b.start)

  const segments: RichSegment[] = []
  let cursor = 0

  for (const facet of usable) {
    // Overlaps a facet we already emitted; skip it rather than double-rendering text.
    if (facet.start < cursor) continue

    // Whole characters on both sides, so a non-empty range never decodes to nothing.
    if (facet.start > cursor) {
      segments.push({ kind: 'text', text: decodeSlice(bytes, cursor, facet.start) })
    }
    segments.push({ ...facet.segment, text: decodeSlice(bytes, facet.start, facet.end) })
    cursor = facet.end
  }

  if (cursor < bytes.length) {
    segments.push({ kind: 'text', text: decodeSlice(bytes, cursor, bytes.length) })
  }

  return segments
}

/** Flatten segments back to plain text — used for notification bodies. */
export function segmentsToPlainText(segments: RichSegment[]): string {
  return segments.map((s) => s.text).join('')
}
