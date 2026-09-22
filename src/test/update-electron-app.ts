import { vi } from 'vitest'

/**
 * `update-electron-app`, which cannot run here and cannot be made to.
 *
 * The other doubles in this directory exist because the real thing needs an Electron
 * process. This one exists for a narrower and more annoying reason: the real package is
 * CommonJS inside `node_modules`, so Vitest loads it through Node rather than through
 * Vite, and its `require('electron')` therefore reaches the *real* `electron` package —
 * which outside an Electron process is a module exporting the path to a binary. The
 * `electron` alias in vitest.config.ts does not reach inside it, so there is no way to
 * hand it `src/test/electron.ts`'s doubles, and the first thing it does is read
 * `app.isPackaged` off a string. Aliasing the package itself is the only seam there is.
 *
 * What is lost by standing in for it is the package's own logic — its feed URL
 * construction, its platform list, its option validation — and none of that is this
 * app's to test. What is kept is the whole of the boundary src/main/update.ts owns: that
 * it is called at all, on which platforms, with which options, and what it does when the
 * download it is waiting for finally lands.
 */

/** What Squirrel hands `onNotifyUser`, and the package passes straight through. */
export interface FakeUpdateInfo {
  event: unknown
  releaseNotes: string
  releaseName: string
  releaseDate: Date
  updateURL: string
}

/** The subset of the package's options this app actually supplies. */
export interface FakeUpdateOptions {
  updateInterval?: string
  notifyUser?: boolean
  onNotifyUser?: (info: FakeUpdateInfo) => void
  [key: string]: unknown
}

/**
 * One call to `updateElectronApp`, and the handle it returned.
 *
 * `finishDownload` is the event the whole of part one turns on: Squirrel has fetched a
 * new build and is waiting to be told to restart into it. In Electron that is minutes of
 * background downloading; here it is a method call, which is the only way a test can
 * reach the restart prompt at all.
 */
export class FakeSelfUpdater {
  stopped = false

  constructor(readonly options: FakeUpdateOptions) {}

  readonly stopUpdates = vi.fn((): void => {
    this.stopped = true
  })

  /**
   * Pretend a download finished. The defaults are deliberately the *macOS* shape — a
   * release name and empty notes — because the two platforms fill these in differently
   * and a test about Windows has to say so explicitly rather than inherit it.
   */
  finishDownload(info: Partial<FakeUpdateInfo> = {}): void {
    this.options.onNotifyUser?.({
      event: {},
      releaseNotes: '',
      releaseName: '',
      releaseDate: new Date('2026-01-01T00:00:00.000Z'),
      updateURL: 'https://update.electronjs.org/cutenode/statusky/darwin-arm64/0.1.0-test',
      ...info
    })
  }
}

/** Every call, in order. Empty means the self-updating branch was never taken. */
export const selfUpdaters: FakeSelfUpdater[] = []

/**
 * Set to throw from `updateElectronApp`, the way a bundle whose `package.json` names no
 * repository does: the package asserts its way through its options and through reading
 * that file, so a malformed build fails here rather than later.
 */
export const selfUpdateFailure: { error: unknown } = { error: null }

export const updateElectronApp = vi.fn((options: FakeUpdateOptions = {}): FakeSelfUpdater => {
  if (selfUpdateFailure.error) throw selfUpdateFailure.error
  const updater = new FakeSelfUpdater(options)
  selfUpdaters.push(updater)
  return updater
})

/** The most recent call, for the common case of there being exactly one. */
export function lastSelfUpdater(): FakeSelfUpdater {
  const updater = selfUpdaters.at(-1)
  if (!updater) throw new Error('updateElectronApp has not been called.')
  return updater
}

export function resetUpdateElectronApp(): void {
  selfUpdaters.length = 0
  selfUpdateFailure.error = null
  updateElectronApp.mockClear()
}
