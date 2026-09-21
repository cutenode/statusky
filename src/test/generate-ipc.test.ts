import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../../scripts/generate-ipc.mjs', import.meta.url))

/**
 * The generator records which `PopoverOnly` branch it compiled in, and the startup check
 * and packaging both rely on that record. Generating into `src/ipc` would swap the
 * wiring out from under every other test, so these runs point it at a temporary folder.
 */
describe('scripts/generate-ipc.mjs', () => {
  let folder: string | null = null

  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true })
    folder = null
  })

  async function generate(environment: string): Promise<string> {
    folder = await mkdtemp(join(tmpdir(), 'statusky-generate-ipc-'))
    const wiring = join(folder, 'ipc')
    await run(process.execPath, [SCRIPT, environment], {
      env: { ...process.env, EIPC_WIRING_FOLDER: wiring }
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
})
