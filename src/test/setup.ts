/**
 * Global setup shared by both test projects: every double starts each test in the
 * same state, so no test can depend on a neighbour having run first.
 */
import { afterEach, beforeEach, vi } from 'vitest'
import { resetElectron } from './electron'
import { resetWebFrame } from './electron-renderer'
import { resetStores } from './electron-store'
import { resetFactories } from './factories'
import { resetPage } from './page'
import { resetUpdateElectronApp } from './update-electron-app'

beforeEach(() => {
  resetElectron()
  resetWebFrame()
  resetPage()
  resetStores()
  resetFactories()
  resetUpdateElectronApp()
})

afterEach(() => {
  // A test that fails between faking the clock and restoring it must not hand a frozen
  // one to its neighbour, which would then hang on its first real timeout.
  vi.useRealTimers()
  resetElectron()
  resetWebFrame()
  resetStores()
  resetUpdateElectronApp()
  delete (globalThis as Record<string, unknown>).statusky
})
