import { resolve } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { DEVELOPMENT_WIRING } from './src/test/development-wiring'

const alias = {
  '@shared': resolve('src/shared'),
  '@ipc': resolve('src/ipc'),
  '@test': resolve('src/test'),
  $lib: resolve('src/renderer/src/lib'),
  '@components': resolve('src/renderer/src/components'),
  // Electron and its store cannot load outside an Electron process, so main- and
  // preload-process modules get behavioural doubles instead. See src/test/electron.ts.
  // `electron` alias-matches `electron/renderer` as a directory prefix, so the more
  // specific entry has to come first.
  'electron/renderer': resolve('src/test/electron-renderer.ts'),
  electron: resolve('src/test/electron.ts'),
  'electron-store': resolve('src/test/electron-store.ts'),
  // Not for want of an Electron process, unlike the three above: the real package is
  // CommonJS in node_modules, so Vitest loads it through Node and its own
  // `require('electron')` escapes the alias above and reaches the real one. See the
  // header of src/test/update-electron-app.ts.
  'update-electron-app': resolve('src/test/update-electron-app.ts')
}

const setup = resolve('src/test/setup.ts')

// Tests of the development IPC wiring. They sit beside the code they test, but only the
// `node-development` project may run them: under the production wiring they would fail.
const developmentTests = 'src/{main,preload,shared,test}/**/*.development.test.ts'

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        // Main process, preload bridge and shared logic: no DOM, real Node globals.
        resolve: { alias },
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          setupFiles: [setup],
          include: ['src/{main,preload,shared,test}/**/*.{test,spec}.ts'],
          exclude: [...configDefaults.exclude, developmentTests]
        }
      },
      {
        // The same ground as `node`, but against the development branch of the IPC origin
        // validator, which `npm test`'s production wiring in src/ipc does not contain.
        // `@ipc` points at wiring this project's global setup generates on every run.
        resolve: { alias: { ...alias, '@ipc': DEVELOPMENT_WIRING } },
        test: {
          name: 'node-development',
          globals: true,
          environment: 'node',
          globalSetup: [resolve('src/test/development-wiring.ts')],
          setupFiles: [setup],
          include: [developmentTests]
        }
      },
      {
        // Renderer: Svelte components compiled exactly the way the app compiles them.
        plugins: [svelte({ configFile: resolve('src/renderer/svelte.config.js'), hot: false })],
        resolve: { alias, conditions: ['browser'] },
        test: {
          name: 'renderer',
          globals: true,
          environment: 'jsdom',
          setupFiles: [setup, resolve('src/renderer/src/test/setup.ts')],
          include: ['src/renderer/**/*.{test,spec}.ts']
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/main/**/*.ts',
        'src/preload/**/*.ts',
        'src/shared/**/*.ts',
        'src/renderer/src/**/*.{ts,svelte}'
      ],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/*.d.ts',
        // The test harness itself, the vendored shadcn primitives, and the two-line
        // mount entrypoint: covered by the tests that use them, not worth a ratchet.
        'src/renderer/src/test/**',
        'src/renderer/src/lib/components/ui/**',
        'src/renderer/src/main.ts'
      ],
      // A floor, not a target: it should only ever move up.
      thresholds: {
        statements: 99.8,
        lines: 100,
        functions: 99.8,
        branches: 97.5
      }
    }
  }
})
