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

/** Contents to pretend are already on disk the next time a store is constructed. */
const seeds = new Map<string, Record<string, unknown>>()

/** Every store constructed, newest last, for assertions about persistence. */
export const stores: FakeElectronStore<Record<string, unknown>>[] = []

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
    this.defaults = viaJson(options.defaults ?? ({} as T))
    this.data = viaJson({ ...this.defaults, ...seeds.get(this.name) })
    stores.push(this as unknown as FakeElectronStore<Record<string, unknown>>)
  }

  get<K extends keyof T>(key: K): T[K]
  get<K extends keyof T>(key: K, fallback: T[K]): T[K]
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

  reset(...keys: string[]): void {
    for (const key of keys) {
      const fallback = (this.defaults as Record<string, unknown>)[key]
      if (fallback !== undefined) this.set(key, fallback)
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

  openInEditor(): void {}

  private write(key: string, value: unknown): void {
    this.data[key] = viaJson(value)
    this.writes.push(key)
  }
}

/** Pretend `name`'s config file already contains `data` on the next construction. */
export function seedStore(name: string, data: Record<string, unknown>): void {
  seeds.set(name, data)
}

export function resetStores(): void {
  seeds.clear()
  stores.length = 0
}
