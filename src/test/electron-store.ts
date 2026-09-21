/**
 * An in-memory stand-in for `electron-store`, aliased in `vitest.config.ts`.
 *
 * It mirrors the two behaviours the app actually depends on: defaults fill in for
 * absent keys, and every `get`/`set` round-trips through a structural copy the way
 * a real JSON-backed store does. The copying matters — code that mutates the object
 * it got back from `get` must call `set` for the change to stick, and this fake
 * enforces that just like the real one.
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

function clone<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T)
}

export default class FakeElectronStore<T extends Record<string, unknown>> {
  readonly name: string
  readonly path: string
  readonly defaults: Partial<T>
  /** Raw persisted data. Read it directly to assert on what was written. */
  data: Record<string, unknown>
  /** Every key written, in order, so tests can assert a write actually happened. */
  readonly writes: string[] = []

  constructor(options: FakeStoreOptions<T> = {}) {
    this.name = options.name ?? 'config'
    this.path = `/tmp/statusky-test/${this.name}.json`
    this.defaults = clone(options.defaults ?? ({} as T))
    this.data = clone(seeds.get(this.name) ?? {})
    stores.push(this as unknown as FakeElectronStore<Record<string, unknown>>)
  }

  get<K extends keyof T>(key: K): T[K]
  get<K extends keyof T>(key: K, fallback: T[K]): T[K]
  get(key: string, fallback?: unknown): unknown {
    if (key in this.data) return clone(this.data[key])
    if (key in this.defaults) return clone((this.defaults as Record<string, unknown>)[key])
    return clone(fallback)
  }

  set(key: string | Record<string, unknown>, value?: unknown): void {
    if (typeof key === 'object') {
      for (const [k, v] of Object.entries(key)) this.set(k, v)
      return
    }
    this.data[key] = clone(value)
    this.writes.push(key)
  }

  has(key: string): boolean {
    return key in this.data || key in this.defaults
  }

  delete(key: string): void {
    delete this.data[key]
  }

  clear(): void {
    this.data = {}
  }

  reset(...keys: string[]): void {
    for (const key of keys) {
      this.data[key] = clone((this.defaults as Record<string, unknown>)[key])
    }
  }

  get store(): T {
    return { ...clone(this.defaults), ...clone(this.data) } as T
  }

  set store(value: T) {
    this.data = clone(value)
  }

  get size(): number {
    return Object.keys(this.store).length
  }

  onDidChange(): () => void {
    return () => {}
  }

  onDidAnyChange(): () => void {
    return () => {}
  }

  openInEditor(): void {}
}

/** Pretend `name`'s config file already contains `data` on the next construction. */
export function seedStore(name: string, data: Record<string, unknown>): void {
  seeds.set(name, data)
}

export function resetStores(): void {
  seeds.clear()
  stores.length = 0
}
