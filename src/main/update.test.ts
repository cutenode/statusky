import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { app, autoUpdater, net } from '../test/electron'
import { lastSelfUpdater, selfUpdateFailure, selfUpdaters } from '../test/update-electron-app'
import { LATEST_RELEASE_API } from '../shared/defaults'
import {
  downloadedVersion,
  isNewerRelease,
  latestReleaseTag,
  restartToUpdate,
  watchUpdates,
  type UpdateDeps,
  type UpdateWatcher
} from './update'

/**
 * Answer the GitHub releases API with `body`, as JSON and with `status`.
 *
 * The `net.fetch` double serves files out of a map and answers 404 to everything else,
 * which is exactly the "no releases published yet" case and so is the default here. Only
 * the tests that need a release replace it.
 */
function serveRelease(body: unknown, status = 200): void {
  net.fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })
  )
}

function deps(): {
  onAvailable: Mock<(version: string) => void>
  onReady: Mock<(version: string | null) => void>
} {
  return { onAvailable: vi.fn(), onReady: vi.fn() }
}

/** Let the first release check, which is fired and not awaited, actually run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const watchers: UpdateWatcher[] = []

/** Every watcher stopped, so no test leaves an interval running into the next one. */
function watch(on: UpdateDeps, options: Parameters<typeof watchUpdates>[1] = {}): UpdateWatcher {
  const watcher = watchUpdates(on, options)
  watchers.push(watcher)
  return watcher
}

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop()
  // The `console.warn` spies, put back even when an assertion ahead of them failed.
  vi.restoreAllMocks()
})

