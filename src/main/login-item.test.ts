import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../test/electron'
import { withPlatform } from '../test/harness'
import { applyLoginItem, explainLoginItemFailure, readLoginItem } from './login-item'

/**
 * The Linux half of this module is the half that cannot be exercised on the machine it
 * was written on, so it is written to be reachable anyway: the platform branch is on
 * `process.platform`, and everything below it is real filesystem work against a real
 * `$XDG_CONFIG_HOME`. What these tests therefore prove is that the right file, with the
 * right contents, appears in the right place. What they cannot prove is that a desktop
 * session honours it — nothing short of a Linux desktop can.
 */

let config: string
const originalXdg = process.env.XDG_CONFIG_HOME
const originalAppImage = process.env.APPIMAGE
const originalHome = process.env.HOME

/** Where `applyLoginItem` should put the entry, given the `XDG_CONFIG_HOME` below. */
function entryPath(): string {
  return join(config, 'autostart', 'statusky.desktop')
}

function readEntry(): Promise<string> {
  return readFile(entryPath(), 'utf8')
}

/**
 * Everything after `Exec=`, exactly. Compared whole rather than with `toContain`, so a
 * field code or a second argument trailing the quoted path would be caught.
 */
async function execValue(): Promise<string> {
  return /^Exec=(.*)$/m.exec(await readEntry())?.[1] ?? ''
}

beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), 'statusky-xdg-'))
  process.env.XDG_CONFIG_HOME = config
  // `homedir()` is the fallback when `XDG_CONFIG_HOME` is unset or unusable, and a test
  // that reaches it must not write into the home directory of whoever is running the
  // suite. Pointed at the same scratch directory, so the fallback is exercised for real
  // and lands somewhere that gets deleted afterwards.
  process.env.HOME = config
  delete process.env.APPIMAGE
})

