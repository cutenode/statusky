/**
 * Global setup shared by both test projects: every double starts each test in the
 * same state, so no test can depend on a neighbour having run first.
 */
import { afterEach, beforeEach } from 'vitest'
import { resetElectron } from './electron'
import { resetWebFrame } from './electron-renderer'
import { resetStores } from './electron-store'
import { resetFactories } from './factories'
import { resetPage } from './page'

beforeEach(() => {
  resetElectron()
  resetWebFrame()
  resetPage()
  resetStores()
  resetFactories()
})

afterEach(() => {
  resetElectron()
  resetWebFrame()
  resetStores()
  delete (globalThis as Record<string, unknown>).statusky
})
