/**
 * A CBOR encoder, for building firehose frames in tests.
 *
 * The app only ever decodes CBOR, so this lives with the doubles rather than in
 * `src/shared/cbor.ts`. It writes canonical, definite-length encodings, which is all
 * DAG-CBOR allows, and it can also write the things DAG-CBOR forbids — a raw major/info
 * byte — so the decoder's refusals can be exercised.
 */

/** Bytes written verbatim, for hand-crafting malformed input. */
export class Raw {
  constructor(readonly bytes: number[]) {}
}

/** A tagged value: tag 42 is a CID link. */
export class Tagged {
  constructor(
    readonly tag: number,
    readonly value: unknown
  ) {}
}

/** A float that must be written as float64 even when it is a whole number. */
export class Float {
  constructor(readonly value: number) {}
}

function head(major: number, argument: number): number[] {
  const top = major << 5
  if (argument < 24) return [top | argument]
  if (argument < 0x100) return [top | 24, argument]
  if (argument < 0x10000) return [top | 25, argument >> 8, argument & 0xff]
  if (argument < 0x100000000) {
    return [
      top | 26,
      (argument >>> 24) & 0xff,
      (argument >>> 16) & 0xff,
      (argument >>> 8) & 0xff,
      argument & 0xff
    ]
  }
  const big = BigInt(argument)
  const bytes = [top | 27]
  for (let shift = 56n; shift >= 0n; shift -= 8n) bytes.push(Number((big >> shift) & 0xffn))
  return bytes
}

function float64(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return [0xfb, ...new Uint8Array(view.buffer)]
}

function write(value: unknown): number[] {
  if (value instanceof Raw) return value.bytes
  if (value instanceof Float) return float64(value.value)
  if (value instanceof Tagged) return [...head(6, value.tag), ...write(value.value)]
  if (value === false) return [0xf4]
  if (value === true) return [0xf5]
  if (value === null) return [0xf6]
  if (value === undefined) return [0xf7]
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return float64(value)
    return value >= 0 ? head(0, value) : head(1, -1 - value)
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value)
    return [...head(3, bytes.length), ...bytes]
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value]
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(write)]
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return [...head(5, entries.length), ...entries.flatMap(([k, v]) => write(k).concat(write(v)))]
  }
  throw new TypeError(`Cannot encode ${typeof value}`)
}

export function encode(value: unknown): Uint8Array {
  return new Uint8Array(write(value))
}

/** A firehose message: header and body back to back, as one binary WebSocket frame. */
export function frame(header: unknown, body: unknown): ArrayBuffer {
  const bytes = new Uint8Array([...write(header), ...write(body)])
  return bytes.buffer
}

/** A `#commit` event stamped `time`. */
export function commitFrame(time: string | number = new Date().toISOString()): ArrayBuffer {
  return frame(
    { op: 1, t: '#commit' },
    {
      seq: 1,
      repo: 'did:plc:someone',
      rev: '3abc',
      time,
      ops: [{ action: 'create', path: 'app.bsky.feed.post/3abc', cid: null }],
      blocks: new Uint8Array([1, 2, 3])
    }
  )
}

/** An error frame, which a relay sends before hanging up. */
export function errorFrame(error: string, message?: string): ArrayBuffer {
  return frame({ op: -1 }, message === undefined ? { error } : { error, message })
}
