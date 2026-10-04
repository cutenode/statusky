import type { RichSegment } from './types'

/**
 * Raw facet shape as the lexicon describes it on an `app.bsky.feed.post` record.
 * Indices are byte offsets into the UTF-8 encoding of `text`, not code-unit offsets,
 * so any emoji or non-ASCII character ahead of a facet shifts it.
 *
 * What a well-formed facet looks like, and not a promise about what arrives: a post view
 * carries its record as the author wrote it, so `segmentRichText` takes `unknown` and
 * checks each part of this as it reads it.
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A non-empty string, or null for anything else — an absent field and a wrong one alike. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/**
 * The one rule for which links this app will act on: an absolute http or https URL,
 * normalised, or null for anything else.
 *
 * A link in a post is whatever its author typed, and the OS will hand any scheme it has a
 * handler for to that handler — `smb:` mounts a share, `search-ms:` opens Explorer on a
 * remote folder, and every installed app's own scheme is one more way in. Nothing a
 * status update links to is anything but a web page, so a post's links are held to this
 * when they are read, a pushed update's links are held to it in src/shared/webhook.ts,
 * and everything main opens in a browser is held to it again on the way out, in
 * src/main/external.ts. Three places, one rule.
 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function featureToSegment(feature: unknown, text: string): RichSegment | null {
  if (!isObject(feature)) return null
  switch (feature.$type) {
    case 'app.bsky.richtext.facet#link': {
      // A link to anywhere but the web keeps its words and loses only the link, the same
      // as a facet that is malformed. See `safeHttpUrl`.
      const uri = safeHttpUrl(feature.uri)
      return uri ? { kind: 'link', text, uri } : null
    }
    case 'app.bsky.richtext.facet#mention': {
      const did = nonEmpty(feature.did)
      return did ? { kind: 'mention', text, did } : null
    }
    case 'app.bsky.richtext.facet#tag': {
      const tag = nonEmpty(feature.tag)
      return tag ? { kind: 'tag', text, tag } : null
    }
    default:
      return null
  }
}

/**
 * Split post text into renderable segments using its facets.
 *
 * Facets that are malformed, out of range, split a character, or overlap an earlier
 * facet are dropped and their text is emitted as plain text — the AppView does not
 * guarantee well-formed facets, and a bad one should never lose us the post body. That
 * goes for their shape as well as their numbers: `facets` is whatever the record said,
 * so a `null` in the list or a `uri` that is not a string is dropped like any other —
 * and so is a `uri` that is a string but not a web address, see `safeHttpUrl`.
 */
export function segmentRichText(text: string, facets: unknown): RichSegment[] {
  const bytes = encoder.encode(text)
  if (!Array.isArray(facets) || !facets.length) {
    return text ? [{ kind: 'text', text }] : []
  }

  const usable = facets
    .map((facet: unknown) => {
      if (!isObject(facet) || !isObject(facet.index)) return null
      const start = facet.index.byteStart
      const end = facet.index.byteEnd
      if (typeof start !== 'number' || typeof end !== 'number') return null
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null
      if (start < 0 || end > bytes.length || start >= end) return null
      // A client that counted UTF-16 units rather than bytes lands mid-character.
      if (!onBoundary(bytes, start) || !onBoundary(bytes, end)) return null
      // The first feature we can render, with its text filled in once it is decoded.
      const features: unknown[] = Array.isArray(facet.features) ? facet.features : []
      const segment = features.map((f) => featureToSegment(f, '')).find((s) => s !== null)
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
