import { describe, expect, it } from 'vitest'
import { Float, Raw, Tagged, commitFrame, encode } from '../test/cbor'
import { CborError, decode, decodeFirst, toBytes } from './cbor'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

describe('decode', () => {
  it.each([
    ['a small integer', 7],
    ['a one-byte integer', 200],
    ['a two-byte integer', 40_000],
    ['a four-byte integer', 3_000_000_000],
    ['an eight-byte integer', 2 ** 40],
    ['a negative integer', -500],
    ['a string', 'relay'],
    ['a multi-byte string', 'Café ✓'],
    ['an empty array', []],
    ['nested arrays', [1, [2, [3]]]],
    ['an empty map', {}],
    ['a map', { op: 1, t: '#commit' }],
    ['true', true],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
    ['a float', 1.5]
  ])('reads %s', (_name, value) => {
    expect(decode(encode(value))).toEqual(value)
  })

  it('reads a float64 that happens to be whole', () => {
    expect(decode(encode(new Float(2)))).toBe(2)
  })

  it('reads float32', () => {
    expect(decode(bytes(0xfa, 0x3f, 0xc0, 0x00, 0x00))).toBe(1.5)
  })

  it.each([
    ['one', [0x3c, 0x00], 1],
    ['a subnormal', [0x00, 0x01], 2 ** -24],
    ['negative two', [0xc0, 0x00], -2],
    ['infinity', [0x7c, 0x00], Infinity],
    ['negative infinity', [0xfc, 0x00], -Infinity]
  ])('reads a half-precision %s', (_name, half, expected) => {
    expect(decode(bytes(0xf9, ...half))).toBe(expected)
  })

  it('reads a half-precision NaN', () => {
    expect(decode(bytes(0xf9, 0x7e, 0x00))).toBeNaN()
  })

  it('keeps byte strings as views onto the input', () => {
    const input = encode(new Uint8Array([1, 2, 3]))
    const value = decode(input)
    expect(value).toBeInstanceOf(Uint8Array)
    expect([...(value as Uint8Array)]).toEqual([1, 2, 3])
    // A view, not a copy: a firehose frame's CAR blocks are never duplicated to be skipped.
    expect((value as Uint8Array).buffer).toBe(input.buffer)
  })

  it('reads a CID link without interpreting it', () => {
    const cid = new Uint8Array([0, 1, 113, 18])
    const value = decode(encode(new Tagged(42, cid))) as { $cid: Uint8Array }
    expect([...value.$cid]).toEqual([...cid])
  })

  it('unwraps any other tag', () => {
    expect(decode(encode(new Tagged(1, 1_700_000_000)))).toBe(1_700_000_000)
  })

  it('does not let a `__proto__` key reach the prototype', () => {
    const value = decode(encode({ ['__proto__']: { polluted: true } })) as Record<string, unknown>
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.keys(value)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('reads a whole firehose commit body', () => {
    const [header, rest] = decodeFirst(new Uint8Array(commitFrame('2026-01-01T00:00:00Z')))
    expect(header).toEqual({ t: '#commit', op: 1 })
    // The fixture is a real frame, so this reads the parts nothing in the app looks at:
    // a sequence number past 2^32, the CAR block bytes, and the CID links inside and
    // beside the operations. They are where a decoder falls over, and reading the `time`
    // out of a body means having read past all of them.
    expect(decode(rest)).toMatchObject({
      time: '2026-01-01T00:00:00Z',
      seq: 33_825_347_653,
      blocks: expect.any(Uint8Array),
      commit: { $cid: expect.any(Uint8Array) },
      ops: [{ cid: { $cid: expect.any(Uint8Array) }, action: 'create' }]
    })
  })
})

describe('what it refuses', () => {
  it.each([
    ['an empty input', []],
    ['a truncated one-byte argument', [0x18]],
    ['a truncated two-byte argument', [0x19, 0x01]],
    ['a truncated four-byte argument', [0x1a, 0x01]],
    ['a truncated eight-byte argument', [0x1b, 0x01]],
    ['a truncated string', [0x63, 0x61]],
    ['a truncated byte string', [0x43, 0x01]],
    ['an array longer than its bytes', [0x85, 0x01]],
    ['a map longer than its bytes', [0xa3, 0x61, 0x61]],
    ['a truncated half float', [0xf9, 0x3c]],
    ['a truncated float32', [0xfa, 0x3f]],
    ['a truncated float64', [0xfb, 0x3f]]
  ])('%s', (_name, input) => {
    expect(() => decode(bytes(...input))).toThrow(CborError)
  })

  it('refuses an indefinite length, which DAG-CBOR forbids', () => {
    expect(() => decode(bytes(0x9f, 0x01, 0xff))).toThrow(/Unsupported length encoding 31/)
  })

  it('refuses a reserved length encoding', () => {
    expect(() => decode(bytes(0x1c))).toThrow(/Unsupported length encoding 28/)
  })

  it('refuses an integer it could not represent exactly', () => {
    expect(() => decode(bytes(0x1b, 0x00, 0x40, 0, 0, 0, 0, 0, 0))).toThrow(/too large/)
  })

  it('refuses text that is not UTF-8', () => {
    expect(() => decode(bytes(0x62, 0xc3, 0x28))).toThrow(/UTF-8/)
  })

  it('refuses a map key that is not a string', () => {
    expect(() => decode(encode(new Raw([0xa1, 0x01, 0x02])))).toThrow(/keys must be strings/)
  })

  it('refuses a CID link that is not bytes', () => {
    expect(() => decode(encode(new Tagged(42, 'not bytes')))).toThrow(/must be bytes/)
  })

  it('refuses an unknown simple value', () => {
    expect(() => decode(bytes(0xf0))).toThrow(/Unsupported simple value/)
  })

  it('refuses nesting deep enough to exhaust the stack', () => {
    const deep = new Uint8Array(100).fill(0x81)
    expect(() => decode(new Uint8Array([...deep, 0x01]))).toThrow(/nested too deeply/)
  })

  it('refuses bytes after the value, where only one was expected', () => {
    expect(() => decode(bytes(0x01, 0x02))).toThrow(/after the value/)
  })

  it('hands back what follows the first value', () => {
    const [value, rest] = decodeFirst(bytes(0x01, 0x02, 0x03))
    expect(value).toBe(1)
    expect([...rest]).toEqual([2, 3])
  })
})

describe('toBytes', () => {
  it('passes a Uint8Array through', () => {
    const input = bytes(1, 2)
    expect(toBytes(input)).toBe(input)
  })

  it('wraps an ArrayBuffer', () => {
    expect([...toBytes(bytes(1, 2).buffer)!]).toEqual([1, 2])
  })

  it('views any other typed array without copying the wrong range', () => {
    const buffer = new ArrayBuffer(8)
    new Uint8Array(buffer).set([9, 9, 1, 2, 9, 9, 9, 9])
    expect([...toBytes(new DataView(buffer, 2, 2))!]).toEqual([1, 2])
  })

  it('refuses text, which the binary firehose never sends', () => {
    expect(toBytes('frame')).toBeNull()
  })
})