/** Silence the one line each failed check logs, and keep it to assert on. */
function quietly(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

/**
 * `net.fetch` as Chromium behaves with a request that never gets an answer: pending until
 * its signal is aborted, and then rejecting with the reason.
 */
function neverAnswer(): void {
  net.fetch.mockImplementation(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
  )
}

/**
 * How often GitHub is asked over five more one-second intervals, once `watcher` has been
 * stopped. Fake timers only, and only after a fallback has taken over.
 */
async function askedAfterStopping(watcher: UpdateWatcher): Promise<number> {
  await vi.advanceTimersByTimeAsync(0)
  // The fallback has to be running for its stopping to mean anything.
  expect(net.fetch).toHaveBeenCalledTimes(1)
  watcher.stop()
  await vi.advanceTimersByTimeAsync(5000)
  return net.fetch.mock.calls.length - 1
}

describe('isNewerRelease', () => {
  it('compares the numbers as numbers', () => {
    expect(isNewerRelease('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerRelease('0.9.0', '0.10.0')).toBe(false)
    expect(isNewerRelease('1.0.0', '1.0.0')).toBe(false)
    expect(isNewerRelease('1.0.1', '1.0.0')).toBe(true)
    expect(isNewerRelease('2.0.0', '1.99.99')).toBe(true)
  })

  it('takes the v a Git tag usually carries', () => {
    expect(isNewerRelease('v0.2.0', '0.1.0')).toBe(true)
    expect(isNewerRelease('V0.2.0', '0.1.0')).toBe(true)
    expect(isNewerRelease('v0.1.0', '0.1.0')).toBe(false)
  })

  /** A missing component is zero, so `v1` and `1.0.0` name the same release. */
  it('treats a missing component as zero', () => {
    expect(isNewerRelease('v1', '1.0.0')).toBe(false)
    expect(isNewerRelease('1.0.0', 'v1')).toBe(false)
    expect(isNewerRelease('1.0.1', 'v1')).toBe(true)
  })

  /**
   * The semver rule that actually matters here: a suffixed version comes *before* the
   * plain one, so the release supersedes the candidate that led up to it. It is also the
   * rule that makes the test doubles' own `0.1.0-test` a version 0.1.0 is newer than.
   */
  it('puts a release ahead of the pre-release that led to it', () => {
    expect(isNewerRelease('0.1.0', '0.1.0-test')).toBe(true)
    expect(isNewerRelease('0.1.0-test', '0.1.0')).toBe(false)
    expect(isNewerRelease('0.1.0-rc2', '0.1.0-rc1')).toBe(true)
    expect(isNewerRelease('0.1.0-rc1', '0.1.0-rc1')).toBe(false)
  })

  /**
   * Everything the few lines do not understand comes out false rather than true, and
   * that direction is the whole point: a wrong "you are out of date" sends somebody to
   * a download page looking for a build that is not there.
   */
  it('says nothing about anything it cannot read', () => {
    expect(isNewerRelease('latest', '0.1.0')).toBe(false)
    expect(isNewerRelease('release-candidate', '0.1.0')).toBe(false)
    expect(isNewerRelease('', '0.1.0')).toBe(false)
    expect(isNewerRelease('9.9.9', 'not-a-version')).toBe(false)
    // Build metadata is not understood rather than stripped, which is documented.
    expect(isNewerRelease('1.0.0+abc123', '0.1.0')).toBe(false)
  })

  /**
   * The documented limit that is not a refusal: a tag beginning with digits is read as a
   * version whether or not it was meant as one. It is only a problem if this repository
   * ever adopts a scheme like it, and such a scheme still orders correctly against
   * itself, which is why the lines are allowed to be this few.
   */
  it('reads a date-shaped tag as the version it looks like', () => {
    expect(isNewerRelease('2026-01-release', '0.1.0')).toBe(true)
    expect(isNewerRelease('2026-02-release', '2026-01-release')).toBe(true)
    expect(isNewerRelease('2026-01-release', '2026-02-release')).toBe(false)
  })
})

describe('latestReleaseTag', () => {
  it('asks GitHub through Chromium, with a user agent it will accept', async () => {
    serveRelease({ tag_name: 'v0.4.0' })

    await expect(latestReleaseTag()).resolves.toBe('v0.4.0')

    expect(net.fetch).toHaveBeenCalledWith(
      LATEST_RELEASE_API,
      expect.objectContaining({
        // Unauthenticated, so the cookie store has nothing to add and is not waited on.
        // See the comment beside it, and the cookie encryption fuse in forge.config.ts.
        credentials: 'omit',
        headers: expect.objectContaining({ 'User-Agent': expect.stringContaining('Statusky/') })
      })
    )
  })

  /** The ordinary answer for this repository today: nothing has been released yet. */
  it('stays quiet when the repository has no releases', async () => {
    const warn = quietly()
    serveRelease({ message: 'Not Found' }, 404)

    await expect(latestReleaseTag()).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('404'))
  })

  /**
   * 60 unauthenticated calls an hour, shared with everything else on the address. Being
   * refused is not evidence about what version is current, so it reports no state at all
   * rather than a wrong one.
   */
  it('stays quiet when GitHub is rate limiting the whole address', async () => {
    const warn = quietly()
    serveRelease({ message: 'API rate limit exceeded' }, 403)

    await expect(latestReleaseTag()).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('403'))
  })

  it('stays quiet when the body is not JSON at all', async () => {
    quietly()
    net.fetch.mockImplementation(async () => new Response('<html>nope</html>', { status: 200 }))

    await expect(latestReleaseTag()).resolves.toBeNull()
  })

  it('stays quiet when the release carries no usable tag', async () => {
    quietly()

    serveRelease({ name: 'Statusky 0.2.0' })
    await expect(latestReleaseTag()).resolves.toBeNull()

    serveRelease({ tag_name: 42 })
    await expect(latestReleaseTag()).resolves.toBeNull()

    serveRelease({ tag_name: '' })
    await expect(latestReleaseTag()).resolves.toBeNull()
  })

  it('stays quiet when the request never completes', async () => {
    const warn = quietly()
    net.fetch.mockImplementation(async () => {
      throw new Error('net::ERR_NAME_NOT_RESOLVED')
    })

    await expect(latestReleaseTag()).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not ask GitHub'),
      expect.stringContaining('ERR_NAME_NOT_RESOLVED')
    )
  })

  /** A throw on its way out of Chromium is not obliged to be an `Error`. */
  it('survives a failure that is not an Error', async () => {
    const warn = quietly()
    net.fetch.mockImplementation(async () => {
      throw 'offline'
    })

    await expect(latestReleaseTag()).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not ask GitHub'), 'offline')
  })
})

/**
 * A request with no ceiling is not slow, it is outstanding, and a new check starts every
 * interval whether or not the last one came back. Fifteen seconds is far longer than
 * GitHub ever takes, so reaching it means something has gone wrong — and the answer is
 * the same as for every other failure: say nothing.
 */
