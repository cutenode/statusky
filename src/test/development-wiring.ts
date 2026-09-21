/**
 * Generate the development IPC wiring for the `node-development` test project.
 *
 * `PopoverOnly` in `schemas/statusky.eipc` has a production branch and a development
 * branch, and only one of them is compiled into any given copy of the wiring. `npm test`
 * generates production wiring into `src/ipc`, so on its own the suite never meets the
 * development branch — the one `npm run dev` and `npm start` actually run. This builds
 * the development wiring from the same schema, fresh on every run, into a folder of its
 * own, so the production wiring every other test reads is never touched and the two
 * cannot be mixed up.
 *
 * It runs `scripts/generate-ipc.mjs` itself, redirected with `EIPC_WIRING_FOLDER`, rather
 * than calling the generator directly: the wiring under test is then exactly what a
 * development build gets, `environment.ts` included, and any change to how the script
 * generates reaches these tests without being copied here. Running it as a child process
 * also keeps the generator's `EIPC_ENV` out of the Vitest process.
 *
 * The folder sits directly under `src/`, beside `src/ipc`, because the generated files
 * import the Zod schemas through the relative path in the schema's `zod_reference`
 * blocks (`../../../shared/schemas`, from `_internal/common-runtime/`), which only lands
 * on `src/shared` from that depth.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const DEVELOPMENT_WIRING = fileURLToPath(new URL('../ipc-development', import.meta.url))

const GENERATOR = fileURLToPath(new URL('../../scripts/generate-ipc.mjs', import.meta.url))

export async function setup(): Promise<void> {
  // The argument wins over any EIPC_ENV this process inherited, so the branch is never
  // in doubt.
  await promisify(execFile)(process.execPath, [GENERATOR, 'development'], {
    env: { ...process.env, EIPC_WIRING_FOLDER: DEVELOPMENT_WIRING }
  })
}
