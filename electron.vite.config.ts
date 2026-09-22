import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import type { RollupLog } from 'rollup'
import type { Plugin } from 'vite'

const alias = { '@shared': resolve('src/shared'), '@ipc': resolve('src/ipc') }

/**
 * The generated IPC wiring imports its types with plain `import { Thing }` rather than
 * `import type`. esbuild erases them, so Rollup then reports each one as a missing
 * export from a module that, at runtime, exports nothing but functions. The warnings
 * are noise; a genuinely missing *value* export would still fail the type-check, which
 * runs before this.
 */
function quietGeneratedTypeImports(warning: RollupLog, warn: (warning: RollupLog) => void): void {
  if (warning.code === 'MISSING_EXPORT' && warning.id?.includes('/src/ipc/_internal/')) return
  warn(warning)
}

/**
 * The renderer's own `<meta>` tag carries the policy the packaged window runs under, and
 * it names no `worker-src`, so workers fall back to `script-src 'self'`.
 *
 * Vite's dev client wants one. When the HMR socket closes it polls for the server to
 * come back from inside a SharedWorker built out of a blob URL, and reloads the page
 * once the ping succeeds. Under the shipped policy that worker is blocked, the poll
 * rejects, and the reload after it never runs: the window keeps rendering but stops
 * taking updates, which is what "HMR just stopped working after a while" looks like from
 * the outside. It takes a restarted dev server or a slept machine to get there, which is
 * why it shows up in a long-running session and never on a fresh one.
 *
 * So the served copy gets the one extra source the dev client needs, and `apply: 'serve'`
 * keeps this out of `electron-vite build` — index.html on disk, and in the asar, still
 * carries the strict policy verbatim.
 */
export function allowDevServerWorkers(): Plugin {
  return {
    name: 'statusky:dev-server-csp',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replace(
          /(<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content=")([^"]*)"/,
          (_tag, lead: string, policy: string) => `${lead}${withBlobWorkers(policy)}"`
        )
    }
  }
}

/** The given policy with `worker-src` — however it arrived — set to what Vite needs. */
function withBlobWorkers(policy: string): string {
  const directives = policy
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive !== '' && !directive.startsWith('worker-src'))
  return [...directives, "worker-src 'self' blob:"].join('; ')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        onwarn: quietGeneratedTypeImports
      }
    }
  },
  preload: {
    // A sandboxed preload gets Electron's cut-down `require`, which cannot reach
    // node_modules at all — so anything the generated wiring pulls in (Zod, for the
    // payload validators) has to be bundled into the script itself.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        onwarn: quietGeneratedTypeImports
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        $lib: resolve('src/renderer/src/lib'),
        '@components': resolve('src/renderer/src/components'),
        ...alias
      }
    },
    plugins: [tailwindcss(), svelte(), allowDevServerWorkers()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
        onwarn: quietGeneratedTypeImports
      }
    }
  }
})
