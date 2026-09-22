import { Menu, app } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

/**
 * The application menu, and the About panel it opens.
 *
 * Nothing used to call `Menu.setApplicationMenu`, which does not mean the app had no
 * menu: it means Electron installed its own default one. Statusky is `LSUIElement`, so
 * that menu is never drawn — but a menu does not have to be drawn for its key
 * equivalents to fire, and the default one claims `Cmd+R` for View → Reload. An
 * accelerator is consumed before the page ever sees the key, so the renderer's own
 * `Cmd+R` handler in `src/renderer/src/App.svelte` — refresh the feed, or run the
 * network checks when the Network tab is showing — was being silently eaten by a menu
 * nobody can see. Owning the menu is how that key comes back.
 *
 * What is left in it is deliberately small. A frameless, always-on-top popover that
 * sets `skipTaskbar` and `fullscreenable: false` has no business being minimised,
 * zoomed, closed or taken fullscreen, so none of those entries exist to be triggered
 * by accident.
 */
const COPYRIGHT = 'Copyright © 2026 Statusky contributors'

/**
 * The About panel's own paragraph. macOS draws `credits` under the version, and it is
 * the only place in the app that says what the two kinds of entry in the feed are —
 * which matters, because one kind is reported by the services and the other is
 * measured from this machine and can disagree with them.
 */
const CREDITS =
  'A menu bar feed of AT Protocol infrastructure status updates.\n\n' +
  'Status posts come from the services themselves. Network checks are measured from ' +
  'this machine, so they report your own path to each service.'

/**
 * Tell the OS what to put in the native About panel.
 *
 * Without this, macOS falls back to the bundle's Info.plist, which in an unsigned
 * development build still says "Electron". Both openers — the app menu's About item
 * and the tray menu's — go through the same panel, so this is the one place the
 * version, the copyright and the description are stated.
 */
export function configureAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    copyright: COPYRIGHT,
    // macOS reads `credits`; GTK's about dialog reads `authors`. Neither platform
    // minds being handed the other's key.
    credits: CREDITS,
    authors: ['Statusky contributors']
  })
}

/**
 * The macOS menu bar: an app role submenu and an Edit submenu, and nothing else.
 *
 * The Edit submenu is load-bearing rather than decorative. On macOS the editing key
 * equivalents live in the menu and nowhere else, so without `cut`, `copy` and `paste`
 * here, `Cmd+V` does nothing at all — and the Add-account field in
 * `src/renderer/src/components/AddAccountForm.svelte` exists to have a handle or a
 * status page URL pasted into it.
 *
 * `role: 'quit'` rather than a click that calls the app's own teardown: `app.quit()`
 * emits `before-quit`, which `src/main/index.ts` already uses to stop the model, and
 * the role is the only version of this item macOS will label and localise correctly.
 */
function macTemplate(): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ]

  if (!app.isPackaged) {
    // Reloading the renderer and opening its devtools are worth having while
    // developing, and worth nobody being able to reach by accident in a shipped menu
    // bar app. Reload is deliberately not on `Cmd+R`, which is the renderer's: this
    // submenu exists because that collision was the problem, not to reintroduce it
    // one keystroke away.
    template.push({
      label: 'Develop',
      submenu: [
        { role: 'reload', accelerator: 'Shift+CommandOrControl+R' },
        { role: 'toggleDevTools' }
      ]
    })
  }

  return template
}

/**
 * Install the application menu, or refuse one outright.
 *
 * On Windows and Linux an application menu is drawn as a menu bar *inside* the window,
 * and a frameless popover with no title bar must not suddenly grow one; `null` is the
 * only correct answer there. Nothing is lost by it, because those platforms are also
 * the ones where the editing keys do not come from the menu: Chromium handles
 * `Ctrl+C`, `Ctrl+V` and friends in the renderer itself, so the Add-account field
 * keeps working without an Edit submenu. macOS is the platform where it would not,
 * which is why macOS is the platform that gets a menu.
 */
export function installApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(macTemplate()))
}
