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
const decoder = new TextDecoder()

function decodeSlice(bytes: Uint8Array, start: number, end: number): string {
  return decoder.decode(bytes.subarray(start, end))
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
 * Facets that are malformed, out of range, or that overlap an earlier facet are
 * dropped and their text is emitted as plain text — the AppView does not guarantee
 * well-formed facets, and a bad one should never lose us the post body.
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
      const feature = facet.features?.find((f) => featureToSegment(f, '') !== null)
      if (!feature) return null
      return { start, end, feature }
    })
    .filter(
      (
        f
      ): f is { start: number; end: number; feature: NonNullable<RawFacet['features']>[number] } =>
        f !== null
    )
    .toSorted((a, b) => a.start - b.start)

  const segments: RichSegment[] = []
  let cursor = 0

  for (const facet of usable) {
    // Overlaps a facet we already emitted; skip it rather than double-rendering text.
    if (facet.start < cursor) continue

    if (facet.start > cursor) {
      const plain = decodeSlice(bytes, cursor, facet.start)
      if (plain) segments.push({ kind: 'text', text: plain })
    }

    const inner = decodeSlice(bytes, facet.start, facet.end)
    const segment = featureToSegment(facet.feature, inner)
    segments.push(segment ?? { kind: 'text', text: inner })
    cursor = facet.end
  }

  if (cursor < bytes.length) {
    const tail = decodeSlice(bytes, cursor, bytes.length)
    if (tail) segments.push({ kind: 'text', text: tail })
  }

  return segments
}

/** Flatten segments back to plain text — used for notification bodies. */
export function segmentsToPlainText(segments: RichSegment[]): string {
  return segments.map((s) => s.text).join('')
}
