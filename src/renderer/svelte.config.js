import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Every component in this app is written with runes.
    runes: true
  }
}
