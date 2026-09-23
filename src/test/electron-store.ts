/**
 * An in-memory stand-in for `electron-store`, aliased in `vitest.config.ts`.
 *
 * It mirrors what `conf`, underneath `electron-store`, actually does with the file:
 *
 * - Defaults are merged into the file once, when the store is opened, and are not
 *   consulted again. A key the app deletes is gone — `get` answers `undefined`, not the
 *   default — until the next launch opens the file and merges the defaults back in.
 * - Every `get` and `set` is a round trip through JSON, because the file is JSON. A value
 *   read back is always a copy, so code that mutates what `get` returned must `set` it for
 *   the change to stick; and anything JSON cannot hold — an `undefined` property, a `Date`,
 *   a `Map` — comes back the way JSON leaves it, not the way it went in.
 * - `set` refuses what the file cannot hold at all: a function or a symbol, and an
 *   `undefined` anywhere in the object form.
 *
 * One deliberate leniency: `conf` also throws on `set(key, undefined)` ("Use `delete()`
 * to clear values"). Here it only drops the key, the way the JSON file would, because
 * src/main/store.test.ts still runs `reconcile()` over stores with no `read` default,
 * which hands `set('read', …)` an `undefined` no real config file can produce.
 */
import type ElectronStore from 'electron-store'
import type { Conforms, Constructible, Surface } from './electron'

/** Contents to pretend are already on disk the next time a store is constructed. */
const seeds = new Map<string, Record<string, unknown>>()

/**
 * What any store can be asked whatever its shape, which is all a registry of stores of
 * every shape can promise.
 */
type AnyStore = Pick<
  FakeElectronStore<Record<string, unknown>>,
  'name' | 'path' | 'data' | 'writes'
>

/** Every store constructed, newest last, for assertions about persistence. */
export const stores: AnyStore[] = []

export interface FakeStoreOptions<T> {
  name?: string
  cwd?: string
  defaults?: T
  clearInvalidConfig?: boolean
  schema?: unknown
}

/** Through the file and back: what a value looks like the next time anything reads it. */
function viaJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/** What `conf` refuses before it ever reaches the file. */
function checkValueType(key: string, value: unknown): void {
  const type = typeof value
  if (type === 'undefined' || type === 'symbol' || type === 'function') {
    throw new TypeError(
      `Setting a value of type \`${type}\` for key \`${key}\` is not allowed as it's not supported by JSON`
    )
  }
}

export default class FakeElectronStore<T extends Record<string, unknown>> {
  readonly name: string
  readonly path: string
  readonly defaults: Partial<T>
  /**
   * The file's contents: the defaults merged under whatever was on disk when the store
   * was opened, and every write since. Read it directly to assert on what was persisted.
   */
  data: Record<string, unknown>
  /** Every key written, in order, so tests can assert a write actually happened. */
  readonly writes: string[] = []

  constructor(options: FakeStoreOptions<T> = {}) {
    this.name = options.name ?? 'config'
    this.path = `/tmp/statusky-test/${this.name}.json`
    this.defaults = viaJson<Partial<T>>(options.defaults ?? {})
    this.data = viaJson({ ...this.defaults, ...seeds.get(this.name) })
    stores.push(this)
  }

  get<K extends keyof T>(key: K): T[K]
  get<K extends keyof T>(key: K, fallback: Required<T>[K]): Required<T>[K]
  /** A key the shape does not declare, which `conf` answers too: whatever is there. */
  get<V = unknown>(key: string, fallback?: V): V
  get(key: string, fallback?: unknown): unknown {
    return key in this.data ? viaJson(this.data[key]) : fallback
  }

  set(key: string | Record<string, unknown>, value?: unknown): void {
    if (typeof key === 'object') {
      for (const [k, v] of Object.entries(key)) checkValueType(k, v)
      for (const [k, v] of Object.entries(key)) this.write(k, v)
      return
    }
    // See the header: `conf` would throw here.
    if (value === undefined) {
      delete this.data[key]
      this.writes.push(key)
      return
    }
    checkValueType(key, value)
    this.write(key, value)
  }

  has(key: string): boolean {
    return key in this.data
  }

  delete(key: string): void {
    delete this.data[key]
  }

  /** Empty the file, then put back every key that has a default. */
  clear(): void {
    this.data = viaJson({ ...this.defaults })
  }

  reset<K extends keyof T>(...keys: K[]): void {
    for (const key of keys) {
      const fallback = this.defaults[key]
      if (fallback !== undefined) this.set(String(key), fallback)
    }
  }

  get store(): T {
    return viaJson(this.data) as T
  }

  set store(value: T) {
    this.data = viaJson(value)
  }

  get size(): number {
    return Object.keys(this.data).length
  }

  onDidChange(): () => void {
    return () => {}
  }

  onDidAnyChange(): () => void {
    return () => {}
  }

  async openInEditor(): Promise<void> {}

  private write(key: string, value: unknown): void {
    this.data[key] = viaJson(value)
    this.writes.push(key)
  }
}

/** Pretend `name`'s config file already contains `data` on the next construction. */
export function seedStore(name: string, data: Record<string, unknown>): void {
  seeds.set(name, data)
}

/**
 * The double behind a store production code opened. Production is type-checked against
 * the real package, so what `createStore()` hands back is typed as the real class even
 * though the alias in vitest.config.ts made it this one; this says so out loud, and
 * fails loudly if the alias is ever not in place.
 */
export function fakeStore<T extends Record<string, unknown>>(
  store: ElectronStore<T>
): FakeElectronStore<T> {
  if (store instanceof FakeElectronStore) return store
  throw new TypeError('Expected the electron-store double: is its alias in vitest.config.ts?')
}

export function resetStores(): void {
  seeds.clear()
  stores.length = 0
}

/** A shape to hold the double to the real class at: one of each kind of value kept. */
interface Sample extends Record<string, unknown> {
  count: number
  list: string[]
  nested: { on: boolean }
  optional?: string
}

/**
 * The double held to `electron-store`'s own declarations, for what production calls and
 * what the harness reads back. `get`, `set`, `delete` and `has` are overloaded generics,
 * which only compare the lenient way round; the rest are held strictly. See electron.ts.
 */
export type _DriftGuards = [
  Conforms<typeof FakeElectronStore<Sample>, Constructible<typeof ElectronStore<Sample>>>,
  Conforms<
    FakeElectronStore<Sample>,
    Pick<ElectronStore<Sample>, 'get' | 'set' | 'delete' | 'has'> &
      Surface<ElectronStore<Sample>, 'clear' | 'reset' | 'openInEditor' | 'store' | 'size' | 'path'>
  >
]
