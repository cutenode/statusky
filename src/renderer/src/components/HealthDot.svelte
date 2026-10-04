<script lang="ts">
  import { HEALTH_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import type { Health } from '@shared/status'

  let {
    health,
    pulse = false,
    class: className
  }: { health: Health; pulse?: boolean; class?: string } = $props()

  const style = $derived(HEALTH_STYLE[health])
</script>

<span class={cn('relative flex size-2 shrink-0', className)}>
  {#if pulse && (health === 'incident' || health === 'monitoring')}
    <span
      class={cn(
        'absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping',
        style.dot
      )}
    ></span>
  {/if}
  <span class={cn('relative inline-flex size-2 rounded-full', style.dot, style.glow)}></span>
</span>
