/**
 * Which IPC wiring a built `out/` really contains, checked by Electron Forge's
 * `packageAfterCopy` hook.
 *
 * This is build tooling, not app code. Nothing in the app imports it, so it never ends
 * up in the bundle. It sits beside the main process because it needs Node's `fs`, and
 * `src/shared` is also type-checked for the renderer, which has no Node types.
 *
 * It reads the bundle rather than `src/ipc` on purpose. Only `electron-vite build`
 * rewrites `out/`, so `out/` can be older than `src/ipc`: regenerating production wiring
 * without rebuilding leaves development wiring in `out/`, and `out/` is what gets packed.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

export type IpcEnvironment = 'development' | 'production'

/** One packed JavaScript file, by its path relative to the app directory. */
export interface PackedFile {
  path: string
  code: string
}

/**
 * The deciding clause of the compiled `PopoverOnly` validator. The generator writes
 * `($$app$$.isPackaged) === true` for production and `=== false` for development. esbuild
 * drops the parentheses, Rollup renames `$$app$$` to the imported `app`, and a minifier
 * rewrites the boolean as `!0`/`!1` and may swap the operands. None of that changes the
 * `isPackaged` property access or the boolean it is compared with.
 *
 * This is the signal packaging trusts, because it is the condition that refuses the
 * calls. It is an evidence check, not a guess about intent. The app's own code tests
 * `app.isPackaged` for truthiness and never compares it with a boolean. If that ever
 * changes, those comparisons read as wiring and packaging fails closed as 'mixed'.
 */
const VALIDATOR_CLAUSES = [
  /\.isPackaged\)?\s*===\s*(true|false|!0|!1)(?![\w$])/g,
  // Only the words need a boundary: minified code writes `return!0===…` with none.
  /((?<![\w$])(?:true|false)|!0|!1)\s*===\s*\(?[\w$]+\.isPackaged(?![\w$])/g
]

/**
 * `export const IPC_ENVIRONMENT` from `src/ipc/environment.ts`, as Rollup writes it (it
 * renames on collision with a `$1` suffix). It only corroborates. A minifier renames it,
 * and Rollup drops it if nothing reads it, so a build without it is not suspicious. A
 * build where it contradicts the validator is.
 */
const DECLARATION =
  /\b(?:const|let|var)\s+IPC_ENVIRONMENT(?:\$\d+)?\s*=\s*(["'])(development|production)\1/g

function environmentOf(token: string): IpcEnvironment {
  return token === 'true' || token === '!0' || token === 'production' ? 'production' : 'development'
}

interface Signals {
  validator: Set<IpcEnvironment>
  any: Set<IpcEnvironment>
}

/** Every environment a piece of bundled code points to. */
function readSignals(code: string): Signals {
  const validator = new Set<IpcEnvironment>()
  for (const pattern of VALIDATOR_CLAUSES) {
    for (const match of code.matchAll(pattern)) validator.add(environmentOf(match[1]!))
  }
  const any = new Set(validator)
  for (const match of code.matchAll(DECLARATION)) any.add(environmentOf(match[2]!))
  return { validator, any }
}

const REBUILD =
  'Run `npm run build`, which regenerates production wiring and rebuilds out/, then package again.'

/**
 * Why these files must not be packaged, or `null` when they carry production wiring and
 * nothing else. Anything short of that refuses: development wiring, a mix of both, or no
 * validator at all, since then there is nothing to say which wiring the app will use.
 */
export function refusePackaging(files: readonly PackedFile[]): string | null {
  if (files.length === 0) {
    return `Refusing to package: out/ contains no built JavaScript. ${REBUILD}`
  }

  const signals = files.map((file) => ({ path: file.path, ...readSignals(file.code) }))
  const pointingTo = (environment: IpcEnvironment): string =>
    signals
      .filter((file) => file.any.has(environment))
      .map((file) => file.path)
      .join(', ')

  const development = pointingTo('development')
  const production = pointingTo('production')

  if (development && production) {
    return (
      'Refusing to package: out/ contains both production and development IPC wiring ' +
      `(development in ${development}; production in ${production}), so there is no ` +
      `telling which one the app would run. ${REBUILD} If this persists, some code ` +
      'outside the generated wiring compares isPackaged with a boolean, which this check ' +
      'cannot tell apart from the validator.'
    )
  }

  if (development) {
    return (
      `Refusing to package: ${development} was built with development IPC wiring, whose ` +
      `origin validator refuses every call once the app is packaged. ${REBUILD}`
    )
  }

  if (!signals.some((file) => file.validator.size > 0)) {
    return (
      'Refusing to package: no compiled IPC origin validator was found in ' +
      `${files.length} JavaScript file(s) under out/, so there is no telling which IPC ` +
      `wiring the build contains. ${REBUILD} If this persists, the generated validator ` +
      'has changed shape and src/main/packed-wiring.ts needs to learn the new one.'
    )
  }

  return null
}

/** The script extensions a Vite/Rollup build writes. */
const SCRIPT = /\.(?:c|m)?js$/

/**
 * Fail packaging unless `out/` under `appDir` holds production wiring.
 *
 * `appDir` is packager's staged application directory rather than the repository, so
 * `out/` under it is the copy that is about to be asar'd — but the layout is the same
 * either way, which is why this path is still just `out`.
 *
 * Source maps are skipped because forge.config.ts leaves them out of the package.
 * Their embedded sources can show wiring the shipped code no longer has.
 */
export async function assertProductionWiring(appDir: string): Promise<void> {
  const outDir = join(appDir, 'out')
  const entries = await readdir(outDir, { recursive: true, withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    }
  )

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && SCRIPT.test(entry.name))
      .map(async (entry) => {
        const absolute = join(entry.parentPath, entry.name)
        return { path: relative(appDir, absolute), code: await readFile(absolute, 'utf8') }
      })
  )

  const reason = refusePackaging(files)
  if (reason) throw new Error(reason)
}
