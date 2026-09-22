import { app, autoUpdater, net } from 'electron'
import { updateElectronApp } from 'update-electron-app'
import { LATEST_RELEASE_API, RELEASE_REPO } from '../shared/defaults'
import type { Platform } from '../shared/types'

/**
 * Keeping Statusky up to date, in the two different ways the four platforms allow.
 *
 * A menu bar app with no window and no dock icon, whose entire design goal is to be
 * forgotten about until something breaks, is the worst imaginable candidate for updates
 * a user is expected to go and fetch. Nobody opens it. Nobody has a reason to look at
 * what version it is. And because it is the app whose job is telling you the network
 * broke, a stale build is not merely old: the catalogue of services it measures, the
 * requests it measures them with and the status accounts it watches all move, so an
 * install left behind long enough stops being able to answer the question it exists to
 * answer. That is a correctness problem wearing a staleness problem's clothes.
 *
 * There are two mechanisms here and **exactly one of them is ever running**:
 *
 * 1. **Real self-update**, on macOS and Windows, through `update-electron-app` against
 *    `update.electronjs.org`, which serves a Squirrel feed straight from a public
 *    repository's GitHub releases. It downloads in the background and asks for a
 *    restart when it is done.
 * 2. **A notice and nothing more**, everywhere else — which in practice means Linux,
 *    plus any macOS or Windows install where the first mechanism cannot work. It asks
 *    GitHub what the newest release is, compares it with this build, and tells the user
 *    to go and download it. It installs nothing.
 *
 * The second is the fallback for the first rather than a separate feature, and the
 * switch between them is not a guess about whether this build is signed or installed
 * properly: it is Squirrel saying so. See `watchUpdates`.
 */

/**
 * The platforms `update-electron-app` will do anything at all on.
 *
 * Spelled out here rather than left to the package because this file has to know the
 * same answer the package does. It hard-codes `supportedPlatforms = ['darwin', 'win32']`
 * and silently no-ops elsewhere — Electron's `autoUpdater` is a wrapper around
 * Squirrel.Mac and Squirrel.Windows and there is no third implementation — so on Linux
 * a call would log one line and return, leaving nobody updated and nobody told. Which of
 * the two mechanisms runs is a decision this module makes, so it needs the list.
 */
const SELF_UPDATING_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'win32'])

/**
 * How long between checks, for both mechanisms.
 *
 * Six hours is slow on purpose and the reason is mostly the fallback's: unauthenticated
 * GitHub API calls are capped at 60 an hour for the whole IP address, shared with every
 * other thing on that address, and an app that runs from login to logout would be a rude
 * neighbour on a shared connection. Four requests a day is not. The self-updating branch
 * is under no such limit — `update.electronjs.org` is Electron's own service and expects
 * to be polled — but it takes the same interval because the honest reason is the same in
 * both cases: this app ships occasionally, and checking more often than it ships only
 * finds out the same thing more times.
 *
 * `update-electron-app` also refuses anything under five minutes, which this is well
 * clear of.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const CHECK_INTERVAL_TEXT = '6 hours'

/**
 * How long one release check may take before it is abandoned.
 *
 * The same ceiling, and the same reasoning, as `FETCH_TIMEOUT_MS` in src/main/model.ts:
 * a request with no ceiling is not slow, it is *outstanding*, and a new check is started
 * every interval whether or not the last one ever came back. Without this they would
 * accumulate, each holding a socket and a promise, for as long as the app runs.
 *
 * Fifteen seconds is far longer than this call has any business taking — GitHub answers
 * it in well under a second — so anything that reaches the ceiling has gone wrong rather
 * than gone slowly, and the right answer to that is the same as every other failure
 * here: say nothing, and ask again in six hours.
 */
const CHECK_TIMEOUT_MS = 15_000

/** What this module can tell the rest of the app. */
export interface UpdateDeps {
  /**
   * A newer release exists and nothing here can install it. The user has to fetch it,
   * and `version` is what they are fetching.
   */
  onAvailable(version: string): void
  /**
   * An update has been downloaded and applies on the next launch. `version` is null on a
   * platform that would not say which one; see `downloadedVersion`.
   */
  onReady(version: string | null): void
}

