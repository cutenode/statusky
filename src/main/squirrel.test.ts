import { basename, dirname, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { app } from '../test/electron'
import { withPlatform } from '../test/harness'
import { handleSquirrelEvent } from './squirrel'

/**
 * Squirrel's `Update.exe` exists only inside a Windows installation, so the one thing
 * these tests cannot do is let it run. Everything up to the spawn is real.
 *
 * None of this is reachable from the Mac it was written on: the switches come from
 * Squirrel's installer, and `process.platform` is the only way to stand where it stands.
 * What is proven here is the argument vector and the order of events, which is what
 * would actually be wrong in a Windows installation — not that Windows honours them.
 */
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() }))
}))

const { spawn } = await import('node:child_process')
const spawned = spawn as unknown as Mock

const UPDATE_EXE = resolve(dirname(process.execPath), '..', 'Update.exe')
const TARGET = basename(process.execPath)

function run(event: string): Promise<boolean> {
  return withPlatform('win32', () => handleSquirrelEvent(['Statusky.exe', event]))
}

// The module mock outlives each test, and `resetElectron` knows nothing about it.
beforeEach(() => {
  spawned.mockClear()
})

describe('handleSquirrelEvent', () => {
  it('does nothing at all away from Windows', async () => {
    const argv = ['Statusky', '--squirrel-install']

    // One platform at a time, never under `Promise.all`: `withPlatform` puts back whatever
    // `process.platform` was when it started, so two overlapping calls restore each
    // other's pin rather than the host's, and the rest of the file runs on the wrong one.
    expect(await withPlatform('darwin', () => handleSquirrelEvent(argv))).toBe(false)
    expect(await withPlatform('linux', () => handleSquirrelEvent(argv))).toBe(false)

    expect(spawned).not.toHaveBeenCalled()
  })

  it('lets an ordinary launch through', async () => {
    expect(await run('--not-a-squirrel-switch')).toBe(false)
    expect(await withPlatform('win32', () => handleSquirrelEvent(['Statusky.exe']))).toBe(false)
    expect(spawned).not.toHaveBeenCalled()
  })

  /**
   * The Start Menu shortcut is the prerequisite for every Windows toast this app will
   * ever raise: Windows refuses a notification from an application that has no shortcut
   * carrying its AppUserModelID. Squirrel's own default also writes a desktop shortcut,
   * and the NSIS config this replaced said `createDesktopShortcut: false` — a preference
   * Squirrel cannot be given any other way, because `MakerSquirrel` has no shortcut
   * options at all. Naming only `StartMenu` here is the whole of honouring it.
   */
  it('writes a Start Menu shortcut on install, and no desktop shortcut', async () => {
    expect(await run('--squirrel-install')).toBe(true)

    expect(spawned).toHaveBeenCalledWith(
      UPDATE_EXE,
      [`--createShortcut=${TARGET}`, '--shortcut-locations=StartMenu'],
      { detached: true, stdio: 'ignore' }
    )
    expect(JSON.stringify(spawned.mock.calls)).not.toContain('Desktop')
  })

  /** An update replaces the versioned directory the shortcut points into. */
  it('rewrites the shortcut after an update', async () => {
    expect(await run('--squirrel-updated')).toBe(true)
    expect(spawned).toHaveBeenCalledWith(
      UPDATE_EXE,
      [`--createShortcut=${TARGET}`, '--shortcut-locations=StartMenu'],
      expect.anything()
    )
  })

  /**
   * The `statusky://` registry entry is written by the running app rather than by the
   * installer, so the uninstaller is the only thing that can take it away. Left behind,
   * it points the machine's handler at an executable that has just been deleted.
   */
  it('takes the shortcut and the URL scheme back on uninstall', async () => {
    expect(await run('--squirrel-uninstall')).toBe(true)

    expect(spawned).toHaveBeenCalledWith(
      UPDATE_EXE,
      [`--removeShortcut=${TARGET}`, '--shortcut-locations=StartMenu'],
      expect.anything()
    )
    expect(app.removeAsDefaultProtocolClient).toHaveBeenCalledWith('statusky', process.execPath, [
      '--'
    ])
  })

  /**
   * `--squirrel-obsolete` is the outgoing version being told a newer one has taken over.
   * The new version's own `--squirrel-updated` has already rewritten everything shared,
   * so there is nothing to undo — this exists purely to stop the app booting.
   */
  it('quits without touching anything when a version is retired', async () => {
    expect(await run('--squirrel-obsolete')).toBe(true)
    expect(spawned).not.toHaveBeenCalled()
    expect(app.removeAsDefaultProtocolClient).not.toHaveBeenCalled()
  })

  /**
   * The app is quitting either way and there is no window to report into. What must not
   * happen is a process that refuses to exit in the middle of an installer, because
   * Squirrel waits for it.
   */
  it('still gets out of the way when Update.exe cannot be started', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    spawned.mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })
    try {
      expect(await run('--squirrel-install')).toBe(true)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})
