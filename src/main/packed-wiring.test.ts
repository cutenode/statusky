import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertProductionWiring, refusePackaging } from './packed-wiring'

/**
 * The compiled `PopoverOnly` condition as electron-vite writes it into
 * `out/main/index.js`. Production is copied from a real build. Development is the same
 * schema generated with `EIPC_ENV=development` and put through esbuild, with Rollup's
 * rename of `$$app$$` to the imported `app` applied.
 */
const PRODUCTION = `app.isPackaged === true && event.senderFrame?.parent === null === true && (url.origin === "null" || url.origin === null ? \`\${url.protocol}//\${url.host}\` : url.origin) === "app://statusky"`
const DEVELOPMENT = `app.isPackaged === false && event.senderFrame?.parent === null === true && ((url.origin === "null" || url.origin === null ? \`\${url.protocol}//\${url.host}\` : url.origin) === "app://statusky" || url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))`

/** The same validators through `esbuild --minify`, verbatim. */
const MINIFIED_PRODUCTION = `function r(c){if(!c.senderFrame||!c.senderFrame.url)return!1;let o;try{o=new URL(c.senderFrame.url)}catch{return!1}return s.isPackaged===!0&&c.senderFrame?.parent===null&&(o.origin==="null"||o.origin===null?\`\${o.protocol}//\${o.host}\`:o.origin)==="app://statusky"}`
const MINIFIED_DEVELOPMENT = `function o(a){if(!a.senderFrame||!a.senderFrame.url)return!1;let t;try{t=new URL(a.senderFrame.url)}catch{return!1}return s.isPackaged===!1&&a.senderFrame?.parent===null&&((t.origin==="null"||t.origin===null?\`\${t.protocol}//\${t.host}\`:t.origin)==="app://statusky"||t.protocol==="http:"&&(t.hostname==="localhost"||t.hostname==="127.0.0.1"))}`

/**
 * The app's own uses of `app.isPackaged`, from the same bundle. They test it for
 * truthiness, so none of them may count as wiring.
 */
const APP_CODE = `function resourcesDir() {
  return app.isPackaged ? join(process.resourcesPath, "resources") : join(import.meta.dirname, "../../resources");
}
function watchRenderer(window) {
  if (!app.isPackaged) {
    window.webContents.on("render-process-gone", (_event, details) => console.error("[renderer] process gone:", details));
  }
}
function reportWiringMismatch() {
  const running = app.isPackaged ? "production" : "development";
  if (IPC_ENVIRONMENT === running) return;
}`

function mainBundle(condition: string | null, environment?: string): string {
  const validator =
    condition === null
      ? ''
      : `function $eipc_event_validator$_PopoverOnly(event) {
  if (!event.senderFrame) return false;
  if (!event.senderFrame.url) return false;
  let url;
  try {
    url = new URL(event.senderFrame.url);
  } catch {
    return false;
  }
  if (${condition}) return true;
  return false;
}`
  return `import { app, Notification, shell, BrowserWindow, powerMonitor, nativeTheme } from "electron";
const $$ipcPrefix$$ = "$eipc_message$_3f09b55f-9aef-40dd-8949-4b9b1488a4af_$_statusky_$_";
${validator}
${environment ?? ''}
${APP_CODE}
`
}

const PRELOAD = `"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("statusky", api);
`
const RENDERER = 'const e=window.statusky;e.State.get().then(t=>n(t));'

function build(main: string): { path: string; code: string }[] {
  return [
    { path: 'out/main/index.js', code: main },
    { path: 'out/preload/index.cjs', code: PRELOAD },
    { path: 'out/renderer/assets/index-B1Nkwsn5.js', code: RENDERER }
  ]
}

