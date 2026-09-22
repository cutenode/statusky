import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import type { LoginItemStatus } from '../shared/types'

/**
 * Registering Statusky to come back at login, and finding out whether it worked.
 *
 * The whole of this module exists because `app.setLoginItemSettings` makes a promise on
 * two platforms out of three and says nothing on the third, and because on the first of
 * those two it can decline without raising anything at all. A status monitor that does
 * not come back after a reboot has failed at the one thing it is for, and it fails
 * silently — there is no moment at which the user finds out, because the app they would
 * have found out from is the one that did not start. So nothing here reports success
 * because a call returned: the native path reads the setting straight back out of the
 * OS, the Linux path writes a file whose failures are its own to report, and both are
 * asked again at the next launch by `readLoginItem`.
 */

/** The name the session's startup-apps list will show. Matches `PRODUCT_NAME` in forge.config.ts. */
const PRODUCT_NAME = 'Statusky'

const DESCRIPTION = 'A menu bar feed of AT Protocol infrastructure status updates.'

/**
 * The basename of the XDG autostart entry. Not `app.getName()`: that is the packaging
 * name, and renaming the package must not strand an old entry under the old name where
 * nothing will ever remove it.
 */
const AUTOSTART_FILE = 'statusky.desktop'

const UNPACKAGED_LINUX =
  'Statusky is running from a source checkout, so there is no installed command for ' +
  'the desktop session to run at login. A packaged build — the AppImage or the .deb — ' +
  'registers this properly.'

/**
 * The same refusal on macOS and Windows, which needed saying out loud rather than being
 * left to `setLoginItemSettings`.
 *
 * `app.setLoginItemSettings` registers the *running bundle*, and in a source checkout
 * that bundle is `node_modules/electron/dist/Electron.app` — Electron's own, carrying
 * Electron's own name. macOS takes it: the call returns, the read-back agrees, and the
 * user is shown a system notification saying "Electron will open automatically when you
 * log in", with an entry to match in Login Items. Nothing about that entry is Statusky.
 * It is named after the wrong app, it points inside a directory `npm install` may
 * replace, and at the next login it starts bare Electron — which, with no app to load,
 * is a window showing Electron's own welcome page and no menu bar icon at all.
 *
 * So this is the darwin and win32 half of what `execCommand` already declines to guess
 * at on Linux, and it makes the claim in the README's "What does not work where" — that
 * launch at login needs a packaged build on every platform — true on every platform.
 */
const UNPACKAGED_NATIVE =
  'Statusky is running from a source checkout, so the app the OS would register is ' +
  'Electron itself rather than Statusky — it would carry Electron’s name and start ' +
  'Electron, not this app, at login. A packaged build registers properly.'

/**
 * `~/.config/autostart`, or wherever `$XDG_CONFIG_HOME` points.
 *
 * The XDG base directory specification is explicit that a relative `$XDG_CONFIG_HOME`
 * must be ignored and an empty one treated as unset, and both are worth honouring here
 * rather than passing through: a relative value would put the autostart entry somewhere
 * relative to whatever directory the session happened to launch us from, which is a file
 * nobody will ever find again and a login item that never runs.
 */
function autostartDir(): string {
  const configured = process.env.XDG_CONFIG_HOME
  const base = configured && isAbsolute(configured) ? configured : join(homedir(), '.config')
  return join(base, 'autostart')
}

function autostartPath(): string {
  return join(autostartDir(), AUTOSTART_FILE)
}