export interface UpdateOptions {
  /**
   * Which platform to behave as. Defaults to this one, and is named by a test so that
   * all four branches are reachable from any host — the same reasoning as
   * `explainLoginItemFailure` in src/main/login-item.ts. Three of this app's four
   * platforms are otherwise never exercised anywhere.
   */
  platform?: Platform
  /** How long between release checks. Only a test has any business changing this. */
  intervalMs?: number
}

export interface UpdateWatcher {
  /** Stop every check this started. Safe to call more than once, and before any ran. */
  stop(): void
}

/** Nothing is being checked, and `stop()` has nothing to undo. */
const IDLE: UpdateWatcher = { stop: () => {} }

/**
 * Whether `tag` names a release newer than the version this build reports.
 *
 * A few lines rather than a semver dependency, per instruction — and the point of the
 * lines is to be honest about their own reach. What they handle is what GitHub tags
 * actually do here: an optional `v` prefix, a dotted run of numbers, and an optional
 * pre-release suffix after a hyphen. Numbers are compared as numbers, so `0.10.0` is
 * correctly newer than `0.9.0` rather than alphabetically older; a missing component
 * counts as zero, so `v1` and `1.0.0` are the same release.
 *
 * What they do not handle, in full:
 *
 * - **Build metadata.** A `+sha` suffix makes the whole tag unreadable here rather than
 *   being stripped the way the specification says. Nothing publishes one.
 * - **Ordering two pre-releases.** `1.0.0-rc.2` against `1.0.0-rc.10` is compared as
 *   plain text, so it comes out backwards. Statusky has never published a pre-release,
 *   and the cost if it ever does is one person not being offered one release candidate.
 * - **Anything that does not start with numbers.** A tag like `latest`, or a name
 *   somebody typed, returns false. A tag that *does* start with a dotted run of digits
 *   is read as a version even when it was not meant as one — `2026-01-release` parses as
 *   release 2026 with a suffix — which is wrong in principle and lands on the right
 *   answer in practice, because such a scheme still orders correctly against itself.
 *
 * That last one is the important default and is why every failure here is `false` rather
 * than an error: a wrong "you are out of date" sends somebody to a download page to look
 * for a build that does not exist, which is worse than saying nothing. The one semver
 * rule that *is* honoured is that a suffixed version precedes the plain one — `1.0.0` is
 * newer than `1.0.0-rc1` — because that is how a real release supersedes the build that
 * led up to it.
 */
export function isNewerRelease(tag: string, running: string): boolean {
  const latest = parseVersion(tag)
  const current = parseVersion(running)
  if (!latest || !current) return false

  const width = Math.max(latest.release.length, current.release.length)
  for (let index = 0; index < width; index++) {
    const a = latest.release[index] ?? 0
    const b = current.release[index] ?? 0
    if (a !== b) return a > b
  }

  // Same numbers, so only the pre-release suffix is left to separate them.
  if (latest.pre === current.pre) return false
  if (!latest.pre) return true
  if (!current.pre) return false
  return latest.pre > current.pre
}

/** A version split into the numbers that order it and the suffix that follows them. */
function parseVersion(raw: string): { release: number[]; pre: string } | null {
  // The hyphen is split on only once conceptually: everything after the first one is the
  // pre-release, because `1.0.0-rc-1` is one suffix and not two.
  const [core = '', ...rest] = raw.trim().replace(/^v/i, '').split('-')
  const parts = core.split('.')
  if (!parts.length || parts.some((part) => !/^\d+$/.test(part))) return null
  return { release: parts.map(Number), pre: rest.join('-') }
}

/**
 * Ask GitHub what the newest published release is, or return null and say nothing.
 *
 * `net.fetch` rather than Node's `fetch`, for the reason already written against
 * `chromiumTransport` in src/main/index.ts: it goes out through Chromium's network
 * stack, so it takes the system proxy and the system certificate store with it. On a
 * corporate laptop that is the difference between a request that works and one that
 * fails for reasons nobody will ever debug, because nobody will ever see it fail.
 *
 * Every way this can go wrong ends the same way — null, one line in the log, and the app
 * carrying on saying nothing. A rate-limited response (`403` or `429` once the hour's 60
 * calls are gone), a repository with no releases yet (`404`, which is the ordinary answer
 * for this app today), a body that is not JSON, a `tag_name` that is missing or is not a
 * string, a connection that never completes: none of them are evidence about what version
 * is current, and reporting a state we do not know is the one thing worth avoiding here.
 */
