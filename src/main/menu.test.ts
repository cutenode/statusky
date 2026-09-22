import { describe, expect, it } from 'vitest'
import { Menu, app, applicationMenu, menus } from '../test/electron'
import type { MenuItemTemplate } from '../test/electron'
import { withPlatform } from '../test/harness'
import { configureAboutPanel, installApplicationMenu } from './menu'

/** Install the menu as the given platform would see it, and hand back what was built. */
async function install(platform: NodeJS.Platform = 'darwin'): Promise<void> {
  await withPlatform(platform, () => installApplicationMenu())
}

/** Every accelerator spelled out in the template, submenus included. */
function accelerators(entries: MenuItemTemplate[]): string[] {
  return entries.flatMap((entry) => [
    ...(entry.accelerator ? [entry.accelerator] : []),
    ...accelerators(entry.submenu ?? [])
  ])
}

describe('the macOS application menu', () => {
  it('replaces Electron’s default menu rather than leaving it installed', async () => {
    await install()

    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
    expect(applicationMenu.current).toBe(menus.at(-1))
  })

  it('carries the app submenu and an Edit submenu, and nothing else', async () => {
    app.isPackaged = true
    await install()

    expect(applicationMenu.current?.template.map((entry) => entry.label)).toEqual([
      'Statusky',
      'Edit'
    ])
  })

  it('offers About, Hide, Hide Others and Quit under the app’s own name', async () => {
    await install()

    expect(applicationMenu.current?.submenu('Statusky')?.map((e) => e.role ?? e.type)).toEqual([
      'about',
      'separator',
      'hide',
      'hideOthers',
      'separator',
      'quit'
    ])
  })

  // Without these, Cmd+V does nothing at all on macOS: the editing key equivalents
  // live in the menu and nowhere else. The Add-account field is the thing that breaks.
  it('keeps the standard editing roles, so the popover can be pasted into', async () => {
    await install()

    expect(applicationMenu.current?.submenu('Edit')?.map((e) => e.role ?? e.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'selectAll'
    ])
  })

  // Every one of these is an accelerator Electron's default menu claimed. A popover
  // that is frameless, always on top and off the taskbar must not be reachable by any
  // of them, and `reload` is the one that was eating the renderer's own Cmd+R.
  it('claims none of the window or reload accelerators a popover has no use for', async () => {
    app.isPackaged = true
    await install()

    const roles = applicationMenu.current!.roles()
    for (const role of [
      'reload',
      'forceReload',
      'toggleDevTools',
      'minimize',
      'close',
      'zoom',
      'togglefullscreen',
      'front'
    ]) {
      expect(roles).not.toContain(role)
    }
  })

  it('leaves Quit on its usual key equivalent', async () => {
    app.isPackaged = true
    await install()

    // `role: 'quit'` is what supplies Cmd+Q; spelling one out here would override the
    // role rather than confirm it, so the role itself is the assertion.
    expect(applicationMenu.current?.roles()).toContain('quit')
    expect(accelerators(applicationMenu.current!.template)).toEqual([])
  })
})

describe('the development-only entries', () => {
  it('adds reload and devtools while the app is unpackaged', async () => {
    await install()

    expect(applicationMenu.current?.submenu('Develop')?.map((e) => e.role)).toEqual([
      'reload',
      'toggleDevTools'
    ])
  })

  // The whole point of owning the menu: Cmd+R belongs to the renderer, which refreshes
  // the feed with it — or runs the network checks when that tab is showing.
  it('moves reload off Cmd+R, which the renderer owns', async () => {
    await install()

    const reload = applicationMenu.current?.submenu('Develop')?.[0]
    expect(reload?.accelerator).toBe('Shift+CommandOrControl+R')
    expect(accelerators(applicationMenu.current!.template)).not.toContain('CommandOrControl+R')
  })

  it('ships nothing of the sort in a packaged build', async () => {
    app.isPackaged = true
    await install()

    expect(applicationMenu.current?.submenu('Develop')).toBeUndefined()
  })
})

describe('other platforms', () => {
  // An application menu draws as a menu bar inside the window on Windows and Linux,
  // and a frameless popover must not grow one. Nothing is lost: Chromium handles the
  // editing keys in the renderer there, so pasting still works without an Edit menu.
  it('refuses a menu outright on Windows, rather than leaving Electron’s default', async () => {
    await install('win32')

    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(null)
    expect(applicationMenu.current).toBeNull()
    // Nothing was even built: there is no template here to get out of step.
    expect(menus).toEqual([])
  })

  it('refuses a menu outright on Linux too', async () => {
    await install('linux')

    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(null)
    expect(applicationMenu.current).toBeNull()
    expect(menus).toEqual([])
  })
})

describe('the About panel', () => {
  it('states the app’s own name, version and copyright', () => {
    configureAboutPanel()

    expect(app.aboutPanel).toMatchObject({
      applicationName: 'Statusky',
      applicationVersion: app.getVersion(),
      copyright: expect.stringContaining('Statusky contributors')
    })
  })

  // macOS draws `credits`, GTK draws `authors`, and neither minds the other's key.
  it('explains what the two kinds of entry in the feed are', () => {
    configureAboutPanel()

    expect(String(app.aboutPanel?.credits)).toContain('measured from this machine')
    expect(app.aboutPanel?.authors).toEqual(['Statusky contributors'])
  })
})
