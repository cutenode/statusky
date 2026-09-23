import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../../scripts/generate-ipc.mjs', import.meta.url))

/** Which branch a run of the generator says it wrote. */
async function environmentOf(wiring: string): Promise<string | undefined> {
  const source = await readFile(join(wiring, 'environment.ts'), 'utf8')
  return /IPC_ENVIRONMENT = '(\w+)'/.exec(source)?.[1]
}

/**
 * The generator records which `PopoverOnly` branch it compiled in, and the startup check
 * and packaging both rely on that record. Generating into `src/ipc` would swap the
 * wiring out from under every other test, so these runs point it at a temporary folder.
 */
describe('scripts/generate-ipc.mjs', () => {
  const folders: string[] = []

  afterEach(async () => {
    await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })))
    folders.length = 0
  })

  /** A folder for one run's wiring, which the run itself creates. */
  async function destination(): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), 'statusky-generate-ipc-'))
    folders.push(folder)
    return join(folder, 'ipc')
  }

  /**
   * Run the generator into a fresh folder, naming `environment` on the command line when
   * there is one, with `EIPC_ENV` set to `inherited` or, when that is undefined, unset.
   */
  async function generate(environment?: string, inherited?: string): Promise<string> {
    const wiring = await destination()
    const { EIPC_ENV: _ignored, ...env } = process.env
    await run(process.execPath, environment ? [SCRIPT, environment] : [SCRIPT], {
      env: {
        ...env,
        ...(inherited === undefined ? {} : { EIPC_ENV: inherited }),
        EIPC_WIRING_FOLDER: wiring
      }
    })
    return wiring
  }

  it.each([
    ['production', 'true'],
    ['development', 'false']
  ])(
    'records %s wiring beside the validator branch it compiled in',
    async (environment, packaged) => {
      const wiring = await generate(environment)

      expect(await readFile(join(wiring, 'environment.ts'), 'utf8')).toContain(
        `export const IPC_ENVIRONMENT = '${environment}' as 'development' | 'production'\n`
      )
      expect(await readFile(join(wiring, '_internal/browser/statusky.ts'), 'utf8')).toContain(
        `($$app$$.isPackaged) === ${packaged})`
      )
      expect(await readFile(join(wiring, '.eipc-generated'), 'utf8')).toContain(
        `Environment: ${environment}\n`
      )
    }
  )

  // `EIPC_ENV` is only the fallback. The npm scripts and the development test wiring name
  // their branch outright, and have to get it whatever the shell running them has set.
  it('takes the environment it is named over EIPC_ENV, and EIPC_ENV over production', async () => {
    expect(await environmentOf(await generate('production', 'development'))).toBe('production')
    expect(await environmentOf(await generate(undefined, 'development'))).toBe('development')
    expect(await environmentOf(await generate())).toBe('production')
  })

  it('refuses an environment it does not know, and writes nothing', async () => {
    const wiring = await destination()

    const failure = await run(process.execPath, [SCRIPT, 'staging'], {
      env: { ...process.env, EIPC_WIRING_FOLDER: wiring }
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Unknown IPC environment "staging"')
    })
    await expect(readdir(wiring)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  /**
   * Exactly the three layers whose generated imports trip this project's strict flags are
   * opted out of type-checking — and in particular not `common-runtime`, which imports the
   * Zod schemas by name, so a schema naming an export that does not exist still fails
   * `npm run check`.
   */
  it('opts exactly the three noisy layers out of type-checking', async () => {
    const wiring = await generate('production')
    const layers = ['browser', 'common', 'common-runtime', 'preload', 'renderer', 'renderer-hooks']

    const unchecked = await Promise.all(
      layers.map(async (layer) => {
        const source = await readFile(join(wiring, '_internal', layer, 'statusky.ts'), 'utf8')
        return source.startsWith('// @ts-nocheck\n')
      })
    )

    expect(Object.fromEntries(layers.map((layer, i) => [layer, unchecked[i]]))).toEqual({
      browser: true,
      common: true,
      'common-runtime': false,
      preload: true,
      renderer: false,
      'renderer-hooks': false
    })
  })
})