export async function latestReleaseTag(): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)

  try {
    const response = await net.fetch(LATEST_RELEASE_API, {
      signal: controller.signal,
      // As every check in src/main/probes.ts sends, and for a second reason besides
      // theirs. This call is unauthenticated — a cookie could only make GitHub's answer
      // less predictable, never more — and a request that wants one waits on Chromium's
      // cookie store, which on macOS is a thing that can fail to open. The cookie
      // encryption fuse in forge.config.ts is the note on what that looked like: with it
      // on, this request never resolved at all and the update check ended at its own
      // timeout, while the probes went through untouched.
      credentials: 'omit',
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub asks every client to identify itself and answers `403` to some that do
        // not. Chromium would send its own, which would be a small lie about who is
        // calling.
        'User-Agent': `Statusky/${app.getVersion()} (+https://github.com/${RELEASE_REPO})`
      }
    })

    if (!response.ok) {
      console.warn(`GitHub would not say what the latest release is (${response.status}).`)
      return null
    }

    // Inside the timeout as well as the request: the body is read over the same
    // connection, so a response whose headers arrived and whose body never does is the
    // same kind of stall and deserves the same ceiling.
    const body: unknown = await response.json()
    const tag = (body as { tag_name?: unknown } | null)?.tag_name
    if (typeof tag !== 'string' || !tag) {
      console.warn('The latest release from GitHub carries no usable tag name.')
      return null
    }
    return tag
  } catch (error) {
    console.warn('Could not ask GitHub for the latest release:', describe(error))
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * The version a downloaded update will install, as well as it can be known.
 *
 * `update-electron-app` passes Squirrel's own `update-downloaded` arguments straight
 * through, and the two platforms fill them in differently: Squirrel.Mac puts the
 * release's name in `releaseName`, while Squirrel.Windows leaves that empty and puts the
 * version in `releaseNotes`. The package's own `makeUserNotifier` branches on exactly
 * this, which is the only documentation of it there is.
 *
 * Either can still arrive empty, and a menu entry offering to install "" is worse than
 * one that simply offers to install, so anything that does not parse as a version at all
 * becomes null and the menu says less. `parseVersion` is reused rather than a looser test
 * written, so "looks like a version" means one thing in this file.
 */
export function downloadedVersion(
  info: { releaseName?: string; releaseNotes?: string },
  platform: string
): string | null {
  const raw = (platform === 'win32' ? info.releaseNotes : info.releaseName)?.trim() ?? ''
  return parseVersion(raw) ? raw.replace(/^v/i, '') : null
}

/**
 * Restart into an update that has already been downloaded.
 *
 * Called from the tray menu entry `stage: 'ready'` puts there. `quitAndInstall` does not
 * return: Squirrel replaces the bundle and relaunches, so nothing after it runs, and in
 * particular the app's own teardown does not get a turn. That is fine here and worth
 * saying, because it is the reason this is not routed through `quit()` in
 * src/main/index.ts — the model persists on every change rather than on the way out, so
 * there is nothing waiting to be written.
 */
export function restartToUpdate(): void {
  autoUpdater.quitAndInstall()
}

/**
 * Start keeping this install up to date, whichever way this install can be.
 *
 * **The `app.isPackaged` guard is deliberate and is not the one `update-electron-app`
 * already does.** The package checks it too, and logs that it is aborting in development
 * rather than doing anything rash, so calling it unconditionally would be safe. It is
 * still the wrong shape here, because that check is *private to the package*: this module
 * has a second mechanism to run when the first one is not running, and it cannot tell
 * whether the first one is running by asking. Deciding it here, once, is what keeps the
 * two mutually exclusive — the alternative is either both of them going off in
 * development or neither of them going off at all, depending which way the guard is
 * guessed. The same reasoning covers `SELF_UPDATING_PLATFORMS`.
 *
 * **Self-update only works on a properly signed build, and that is not a formality.**
 * Squirrel.Mac refuses to apply an update whose code signature does not match the running
 * application's, so an ad-hoc signed local build — which is what `forge.config.ts`
 * produces with no certificate present, and what every developer on this repository is
 * running — can download an update and then decline to install it, every time, forever.
 * A zip run from wherever it was unpacked and a Windows install that never went through
 * Squirrel fail in their own ways for their own reasons. All of those are real
 * configurations somebody is sitting in front of, and none of them is distinguishable
 * from here by inspection. So they are not inspected: the self-updater is started, and
 * the first time it reports an error the release check takes over and starts telling the
 * user what it cannot do for them. That also covers the ordinary case of the feed being
 * unreachable or the repository having no releases yet, which costs nothing, because the
 * fallback's failure mode is silence.
 */
export function watchUpdates(deps: UpdateDeps, options: UpdateOptions = {}): UpdateWatcher {
  const platform = options.platform ?? (process.platform as Platform)
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS

  // Nothing to update: a checkout runs from source, and `release/` is rebuilt by the
  // build rather than replaced by a download.
  if (!app.isPackaged) return IDLE

  if (!SELF_UPDATING_PLATFORMS.has(platform)) return pollForReleases(deps, intervalMs)

  let fallback: UpdateWatcher | null = null
  /** Hand over to the release check, once, whatever finally convinces us to. */
  const giveUp = (): void => {
    fallback ??= pollForReleases(deps, intervalMs)
  }

  // Alongside the package's own error listener rather than instead of it: it logs, this
  // decides. Squirrel reports a signature mismatch, a missing `Update.exe` and an
  // unreachable feed all through this one event, and the app's answer to every one of
  // them is the same — stop promising to do it for them and start saying so.
  autoUpdater.on('error', giveUp)

  let updater: { stopUpdates(): void }
  try {
    updater = updateElectronApp({
      // The repository is `package.json`'s `repository` field, read by the package
      // itself; `RELEASE_REPO` in src/shared/defaults.ts is the comment that keeps the
      // two in step, along with the GitHub publisher in forge.config.ts.
      updateInterval: CHECK_INTERVAL_TEXT,
      /**
       * `notifyUser` is left at its default of true, which is the only setting under
       * which this callback is consulted at all — the package skips the whole
       * `update-downloaded` listener when it is false, so turning it off would mean
       * never being told the download had finished.
       *
       * What must not happen is the *default* of that flag, which is a modal dialog
       * from `makeUserNotifier`. This app has no parent window to put one on: the
       * popover is a frameless panel that hides the moment it loses focus, so a message
       * box here runs application-modal over whatever the user is actually doing, to
       * say something that could not be less urgent. src/main/index.ts already reasons
       * about exactly this problem around the wiring-mismatch dialog, and that one is
       * shown because the app is broken. This one would be shown because it is fine.
       *
       * So the prompt goes to the menu bar instead, where the rest of this app's verbs
       * live: `stage: 'ready'` puts a restart entry in the tray menu, and it waits there
       * as long as the user likes. See `TrayController.buildMenu`.
       */
      onNotifyUser: (info) => deps.onReady(downloadedVersion(info, platform))
    })
  } catch (error) {
    // `updateElectronApp` validates its options by assertion and reads `package.json`
    // out of the app bundle to find the repository, so a bundle assembled wrongly throws
    // here rather than failing later. That is still only a reason this install cannot
    // update itself, which is a thing the fallback exists to say.
    console.warn('Could not start the self-updater:', describe(error))
    giveUp()
    return { stop: () => fallback?.stop() }
  }

  return {
    stop(): void {
      autoUpdater.removeListener('error', giveUp)
      updater.stopUpdates()
      fallback?.stop()
    }
  }
}

/**
 * Ask GitHub for the newest release now, and again every `intervalMs`.
 *
 * The first check is immediate rather than delayed by a full interval: somebody who has
 * just launched a six-month-old build should not have to leave it running until the
 * afternoon to find that out. A check that fails is not retried sooner than the next one
 * — there is nothing time-critical here, and a tighter retry loop against a rate limit is
 * how an app gets itself rate limited.
 *
 * The timer is `unref`'d for the same reason the model's are: an update check has no
 * business being the thing keeping the process alive.
 */
function pollForReleases(deps: UpdateDeps, intervalMs: number): UpdateWatcher {
  const check = async (): Promise<void> => {
    const tag = await latestReleaseTag()
    if (!tag) return
    const running = app.getVersion()
    if (!isNewerRelease(tag, running)) return
    // Without the `v` a Git tag usually carries: everywhere this is shown, it is shown
    // beside `AppState.version`, which is `package.json`'s and has never had one.
    deps.onAvailable(tag.replace(/^v/i, ''))
  }

  void check()
  const timer = setInterval(() => void check(), intervalMs)
  timer.unref?.()

  return {
    stop(): void {
      clearInterval(timer)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