describe('refusePackaging', () => {
  it('accepts production wiring, beside bundles that hold no wiring at all', () => {
    expect(
      refusePackaging(build(mainBundle(PRODUCTION, 'const IPC_ENVIRONMENT = "production";')))
    ).toBeNull()
    // Nothing depends on the constant being there.
    expect(refusePackaging(build(mainBundle(PRODUCTION)))).toBeNull()
  })

  it('refuses development wiring, naming the file and the command that fixes it', () => {
    const reason = refusePackaging(
      build(mainBundle(DEVELOPMENT, 'const IPC_ENVIRONMENT = "development";'))
    )

    expect(reason).toContain('out/main/index.js was built with development IPC wiring')
    expect(reason).toContain('`npm run build`')
  })

  it('reads validators a minifier has rewritten', () => {
    expect(refusePackaging(build(MINIFIED_PRODUCTION))).toBeNull()
    expect(refusePackaging(build(MINIFIED_DEVELOPMENT))).toContain('development IPC wiring')
  })

  it('reads the comparison either way round', () => {
    expect(refusePackaging(build('return!0===s.isPackaged&&c.senderFrame?.parent===null'))).toBe(
      null
    )
    expect(
      refusePackaging(build('if (false === (app.isPackaged) && event.senderFrame) return true;'))
    ).toContain('development IPC wiring')
  })

  it("does not mistake the app's own isPackaged checks for wiring", () => {
    const reason = refusePackaging(build(mainBundle(null)))

    expect(reason).toContain('no compiled IPC origin validator was found in 3 JavaScript file(s)')
    expect(reason).toContain('`npm run build`')
  })

  it('fails closed without the validator, even when the constant says production', () => {
    expect(
      refusePackaging(build(mainBundle(null, 'const IPC_ENVIRONMENT = "production";')))
    ).toContain('no compiled IPC origin validator')
  })

  it('refuses a build whose recorded environment contradicts its validator', () => {
    // Rollup suffixes a binding that collides with another module's.
    const reason = refusePackaging(
      build(mainBundle(PRODUCTION, 'const IPC_ENVIRONMENT$1 = "development";'))
    )

    expect(reason).toContain('both production and development IPC wiring')
    expect(reason).toContain('development in out/main/index.js; production in out/main/index.js')
  })

  it('refuses bundles that disagree with each other, naming each', () => {
    const reason = refusePackaging([
      { path: 'out/main/index.js', code: mainBundle(PRODUCTION) },
      { path: 'out/main/chunks/wiring.js', code: MINIFIED_DEVELOPMENT }
    ])

    expect(reason).toContain(
      '(development in out/main/chunks/wiring.js; production in out/main/index.js)'
    )
  })

  it('refuses a build with no JavaScript in it', () => {
    expect(refusePackaging([])).toContain('out/ contains no built JavaScript')
  })
})

describe('assertProductionWiring', () => {
  let appDir: string | null = null

  afterEach(async () => {
    if (appDir) await rm(appDir, { recursive: true, force: true })
    appDir = null
  })

  /** An app directory holding exactly these files. */
  async function app(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'statusky-packed-wiring-'))
    appDir = dir
    await Promise.all(
      Object.entries(files).map(async ([path, contents]) => {
        const file = join(dir, path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, contents)
      })
    )
    return dir
  }

  it('lets a production build through', async () => {
    const dir = await app({
      'out/main/index.js': mainBundle(PRODUCTION),
      'out/preload/index.cjs': PRELOAD,
      'out/renderer/index.html': '<script type="module" src="./assets/index.js"></script>',
      'out/renderer/assets/index.js': RENDERER
    })

    await expect(assertProductionWiring(dir)).resolves.toBeUndefined()
  })

  // The `npm start` incident in reverse: `src/ipc` regenerated, `out/` never rebuilt.
  it('judges the stale bundle in out/, not freshly generated src/ipc', async () => {
    const dir = await app({
      'src/ipc/environment.ts':
        "export const IPC_ENVIRONMENT = 'production' as 'development' | 'production'\n",
      'out/main/index.js': mainBundle(DEVELOPMENT),
      'out/preload/index.cjs': PRELOAD
    })

    await expect(assertProductionWiring(dir)).rejects.toThrow(
      /^Refusing to package: out[/\\]main[/\\]index\.js was built with development IPC wiring/
    )
  })

  // forge.config.ts leaves maps out of the package, and their embedded sources can
  // be older than the code beside them.
  it('ignores source maps, which are not packed', async () => {
    const dir = await app({
      'out/main/index.js': mainBundle(PRODUCTION),
      'out/main/index.js.map': JSON.stringify({
        sourcesContent: ['if (((($$app$$.isPackaged) === false))) return true;']
      })
    })

    await expect(assertProductionWiring(dir)).resolves.toBeUndefined()
  })

  it('refuses when nothing has been built yet', async () => {
    const dir = await app({ 'package.json': '{}' })

    await expect(assertProductionWiring(dir)).rejects.toThrow('out/ contains no built JavaScript')
  })

  it('passes on any other reason out/ cannot be read', async () => {
    const dir = await app({ out: 'not a directory' })

    await expect(assertProductionWiring(dir)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
