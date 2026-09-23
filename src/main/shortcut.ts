import { globalShortcut } from 'electron'
import { formatAccelerator } from '../shared/defaults'
import type { ShortcutStatus } from '../shared/types'

/**
 * Claim `accelerator` from the whole machine, and report what really happened.
 *
 * A global shortcut is first-come-first-served: `globalShortcut.register` answers false
 * when another running application already owns the combination, and that is the only
 * notice anybody gets. There is no error, no event, and nothing to see — the key simply
 * belongs to somebody else, and pressing it does whatever that application does. An app
 * that ignored the return value would leave a settings panel saying a shortcut is on and
 * a user concluding the feature is broken, which is exactly the failure
 * `LoginItemStatus` exists to prevent for the login item. So the answer is read back and
 * handed to the model, the same way, and the Settings panel says so underneath the
 * control.
 *
 * An empty accelerator is the off position and not a failure: whatever was held is given
 * back and the status says, truthfully, that nothing is registered and nothing is wrong.
 *
 * `unregisterAll` rather than unregistering the previous accelerator by name: this app
 * registers exactly one shortcut, so "everything we hold" and "the last one we asked
 * for" are the same set, and asking the OS to drop the lot cannot leave a stale
 * registration behind if the two ever disagree.
 *
 * The throw is caught because `register` validates the accelerator string as well as
 * claiming it, and a combination the platform cannot express raises rather than
 * returning false. The combinations offered in `GLOBAL_SHORTCUT_CHOICES` are all valid,
 * so this is the path for a setting restored from a config file somebody has edited.
 */
export function applyGlobalShortcut(accelerator: string, summon: () => void): ShortcutStatus {
  globalShortcut.unregisterAll()
  if (!accelerator) return { registered: false, error: null }

  const shown = formatAccelerator(accelerator, process.platform)

  try {
    if (globalShortcut.register(accelerator, summon)) return { registered: true, error: null }
  } catch (error) {
    return {
      registered: false,
      error: `${shown} is not a shortcut this system accepts (${describe(error)}).`
    }
  }

  return {
    registered: false,
    error:
      `Another application already owns ${shown}, so Statusky will never be sent it. ` +
      'Pick a different combination, or quit whatever is holding this one.'
  }
}

/**
 * Give back whatever is held. Called from `will-quit`, which is the one event guaranteed
 * to run before the process goes: a global shortcut outlives the window it summons, and
 * on some platforms a registration that is never released keeps the combination dead for
 * other applications until the session ends.
 */
export function releaseGlobalShortcut(): void {
  globalShortcut.unregisterAll()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