/**
 * The command the desktop session should run at login, or null when this build cannot
 * honestly name one.
 *
 * This is the part most likely to be wrong, because "where am I" has a different answer
 * for every way a Linux app is shipped, and a wrong answer here is an autostart entry
 * that exists, looks registered, and launches nothing.
 *
 * Handled: an AppImage, through `APPIMAGE`; and any packaged install — the .deb, or an
 * unpacked zip run from wherever the user put it — through `process.execPath`, which is
 * absolute and so does not depend on the session's `PATH` the way the `Exec=statusky`
 * that `build/desktop.ejs` writes into the .deb's own menu entry does. Those are the two
 * Linux artefacts forge.config.ts actually builds.
 *
 * Not handled, deliberately: an unpackaged development run, which returns null and is
 * reported to the user rather than guessed at — `process.execPath` is Electron's own
 * binary there, and an entry pointing at a node_modules directory would be wrong the
 * moment the checkout moved. Also not handled, because Statusky does not ship as either:
 * Flatpak and Snap, whose `execPath` is a path inside the sandbox that means nothing to
 * the session outside it; those need `flatpak run <id>` or the snap's own wrapper.
 *
 * And one case nothing can handle: an AppImage the user moves or renames afterwards.
 * The path is baked in at the moment the toggle is switched on, so the entry then points
 * at a file that is not there. There is no notification for this — the app is not running
 * to give one — but `readLoginItem` still reports the entry as present, which is true.
 */
function execCommand(): string | null {
  // An AppImage mounts itself and runs from that mount, so `process.execPath` inside one
  // points into a temporary directory that is gone by the next login. `APPIMAGE` is the
  // path to the file the user actually launched, which is the only durable thing here.
  const appImage = process.env.APPIMAGE
  if (appImage) return appImage
  if (app.isPackaged) return process.execPath
  return null
}

/**
 * Quote a path for an `Exec=` value.
 *
 * Two layers of escaping stack up here, and getting either wrong launches the wrong
 * thing or nothing. The Desktop Entry specification wants an argument wrapped in double
 * quotes, with `"`, backtick, `$` and backslash escaped by a backslash inside them — and
 * then, because `Exec` is a string-typed key, every backslash that survives that has to
 * be doubled again for the file format itself, which does its own unescaping first.
 *
 * Quoting unconditionally rather than only when the path contains a space: a bare path
 * is still valid inside quotes, and a conditional is one more thing to be wrong about a
 * user who keeps their AppImage in `~/My Applications/`.
 */
