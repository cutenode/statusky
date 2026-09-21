/**
 * Just enough DAG-CBOR to read the relay firehose.
 *
 * `com.atproto.sync.subscribeRepos` sends each event as two CBOR values back to back in
 * one binary WebSocket message: a small header naming the event type, then its body.
 * Checking that a relay is alive only needs the `time` on a `#commit` body, so this is a
 * decoder and nothing more — no encoder, no CID parsing, no canonical-order checks. It
 * is still strict about structure, because the input comes off the network: truncated
 * values, indefinite lengths (which DAG-CBOR forbids), integers past 2^53 and absurd
 * nesting are all errors rather than guesses.
 */

/** A CID link (tag 42). The bytes are kept but never interpreted. */
export interface CidLink {
  $cid: Uint8Array
}

/** Deeper than any real frame, shallow enough that a hostile one cannot blow the stack. */
const MAX_DEPTH = 64

const utf8 = new TextDecoder('utf-8', { fatal: true })

export class CborError extends Error {
  override name = 'CborError'
}

interface Cursor {
  bytes: Uint8Array
  view: DataView
  pos: number
}

function need(cursor: Cursor, count: number): void {
  if (cursor.pos + count > cursor.bytes.length) throw new CborError('Unexpected end of input')
}

function readArgument(cursor: Cursor, info: number): number {
  if (info < 24) return info
  const { view } = cursor
  switch (info) {
    case 24:
      need(cursor, 1)
      return view.getUint8(cursor.pos++)
    case 25: {
      need(cursor, 2)
      const value = view.getUint16(cursor.pos)
      cursor.pos += 2
      return value
    }
    case 26: {
      need(cursor, 4)
      const value = view.getUint32(cursor.pos)
      cursor.pos += 4
      return value
    }
    case 27: {
      need(cursor, 8)
      const value = view.getBigUint64(cursor.pos)
      cursor.pos += 8
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new CborError('Integer is too large to decode safely')
      }
      return Number(value)
    }
    default:
      // 28–30 are reserved; 31 is an indefinite length, which DAG-CBOR does not allow.
      throw new CborError(`Unsupported length encoding ${info}`)
  }
}

/** IEEE 754 half precision, which plain CBOR allows even though DAG-CBOR never emits it. */
function halfToNumber(half: number): number {
  const exponent = (half >> 10) & 0x1f
  const fraction = half & 0x3ff
  const sign = half & 0x8000 ? -1 : 1
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

function readSimple(cursor: Cursor, info: number): unknown {
  const { view } = cursor
  switch (info) {
    case 20:
      return false
    case 21:
      return true
    case 22:
      return null
    case 23:
      return undefined
    case 25: {
      need(cursor, 2)
      const value = halfToNumber(view.getUint16(cursor.pos))
      cursor.pos += 2
      return value
    }
    case 26: {
      need(cursor, 4)
      const value = view.getFloat32(cursor.pos)
      cursor.pos += 4
      return value
    }
    case 27: {
      need(cursor, 8)
      const value = view.getFloat64(cursor.pos)
      cursor.pos += 8
      return value
    }
    default:
      throw new CborError(`Unsupported simple value ${info}`)
  }
}

function readItem(cursor: Cursor, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new CborError('Value is nested too deeply')
  need(cursor, 1)
  const initial = cursor.view.getUint8(cursor.pos++)
  const major = initial >> 5
  const info = initial & 0x1f

  if (major === 7) return readSimple(cursor, info)

  const argument = readArgument(cursor, info)
  switch (major) {
    case 0:
      return argument
    case 1:
      return -1 - argument
    case 2: {
      need(cursor, argument)
      const bytes = cursor.bytes.subarray(cursor.pos, cursor.pos + argument)
      cursor.pos += argument
      return bytes
    }
    case 3: {
      need(cursor, argument)
      const bytes = cursor.bytes.subarray(cursor.pos, cursor.pos + argument)
      cursor.pos += argument
      try {
        return utf8.decode(bytes)
      } catch {
        throw new CborError('Text is not valid UTF-8')
      }
    }
    case 4: {
      // Every element takes at least a byte, which bounds a lying length before we
      // allocate for it.
      need(cursor, argument)
      const items: unknown[] = []
      for (let i = 0; i < argument; i++) items.push(readItem(cursor, depth + 1))
      return items
    }
    case 5: {
      need(cursor, argument * 2)
      const map: Record<string, unknown> = {}
      for (let i = 0; i < argument; i++) {
        const key = readItem(cursor, depth + 1)
        if (typeof key !== 'string') throw new CborError('Map keys must be strings')
        // A plain assignment to `__proto__` would change the object's prototype.
        Object.defineProperty(map, key, {
          value: readItem(cursor, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true
        })
      }
      return map
    }
    default: {
      // Major type 6, a tag. 42 is a CID link; anything else is unwrapped.
      const inner = readItem(cursor, depth + 1)
      if (argument === 42) {
        if (!(inner instanceof Uint8Array)) throw new CborError('CID link must be bytes')
        return { $cid: inner } satisfies CidLink
      }
      return inner
    }
  }
}

/**
 * Decode the first CBOR value in `bytes` and return it with the bytes left over, which
 * is how a firehose frame's body is reached from behind its header.
 */
export function decodeFirst(bytes: Uint8Array): [value: unknown, rest: Uint8Array] {
  const cursor: Cursor = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    pos: 0
  }
  const value = readItem(cursor, 0)
  return [value, bytes.subarray(cursor.pos)]
}

/** Decode exactly one CBOR value; trailing bytes are an error. */
export function decode(bytes: Uint8Array): unknown {
  const [value, rest] = decodeFirst(bytes)
  if (rest.length) throw new CborError('Unexpected bytes after the value')
  return value
}

/** Bytes from whatever a WebSocket handed over. */
export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}
