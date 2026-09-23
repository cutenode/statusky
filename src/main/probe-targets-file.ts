import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, dialog } from 'electron'
import type { FileFilter } from 'electron'
import { effectiveProbeTargets } from '../shared/probe-targets'
import type { Model } from './model'
import type { PopoverWindow } from './window'

/** What `open` hands the popover. The same shape as `OpenedFile` in schemas/statusky.eipc. */
export interface OpenedFile {
  /** The file's name without its folder, for the panel to say which file it is showing. */
  name: string
  text: string
}

/** The name an export is offered under, in the user's Documents folder. */
export const EXPORT_NAME = 'statusky-probe-targets.json'

/**
 * The largest file `open` will read.
 *
 * A document at every limit in `PROBE_TARGET_LIMITS` is a few kilobytes, so a file
 * anywhere near this is not one — and reading it anyway would hold a large string in
 * two processes only to learn that from the validator.
 */
export const MAX_IMPORT_BYTES = 256 * 1024

const FILTERS: FileFilter[] = [{ name: 'JSON', extensions: ['json'] }]

export interface ProbeTargetsFileDeps {
  model: Model
  popover: PopoverWindow
}

/** The `ProbeTargetsFile` interface in schemas/statusky.eipc. */
export interface ProbeTargetsFile {
  /** Save the targets in force to a file the user picks: its name, or null if cancelled. */
  save(): Promise<string | null>
  /** Read a file the user picks, without parsing it, or null if cancelled. */
  open(): Promise<OpenedFile | null>
}

/**
 * What went wrong. Node's file system throws nothing but `Error`s, but a `catch` is handed
 * `unknown`, and a cast would turn anything else into "undefined" in front of the user.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Export and import the network checks' targets through the OS's own file dialogs.
 *
 * The page never names a path and never supplies what is written. `save` serialises
 * `effectiveProbeTargets` from the settings main already holds, which is exactly the
 * document an import would read back; `open` returns the chosen file's text for the
 * Settings panel to check field by field before anything is applied. Applying it is a
 * `Preferences.patch` like any other, so it is validated at that boundary too.
 *
 * The popover hides on blur, and a file dialog takes focus, so the popover is pinned for
 * as long as one is up — otherwise the panel waiting on the answer would vanish the
 * moment it asked. One dialog at a time: a second click while one is open is refused
 * rather than stacking another, which would also unpin the popover early.
 *
 * The dialogs are deliberately not attached to the popover. On macOS that would make
 * them sheets, and a save panel is wider than the popover it would hang from.
 */
export function probeTargetsFile({ model, popover }: ProbeTargetsFileDeps): ProbeTargetsFile {
  let open = false

  async function withDialog<T>(fn: () => Promise<T>): Promise<T> {
    if (open) throw new Error('A file dialog is already open.')
    open = true
    popover.setPinned(true)
    try {
      return await fn()
    } finally {
      open = false
      popover.setPinned(false)
    }
  }

  return {
    save: () =>
      withDialog(async () => {
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Export check targets',
          defaultPath: join(app.getPath('documents'), EXPORT_NAME),
          filters: FILTERS
        })
        if (canceled || !filePath) return null

        const name = basename(filePath)
        const targets = effectiveProbeTargets(model.settings.probeTargets)
        try {
          await writeFile(filePath, `${JSON.stringify(targets, null, 2)}\n`, 'utf8')
        } catch (error) {
          throw new Error(`Could not save ${name}: ${reason(error)}`, { cause: error })
        }
        return name
      }),

    open: () =>
      withDialog(async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Import check targets',
          properties: ['openFile'],
          filters: FILTERS
        })
        const [filePath] = filePaths
        if (canceled || !filePath) return null

        const name = basename(filePath)
        let text: string
        try {
          const { size } = await stat(filePath)
          if (size > MAX_IMPORT_BYTES) {
            throw new Error('it is far too large to be a list of check targets.')
          }
          text = await readFile(filePath, 'utf8')
        } catch (error) {
          throw new Error(`Could not read ${name}: ${reason(error)}`, { cause: error })
        }
        return { name, text }
      })
  }
}