describe('latestReleaseTag against a connection that stalls', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a request that never answers, after fifteen seconds', async () => {
    vi.useFakeTimers()
    const warn = quietly()
    neverAnswer()

    let answer: string | null | undefined
    void latestReleaseTag().then((tag) => (answer = tag))

    await vi.advanceTimersByTimeAsync(14_999)
    expect(answer).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toBeNull()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not ask GitHub'),
      expect.any(String)
    )
  })

  // The body comes over the same connection as the headers, so a response that starts
  // and never finishes is the same stall and gets the same ceiling.
  it('gives up on a body that never finishes arriving', async () => {
    vi.useFakeTimers()
    quietly()
    net.fetch.mockImplementation(async (_input, init) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"tag_name":"v0.'))
          signal?.addEventListener('abort', () => stream.error(signal.reason))
        }
      })
      return new Response(body, { status: 200 })
    })

    let answer: string | null | undefined
    void latestReleaseTag().then((tag) => (answer = tag))

    await vi.advanceTimersByTimeAsync(15_000)
    expect(answer).toBeNull()
  })

  // Not `unref`'d, so one left behind per check would hold the process open for fifteen
  // seconds after every answer.
  it('lets go of the timer once GitHub has answered', async () => {
    vi.useFakeTimers()
    serveRelease({ tag_name: 'v0.4.0' })

    await expect(latestReleaseTag()).resolves.toBe('v0.4.0')

    expect(vi.getTimerCount()).toBe(0)
  })
})

/**
 * The two platforms fill Squirrel's `update-downloaded` arguments in differently, and
 * `makeUserNotifier` inside `update-electron-app` branching on exactly this is the only
 * documentation of it there is.
 */
describe('downloadedVersion', () => {
  it('reads the release name on macOS and the notes on Windows', () => {
    const info = { releaseName: '0.3.0', releaseNotes: '0.4.0' }

    expect(downloadedVersion(info, 'darwin')).toBe('0.3.0')
    expect(downloadedVersion(info, 'win32')).toBe('0.4.0')
  })

  it('drops the v, so it reads beside AppState.version', () => {
    expect(downloadedVersion({ releaseName: 'v0.3.0' }, 'darwin')).toBe('0.3.0')
  })

  /** A menu entry offering to install "" is worse than one that just offers to install. */
  it('is null when the platform would not say which version', () => {
    expect(downloadedVersion({}, 'darwin')).toBeNull()
    expect(downloadedVersion({ releaseName: '  ' }, 'darwin')).toBeNull()
    expect(downloadedVersion({ releaseName: 'Autumn release' }, 'darwin')).toBeNull()
    expect(downloadedVersion({ releaseName: '0.3.0' }, 'win32')).toBeNull()
  })
})

describe('watchUpdates in development', () => {
  /**
   * Neither mechanism runs unpackaged, and this is the app's own decision rather than
   * `update-electron-app`'s — it makes the same one privately, which is no use to the
   * fallback that has to know whether it is being handled. See `watchUpdates`.
   */
  it('does nothing at all, on either kind of platform', async () => {
    app.isPackaged = false
    const on = deps()

    watch(on, { platform: 'darwin' })
    watch(on, { platform: 'linux' })
    await settle()

    expect(selfUpdaters).toHaveLength(0)
    expect(net.fetch).not.toHaveBeenCalled()
    expect(on.onAvailable).not.toHaveBeenCalled()
  })

  it('has a stop that is safe with nothing to stop', () => {
    app.isPackaged = false
    expect(() => watch(deps(), { platform: 'linux' }).stop()).not.toThrow()
  })
})

/** Start the watcher on `platform` and report what each mechanism did. */
async function started(platform: 'darwin' | 'win32'): Promise<{
  selfUpdaters: number
  polled: boolean
}> {
  selfUpdaters.length = 0
  net.fetch.mockClear()
  watch(deps(), { platform })
  await settle()
  return { selfUpdaters: selfUpdaters.length, polled: net.fetch.mock.calls.length > 0 }
}