function quoteExec(path: string): string {
  const escaped = path.replace(/(["`$\\])/g, '\\$1')
  return `"${escaped.replace(/\\/g, '\\\\')}"`
}

/**
 * The autostart entry itself.
 *
 * No `%U` or any other field code, unlike the .deb's menu entry: nothing passes this app
 * a file or a URL at login, and a field code that is never substituted is just one more
 * thing a session's parser can disagree about.
 *
 * `StartupNotify=false` for the same reason `build/desktop.ejs` says so — Statusky has no
 * window to raise, so the startup notification protocol's bouncing cursor never resolves
 * into anything and the shell spends several seconds pretending the app is starting.
 * `X-GNOME-Autostart-enabled` is what GNOME's own startup-applications UI writes when a
 * user disables an entry there rather than deleting it, so saying it explicitly means a
 * re-enable from this app is a re-enable and not a file that exists but is switched off.
 */
function desktopEntry(command: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${PRODUCT_NAME}`,
    `Comment=${DESCRIPTION}`,
    `Exec=${quoteExec(command)}`,
    'Icon=statusky',
    'Terminal=false',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Turn a refused login item into something a person can act on.
 *
 * Modelled on `explainFailure` in src/main/notifications.ts, and for the same reason: the
 * OS's own account of why it said no is either an opaque error or — on macOS, which is
 * the interesting case — nothing whatsoever. macOS 13 moved `setLoginItemSettings` onto
 * `SMAppService`, which registers a *bundle* rather than a path and refuses one that is
 * not properly code signed or is not in the Applications folder. It refuses quietly: the
 * call returns, nothing throws, and only reading the setting back afterwards reveals that
 * nothing was registered. "Could not update the login item" would leave the user with a
 * toggle that is on and an app that will not be there after a reboot, which is exactly
 * the lie this is all here to stop telling.
 */
export function explainLoginItemFailure(
  openAtLogin: boolean,
  raw: string | null,
  platform: string = process.platform
): string {
  const verb = openAtLogin ? 'open Statusky at login' : 'stop opening Statusky at login'

  if (platform === 'darwin') {
    return (
      `macOS would not ${verb}. Since macOS 13 this goes through SMAppService, which ` +
      'refuses an app that is not in the Applications folder or is not properly code ' +
      'signed — moving Statusky to Applications and switching this back on is what ' +
      'usually fixes it.'
    )
  }

  return raw ? `The system would not ${verb}: ${raw}` : `The system would not ${verb}.`
}

/** The OS said no, in whatever way it says it. `registered` is the state we are left in. */
function refused(openAtLogin: boolean, raw: string | null): LoginItemStatus {
  return { registered: !openAtLogin, error: explainLoginItemFailure(openAtLogin, raw) }
}

/**
 * The darwin and win32 path, which is the one `app.setLoginItemSettings` documents.
 *
 * The write is not the answer, and that is the whole of item 4: on macOS 13 and later it
 * can return having registered nothing at all. Reading it straight back is the only way
 * to find out, and it costs one call.
 */
function applyNativeLoginItem(openAtLogin: boolean): LoginItemStatus {
  // Only the registering half is refused. Switching it *off* still goes through to the
  // OS, because a development build from before this check may have left an entry
  // behind under Electron's name, and this is the only thing that can take it away.
  if (openAtLogin && !app.isPackaged) return { registered: false, error: UNPACKAGED_NATIVE }

  try {
    app.setLoginItemSettings({ openAtLogin })
  } catch (error) {
    // An unbundled development binary is not a registerable app, and says so loudly.
    return refused(openAtLogin, message(error))
  }

  let registered: boolean
  try {
    registered = app.getLoginItemSettings().openAtLogin
  } catch (error) {
    return refused(openAtLogin, message(error))
  }

  if (registered === openAtLogin) return { registered, error: null }
  return refused(openAtLogin, null)
}

/**
 * The Linux path: an XDG autostart entry, because `app.setLoginItemSettings` is
 * documented `@platform darwin,win32` and on Linux does nothing at all. The `try/catch`
 * around it therefore never fires, which is why the Settings toggle has until now
 * reported success for something that was never going to happen.
 */
function applyXdgAutostart(openAtLogin: boolean): LoginItemStatus {
  const file = autostartPath()

  if (!openAtLogin) {
    try {
      // `force` so an entry that is already gone — removed by hand, or by GNOME's own
      // startup-applications UI — is not an error on the way to the state we want.
      rmSync(file, { force: true })
    } catch (error) {
      return refused(openAtLogin, message(error))
    }
    return { registered: false, error: null }
  }

  const command = execCommand()
  if (!command) return { registered: false, error: UNPACKAGED_LINUX }

  try {
    mkdirSync(autostartDir(), { recursive: true })
    writeFileSync(file, desktopEntry(command), 'utf8')
  } catch (error) {
    return refused(openAtLogin, message(error))
  }

  // No read-back here, unlike the native path, and the asymmetry is the point: macOS
  // needs one because SMAppService returns success having registered nothing, whereas a
  // filesystem reports its own failures — a full disk, a read-only home, a directory
  // that is really a file all throw above rather than quietly doing nothing. The
  // equivalent question does still get asked, once per launch, by `readLoginItem`,
  // which is where a registration that has drifted since is noticed.
  return { registered: true, error: null }
}

/**
 * Ask the OS to open Statusky at login, or to stop, and report what it actually did.
 *
 * Branches on `process.platform` rather than on a capability check so that the branch is
 * reachable from a test on any host — the alternative is code that can only be exercised
 * on the platform it is for, which for three of this app's four platforms means never.
 */
export function applyLoginItem(openAtLogin: boolean): LoginItemStatus {
  if (process.platform === 'linux') return applyXdgAutostart(openAtLogin)
  return applyNativeLoginItem(openAtLogin)
}

/**
 * What the OS says right now, without writing anything.
 *
 * Asked once at startup, so that a registration which has drifted from the setting —
 * an autostart entry deleted by hand, a macOS login item lost to a re-signing — is
 * noticed and re-applied on the next change rather than assumed to be fine.
 */
export function readLoginItem(): boolean {
  if (process.platform === 'linux') return existsSync(autostartPath())
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    // An OS that will not even answer the question has certainly not registered us.
    return false
  }
}
