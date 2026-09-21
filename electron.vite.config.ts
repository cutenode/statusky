import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import type { RollupLog } from 'rollup'

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
    plugins: [tailwindcss(), svelte()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
        onwarn: quietGeneratedTypeImports
      }
    }
  }
})
