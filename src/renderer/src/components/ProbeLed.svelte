<script lang="ts">
  import { PROBE_STATE_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import type { ProbeState } from '@shared/types'

  /**
   * A service's status light. It breathes while a check is in flight, and a service
   * that is down — or being re-checked because it just failed — sends out a ping.
   */
  let {
    state,
    rechecking = false,
    still = false,
    class: className
  }: {
    state: ProbeState
    rechecking?: boolean
    /** No breathing, no ping: nothing is happening, and nothing can be judged. */
    still?: boolean
    class?: string
  } = $props()

  const style = $derived(PROBE_STATE_STYLE[state])
  const ping = $derived(!still && (state === 'down' || rechecking))
</script>

<span class={cn('relative flex size-2 shrink-0', className)} aria-hidden="true">
  {#if ping}
    <span
      class={cn(
        'absolute inline-flex size-full animate-ping rounded-full opacity-60',
        rechecking ? 'bg-sev-investigating' : style.dot
      )}
    ></span>
  {/if}
  <span
    class={cn(
      'relative inline-flex size-2 rounded-full transition-[background-color,box-shadow] duration-500',
      style.dot,
      style.glow,
      state === 'pending' && !still && 'animate-pulse'
    )}
  ></span>
</span>
