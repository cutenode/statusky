<script lang="ts">
  /**
   * The provider context `App.svelte` establishes around the whole UI. Component
   * tests render through this so a component that uses a tooltip behaves in the
   * test exactly as it does in the app.
   */
  import type { Snippet } from 'svelte'
  import { TooltipProvider } from '$lib/components/ui/tooltip'

  let { children }: { children: Snippet } = $props()
</script>

<TooltipProvider delayDuration={0}>
  {@render children()}
</TooltipProvider>