describe('watchUpdates where Squirrel can do the work', () => {
  it('starts the self-updater on macOS and Windows, and polls nothing', async () => {
    app.isPackaged = true

    expect(await started('darwin')).toEqual({ selfUpdaters: 1, polled: false })
    expect(await started('win32')).toEqual({ selfUpdaters: 1, polled: false })
  })

  /**
   * Six hours rather than the package's ten-minute default. This app ships occasionally,
   * and the fallback branch shares the interval because it is sharing the reasoning.
   */
  it('checks slowly, and leaves notifyUser alone so the callback is consulted', () => {
    app.isPackaged = true
    watch(deps(), { platform: 'darwin' })

    const { options } = lastSelfUpdater()
    expect(options.updateInterval).toBe('6 hours')
    expect(options.notifyUser).toBeUndefined()
    expect(typeof options.onNotifyUser).toBe('function')
  })

  /**
   * The whole of part one's user-facing behaviour. The package's default here is a modal
   * dialog, and this app has no parent window to put one on — so the prompt is a tray
   * menu entry instead, which waits as long as the user likes.
   */
  it('routes a finished download to the tray rather than a dialog', async () => {
    app.isPackaged = true
    const on = deps()
    watch(on, { platform: 'darwin' })

    lastSelfUpdater().finishDownload({ releaseName: '0.5.0' })

    expect(on.onReady).toHaveBeenCalledWith('0.5.0')
    expect(on.onAvailable).not.toHaveBeenCalled()
  })

  it('takes the version from the notes on Windows, where the name is empty', () => {
    app.isPackaged = true
    const on = deps()
    watch(on, { platform: 'win32' })

    lastSelfUpdater().finishDownload({ releaseName: '', releaseNotes: '0.5.0' })

    expect(on.onReady).toHaveBeenCalledWith('0.5.0')
  })

  it('offers a restart even when the platform will not name the version', () => {
    app.isPackaged = true
    const on = deps()
    watch(on, { platform: 'darwin' })

    lastSelfUpdater().finishDownload({ releaseName: '' })

    expect(on.onReady).toHaveBeenCalledWith(null)
  })

  it('stops the self-updater and lets go of the error listener', () => {
    app.isPackaged = true
    const watcher = watch(deps(), { platform: 'darwin' })
    const updater = lastSelfUpdater()

    watcher.stop()

    expect(updater.stopped).toBe(true)
    expect(autoUpdater.listenerCount('error')).toBe(0)
  })
})

/**
 * The fallback, which is what makes the self-updating branch honest. An ad-hoc signed
 * build — every local one, since `forge.config.ts` signs that way with no certificate
 * present — downloads an update and is then refused by Squirrel.Mac because the
 * signature does not match the running app. None of that is visible from here by
 * inspection, so it is not inspected: Squirrel says so through `error`, and the release
 * check takes over.
 */
describe('watchUpdates when Squirrel turns out not to be able to', () => {
  it('falls back to telling the user, the first time Squirrel refuses', async () => {
    app.isPackaged = true
    serveRelease({ tag_name: 'v0.9.0' })
    const on = deps()
    watch(on, { platform: 'darwin' })
    await settle()
    expect(on.onAvailable).not.toHaveBeenCalled()

    autoUpdater.fail('Could not get code signature for running application')
    await settle()

    expect(on.onAvailable).toHaveBeenCalledWith('0.9.0')
  })

  it('takes over once, however many times Squirrel goes on failing', async () => {
    app.isPackaged = true
    serveRelease({ tag_name: 'v0.9.0' })
    watch(deps(), { platform: 'darwin' })

    autoUpdater.fail('first')
    autoUpdater.fail('second')
    autoUpdater.fail('third')
    await settle()

    expect(net.fetch).toHaveBeenCalledTimes(1)
  })

  /**
   * The package asserts its way through its options and reads `package.json` out of the
   * bundle to find the repository, so a bundle put together wrongly throws here. That is
   * still only a reason this install cannot update itself.
   */
  it('falls back when the self-updater refuses to start at all', async () => {
    app.isPackaged = true
    selfUpdateFailure.error = new Error('repo not found')
    serveRelease({ tag_name: 'v0.9.0' })
    const warn = quietly()
    const on = deps()

    watch(on, { platform: 'darwin' })
    await settle()

    expect(on.onAvailable).toHaveBeenCalledWith('0.9.0')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not start the self-updater'),
      'repo not found'
    )
    // No self-updater, so nothing for Squirrel's errors to be about.
    expect(autoUpdater.listenerCount('error')).toBe(0)
  })

  /**
   * `stop()` runs on the way out of the app. A release check it did not reach would go on
   * asking GitHub every interval from a process that is meant to be quitting.
   */
  describe('and then being told to stop', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      app.isPackaged = true
      serveRelease({ tag_name: 'v0.9.0' })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('stops the release check that took over from Squirrel', async () => {
      const watcher = watch(deps(), { platform: 'darwin', intervalMs: 1000 })
      autoUpdater.fail('Could not get code signature for running application')

      expect(await askedAfterStopping(watcher)).toBe(0)
    })

    it('stops the release check that took over from a self-updater that never started', async () => {
      quietly()
      selfUpdateFailure.error = new Error('repo not found')
      const watcher = watch(deps(), { platform: 'darwin', intervalMs: 1000 })

      expect(await askedAfterStopping(watcher)).toBe(0)
    })
  })
})