afterEach(async () => {
  await rm(config, { recursive: true, force: true })
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  if (originalAppImage === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = originalAppImage
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
})

describe('XDG autostart', () => {
  it('writes an autostart entry under $XDG_CONFIG_HOME', async () => {
    app.isPackaged = true

    const status = await withPlatform('linux', () => applyLoginItem(true))

    expect(status).toEqual({ registered: true, error: null })
    const entry = await readEntry()
    expect(entry).toContain('[Desktop Entry]')
    expect(entry).toContain('Type=Application')
    expect(entry).toContain('Name=Statusky')
    // What GNOME's startup-applications UI writes when a user switches an entry off
    // there. Saying it outright makes switching it back on from here a real re-enable.
    expect(entry).toContain('X-GNOME-Autostart-enabled=true')
  })

  // The .deb's own menu entry says so, for the same reason: Statusky has no window to
  // raise, so the startup notification never resolves into anything the user can see.
  it('matches build/desktop.ejs on StartupNotify', async () => {
    app.isPackaged = true
    await withPlatform('linux', () => applyLoginItem(true))
    expect(await readEntry()).toContain('StartupNotify=false')
  })

  it('creates the autostart directory when it is not there yet', async () => {
    app.isPackaged = true
    expect(existsSync(join(config, 'autostart'))).toBe(false)

    await withPlatform('linux', () => applyLoginItem(true))

    expect(existsSync(entryPath())).toBe(true)
  })

  it('removes the entry when the preference goes off', async () => {
    app.isPackaged = true
    await withPlatform('linux', () => applyLoginItem(true))
    expect(existsSync(entryPath())).toBe(true)

    const status = await withPlatform('linux', () => applyLoginItem(false))

    expect(status).toEqual({ registered: false, error: null })
    expect(existsSync(entryPath())).toBe(false)
  })

  // Somebody removed it by hand, or GNOME's startup-applications UI did. Arriving at
  // the state that was asked for is not a failure just because there was nothing to do.
  it('is content when there is no entry to remove', async () => {
    const status = await withPlatform('linux', () => applyLoginItem(false))
    expect(status).toEqual({ registered: false, error: null })
  })

  it('ignores a relative $XDG_CONFIG_HOME, as the spec says to', async () => {
    app.isPackaged = true
    process.env.XDG_CONFIG_HOME = 'relative/config'

    // Ignored, so it falls back to `$HOME/.config` — which `beforeEach` has pointed at
    // the scratch directory. The failure being prevented is the other outcome: a path
    // resolved against whatever directory the session happened to launch us in, where
    // nobody will ever find it and no session will ever run it.
    const status = await withPlatform('linux', () => applyLoginItem(true))

    expect(status).toEqual({ registered: true, error: null })
    expect(existsSync(join(config, '.config', 'autostart', 'statusky.desktop'))).toBe(true)
    expect(existsSync(join('relative/config', 'autostart', 'statusky.desktop'))).toBe(false)
  })

  describe('the Exec line', () => {
    it('names the AppImage the user launched, not the mount it runs from', async () => {
      app.isPackaged = true
      // Inside an AppImage `process.execPath` points into a temporary mount that is gone
      // by the next login; `APPIMAGE` is the file that will still be there.
      process.env.APPIMAGE = '/home/u/Applications/Statusky.AppImage'

      await withPlatform('linux', () => applyLoginItem(true))

      // Nothing after the path, either: no `%U` or other field code, because nothing
      // hands this app a file or a URL at login.
      expect(await execValue()).toBe('"/home/u/Applications/Statusky.AppImage"')
    })

    it('falls back to the absolute path of a packaged binary', async () => {
      app.isPackaged = true

      await withPlatform('linux', () => applyLoginItem(true))

      // Absolute rather than the bare `statusky` the .deb's menu entry uses, so it does
      // not depend on what the session put on PATH.
      expect(await execValue()).toBe(`"${process.execPath}"`)
    })

    it('quotes a path with spaces rather than writing two arguments', async () => {
      app.isPackaged = true
      process.env.APPIMAGE = '/home/u/My Apps/Statusky.AppImage'

      await withPlatform('linux', () => applyLoginItem(true))

      expect(await execValue()).toBe('"/home/u/My Apps/Statusky.AppImage"')
    })

    it('escapes the characters the desktop entry format reserves', async () => {
      app.isPackaged = true
      process.env.APPIMAGE = '/home/u/a"b$c`d\\e/Statusky.AppImage'

      await withPlatform('linux', () => applyLoginItem(true))

      const exec = await execValue()
      // Unescaping the file format first (`\\` -> `\`) and then the Exec tokeniser's own
      // quoting has to land back on the path we started from.
      const unescapedFile = exec.replace(/\\\\/g, '\\')
      const unquoted = unescapedFile.slice(1, -1).replace(/\\(["`$\\])/g, '$1')
      expect(unquoted).toBe('/home/u/a"b$c`d\\e/Statusky.AppImage')
    })

    /**
     * The case the module deliberately declines rather than guesses at. A development
     * checkout's `execPath` is Electron's own binary, and an entry pointing into
     * node_modules is wrong the moment the checkout moves — so it says so instead.
     */
    it('refuses to invent one for an unpackaged development run', async () => {
      app.isPackaged = false

      const status = await withPlatform('linux', () => applyLoginItem(true))

      expect(status.registered).toBe(false)
      expect(status.error).toContain('source checkout')
      expect(existsSync(entryPath())).toBe(false)
    })
  })

  it('explains a filesystem that will not take the entry', async () => {
    app.isPackaged = true
    // A file where the autostart *directory* has to go: `mkdirSync` cannot make it and
    // there is nowhere to write. Closer to the real failures (a read-only or full home)
    // than any mock, and it produces the same refusal.
    await writeFile(join(config, 'autostart'), 'not a directory')

    const status = await withPlatform('linux', () => applyLoginItem(true))

    expect(status.registered).toBe(false)
    expect(status.error).toContain('would not open Statusky at login')
  })

  // `rmSync` with `force` swallows a missing file, but not a path it cannot remove —
  // here one that is a non-empty directory rather than the entry we wrote.
  it('explains an entry it cannot remove', async () => {
    mkdirSync(join(config, 'autostart', 'statusky.desktop'), { recursive: true })
    await writeFile(join(config, 'autostart', 'statusky.desktop', 'occupied'), 'x')

    const status = await withPlatform('linux', () => applyLoginItem(false))

    expect(status.registered).toBe(true)
    expect(status.error).toContain('stop opening Statusky at login')
  })

  it('reports what is on disk rather than what was asked for', async () => {
    app.isPackaged = true
    expect(await withPlatform('linux', () => readLoginItem())).toBe(false)

    mkdirSync(join(config, 'autostart'), { recursive: true })
    await writeFile(entryPath(), '[Desktop Entry]\n')

    expect(await withPlatform('linux', () => readLoginItem())).toBe(true)
  })
})

describe('the native login item', () => {
  // Everything below is about a build the OS can actually register. A source checkout is
  // its own case, at the bottom of this block.
  beforeEach(() => {
    app.isPackaged = true
  })

  it('registers and reads the result back', async () => {
    const status = await withPlatform('darwin', () => applyLoginItem(true))

    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect(status).toEqual({ registered: true, error: null })
  })

  /**
   * The whole of item 4. On macOS 13+ this goes through SMAppService, which declines a
   * bundle it will not register and declines it silently — so a `try/catch` around the
   * write catches nothing and the toggle is left saying yes to something that will not
   * happen. Only reading it back afterwards finds out.
   */
  it('notices a refusal that raised nothing at all', async () => {
    app.loginItemRefuses = true

    const status = await withPlatform('darwin', () => applyLoginItem(true))

    expect(status.registered).toBe(false)
    expect(status.error).toContain('SMAppService')
  })

  it('notices a refusal to *stop* opening at login', async () => {
    app.loginItem = { openAtLogin: true, openAsHidden: false }
    app.loginItemRefuses = true

    const status = await withPlatform('darwin', () => applyLoginItem(false))

    expect(status.registered).toBe(true)
    expect(status.error).toContain('stop opening Statusky at login')
  })

  // Windows, where the OS's own wording is the only clue there is. On macOS the same
  // throw is explained in terms of SMAppService instead, as the refusals above are.
  it('carries a thrown refusal through instead of crashing the change handler', async () => {
    app.loginItemThrows = new Error('not a bundled app')

    const status = await withPlatform('win32', () => applyLoginItem(true))

    expect(status).toEqual({
      registered: false,
      error: 'The system would not open Statusky at login: not a bundled app'
    })
  })

  // A native binding is not obliged to throw an `Error`, and the sentence the user ends
  // up reading is built out of whatever it did throw.
  it('carries through a refusal that was not thrown as an Error', async () => {
    app.setLoginItemSettings.mockImplementationOnce(() => {
      throw 'the login item database is locked'
    })

    const status = await withPlatform('win32', () => applyLoginItem(true))

    expect(status.error).toBe(
      'The system would not open Statusky at login: the login item database is locked'
    )
  })

  // Reading the setting back is itself a call into the OS, and an OS that will not
  // answer the question has certainly not registered anything.
  it('survives an OS that will not even answer', async () => {
    app.getLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('login item database unavailable')
    })

    const status = await withPlatform('darwin', () => applyLoginItem(true))

    expect(status.registered).toBe(false)
    expect(status.error).toContain('SMAppService')
  })

  /**
   * What the screenshot in the bug report showed: "Login Item Added — Electron will open
   * automatically when you log in". `setLoginItemSettings` registers the running bundle,
   * and in a source checkout that is Electron's own bundle from node_modules, so macOS
   * accepts it under Electron's name and the read-back agrees. Nothing here can rename
   * that bundle, so the only honest answer is to decline and say why — which is what the
   * Linux branch has always done, and what the README already promised.
   */
  it('refuses a source checkout rather than registering Electron under its own name', async () => {
    app.isPackaged = false

    const status = await withPlatform('darwin', () => applyLoginItem(true))

    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(status.registered).toBe(false)
    expect(status.error).toContain('Electron')
  })

  // The other half of that refusal: an entry a development build registered before the
  // check existed is still on the user's machine, and this is the only thing that can
  // take it away again.
  it('still lets a source checkout remove an entry an earlier one left behind', async () => {
    app.isPackaged = false
    app.loginItem = { openAtLogin: true, openAsHidden: false }

    const status = await withPlatform('darwin', () => applyLoginItem(false))

    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
    expect(status).toEqual({ registered: false, error: null })
  })

  it('reports what the OS says, without writing anything', async () => {
    app.loginItem = { openAtLogin: true, openAsHidden: false }

    expect(await withPlatform('darwin', () => readLoginItem())).toBe(true)
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('treats an unanswerable question as not registered', async () => {
    app.getLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('login item database unavailable')
    })

    expect(await withPlatform('darwin', () => readLoginItem())).toBe(false)
  })
})

describe('explainLoginItemFailure', () => {
  // The opaque part is what the user needs: SMAppService's two real causes are "not in
  // /Applications" and "not properly signed", and it names neither of them itself.
  it('names what macOS will not say', () => {
    const text = explainLoginItemFailure(true, null, 'darwin')
    expect(text).toContain('Applications folder')
    expect(text).toContain('code signed')
  })

  it('keeps the OS wording elsewhere, where it is the only clue there is', () => {
    const text = explainLoginItemFailure(true, 'EROFS: read-only file system', 'linux')
    expect(text).toContain('EROFS: read-only file system')
  })

  it('still says something useful with nothing to go on', () => {
    expect(explainLoginItemFailure(true, null, 'win32')).toBe(
      'The system would not open Statusky at login.'
    )
  })

  it('says which direction failed', () => {
    expect(explainLoginItemFailure(false, null, 'win32')).toContain('stop opening')
  })
})
