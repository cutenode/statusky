// Serves the renderer alone for `preview.html`, on whatever port the preview pane
// assigns. Mirrors the renderer section of electron.vite.config.ts.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      $lib: resolve('src/renderer/src/lib'),
      '@components': resolve('src/renderer/src/components'),
      '@shared': resolve('src/shared'),
      '@ipc': resolve('src/ipc')
    }
  },
  plugins: [tailwindcss(), svelte()],
  server: { port: Number(process.env.PORT) || 5180, strictPort: true }
})