describe('watchUpdates where nothing can install anything', () => {
  it('tells the user about a newer release, without the tag’s v', async () => {
    app.isPackaged = true
    serveRelease({ tag_name: 'v0.2.0' })
    const on = deps()

    watch(on, { platform: 'linux' })
    await settle()

    expect(selfUpdaters).toHaveLength(0)
    expect(on.onAvailable).toHaveBeenCalledWith('0.2.0')
    expect(on.onReady).not.toHaveBeenCalled()
  })

  it('says nothing when the release is this one, or older', async () => {
    app.isPackaged = true
    app.version = '0.5.0'
    serveRelease({ tag_name: 'v0.5.0' })
    const on = deps()

    watch(on, { platform: 'linux' })
    await settle()
    expect(on.onAvailable).not.toHaveBeenCalled()

    serveRelease({ tag_name: 'v0.4.0' })
    watch(on, { platform: 'linux' })
    await settle()
    expect(on.onAvailable).not.toHaveBeenCalled()
  })

  it('says nothing when GitHub will not answer', async () => {
    app.isPackaged = true
    const warn = quietly()
    const on = deps()

    watch(on, { platform: 'linux' })
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('404'))
    expect(on.onAvailable).not.toHaveBeenCalled()
  })

  /**
   * Checked again on a timer, and a failed check is not retried sooner than the next
   * one: there is nothing time-critical here, and a tight retry against a rate limit is
   * how an app gets itself rate limited.
   */
  it('asks again on the interval', async () => {
    vi.useFakeTimers()
    try {
      app.isPackaged = true
      serveRelease({ tag_name: 'v0.2.0' })
      const on = deps()

      watch(on, { platform: 'linux', intervalMs: 1000 })
      await vi.advanceTimersByTimeAsync(2500)

      expect(net.fetch).toHaveBeenCalledTimes(3)
      expect(on.onAvailable).toHaveBeenCalledWith('0.2.0')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops asking once it is told to', async () => {
    vi.useFakeTimers()
    try {
      app.isPackaged = true
      serveRelease({ tag_name: 'v0.2.0' })

      const watcher = watch(deps(), { platform: 'linux', intervalMs: 1000 })
      await vi.advanceTimersByTimeAsync(1500)
      const before = net.fetch.mock.calls.length
      watcher.stop()
      await vi.advanceTimersByTimeAsync(5000)

      expect(net.fetch.mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  /** Checking for an update must never be the thing keeping the process alive. */
  it('does not hold the event loop open', async () => {
    app.isPackaged = true
    serveRelease({ tag_name: 'v0.1.0' })
    const interval = vi.spyOn(globalThis, 'setInterval')
    watch(deps(), { platform: 'linux' })

    const timer = interval.mock.results[0]?.value as { hasRef?: () => boolean }
    expect(timer.hasRef?.()).toBe(false)
    // Let the first check, which went out alongside the timer, finish inside this test.
    await settle()
  })
})

describe('restartToUpdate', () => {
  /**
   * `quitAndInstall` does not return in Electron: Squirrel replaces the bundle and
   * relaunches. Nothing is waiting to be written on the way out, because the model
   * persists on every change rather than at quit.
   */
  it('hands the process to Squirrel', () => {
    restartToUpdate()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
