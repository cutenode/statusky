import { spawn } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { removeProtocolClient } from './deep-link'

/**
 * The four times Squirrel.Windows runs the application to tell it about itself.
 *
 * Squirrel has no installer UI and no install scripts: it copies the new version into
 * place and then *launches the application* with one of these switches, expecting it to
 * do whatever setting up it needs and exit immediately. An app that ignores them starts
 * its tray icon four times during an install and leaves no Start Menu shortcut behind.
 */
const INSTALL = '--squirrel-install'
const UPDATED = '--squirrel-updated'
const UNINSTALL = '--squirrel-uninstall'
const OBSOLETE = '--squirrel-obsolete'

/**
 * Where the shortcuts go, and where they deliberately do not.
 *
 * Squirrel's own default is `StartMenu,Desktop`. The electron-builder NSIS config this
 * app used to ship said `createDesktopShortcut: false`, and Squirrel cannot be told that
 * through any configuration Forge exposes — `MakerSquirrel` has no shortcut options at
 * all — so this handler is the only place that preference can survive the move. A menu
 * bar app that puts an icon on the desktop has misunderstood what it is.
 *
 * The Start Menu shortcut is not merely tidiness. Windows refuses to show a toast from
 * an application that has no Start Menu shortcut carrying its AppUserModelID, so this
 * line is the prerequisite for every notification the app will ever raise there —
 * including the collapsing ones in src/main/notifications.ts. `app.setAppUserModelId`
 * in src/main/index.ts is the other half of that pair.
 */
const SHORTCUT_LOCATIONS = 'StartMenu'

/**
 * Deal with a Squirrel lifecycle launch, and say whether this was one.
 *
 * Returns true when the process was started only to be told about an install, an update
 * or an uninstall — in which case the caller must quit without starting anything else.
 * Returns false for an ordinary launch, which is every launch a user is responsible for.
 *
 * Hand-rolled rather than taken from `electron-squirrel-startup`, which is two years
 * stale, CommonJS in an ESM package, and pulls in `debug@^2` from 2016 to log one line.
 * What it does is the twenty lines below.
 *
 * Nothing here is reachable from a Mac. The switches only ever come from Squirrel's
 * installer on Windows, and `Update.exe` only exists in a Squirrel installation, so the
 * tests drive it with an argument vector and a pinned `process.platform` and stop at
 * the point where a real Windows machine would take over.
 */
export function handleSquirrelEvent(argv: readonly string[] = process.argv): boolean {
  if (process.platform !== 'win32') return false

  const event = argv[1]
  if (event !== INSTALL && event !== UPDATED && event !== UNINSTALL && event !== OBSOLETE) {
    return false
  }

  // `Update.exe` is Squirrel's stub, one directory above the versioned `app-<version>`
  // folder this executable is running from. It is the only thing that can write the
  // shortcuts, because it is the thing that knows the install layout.
  const updateExe = resolve(dirname(process.execPath), '..', 'Update.exe')
  const target = basename(process.execPath)

  switch (event) {
    case INSTALL:
    case UPDATED:
      // An update rewrites the shortcut as well as an install creating it: the shortcut
      // points into the versioned directory, which this update has just replaced.
      runUpdate(updateExe, [
        `--createShortcut=${target}`,
        `--shortcut-locations=${SHORTCUT_LOCATIONS}`
      ])
      break

    case UNINSTALL:
      runUpdate(updateExe, [
        `--removeShortcut=${target}`,
        `--shortcut-locations=${SHORTCUT_LOCATIONS}`
      ])
      // The `statusky://` registry entry is written by the running app on every launch
      // rather than by the installer (see `registerProtocolClient`), so the uninstaller
      // is the only place that can take it away again. Left behind, it would point the
      // whole machine's `statusky://` handler at a deleted executable.
      removeProtocolClient()
      break

    default:
      // `--squirrel-obsolete`: this version is about to be deleted because a newer one
      // has taken over. There is nothing to undo — the new version's own `--updated`
      // has already rewritten everything that is shared — so this exists purely to
      // stop the app booting.
      break
  }

  return true
}

/**
 * Start `Update.exe` and let it outlive us.
 *
 * Detached and unreferenced, because Squirrel waits for *this* process to exit before
 * it carries on: staying alive to watch the child would deadlock the install. The
 * alternative some apps use — quitting after a fixed timeout and hoping — is the same
 * race with a sleep in front of it.
 *
 * A failure to spawn is swallowed deliberately. The app is quitting either way, there
 * is no window to report into, and the failure modes are an install that ends up
 * without a Start Menu shortcut or an uninstall that leaves one: both are bad, and
 * neither is improved by a process that refuses to exit during an installer.
 */
function runUpdate(updateExe: string, args: string[]): void {
  try {
    spawn(updateExe, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (error) {
    console.error('Squirrel: could not run', updateExe, args, error)
  }
}
