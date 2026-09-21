<script lang="ts">
  import { cn } from '$lib/utils'
  import type { ProbeState } from '@shared/types'

  /**
   * One segment per service, coloured by what it last did. While a sweep runs, the
   * pending segments shimmer round the ring in order, and each one lights up as its
   * service answers — so the ring doubles as the sweep's progress.
   */
  let {
    states,
    reachable,
    total,
    dim = false,
    size = 68
  }: {
    states: ProbeState[]
    reachable: number
    total: number
    /** Offline or switched off: the numbers mean nothing, so fade them back to grey. */
    dim?: boolean
    size?: number
  } = $props()

  const STROKE: Record<ProbeState, string> = {
    pending: 'stroke-muted-foreground/25',
    live: 'stroke-sev-resolved',
    slow: 'stroke-sev-degraded',
    partial: 'stroke-sev-investigating',
    down: 'stroke-sev-outage'
  }

  const RADIUS = 28
  const CENTRE = 34
  /** Degrees left empty between two segments. */
  const GAP = 3

  function point(degrees: number): string {
    const radians = ((degrees - 90) * Math.PI) / 180
    return `${(CENTRE + RADIUS * Math.cos(radians)).toFixed(3)} ${(CENTRE + RADIUS * Math.sin(radians)).toFixed(3)}`
  }

  const segments = $derived.by(() => {
    const count = Math.max(states.length, 1)
    const span = 360 / count
    // A single service would be a closed circle, which an arc path cannot draw.
    const gap = count === 1 ? 0.01 : GAP
    return states.map((state, index) => {
      const start = index * span + gap / 2
      const end = (index + 1) * span - gap / 2
      const large = end - start > 180 ? 1 : 0
      return {
        state,
        d: `M ${point(start)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${point(end)}`,
        delay: `${Math.round((index / count) * 1200)}ms`
      }
    })
  })
</script>

<div
  class={cn('relative shrink-0 transition-opacity duration-500', dim && 'opacity-45')}
  style:width="{size}px"
  style:height="{size}px"
>
  <svg viewBox="0 0 68 68" class="size-full" aria-hidden="true">
    <circle cx={CENTRE} cy={CENTRE} r={RADIUS} class="fill-none stroke-muted/70" stroke-width="6" />
    {#each segments as segment, index (index)}
      <path
        d={segment.d}
        class={cn(
          'ring-segment fill-none transition-[stroke] duration-500',
          dim ? 'stroke-muted-foreground/35' : STROKE[segment.state],
          segment.state === 'pending' && !dim && 'pending'
        )}
        style:animation-delay={segment.delay}
        stroke-width="6"
      />
    {/each}
  </svg>
  <div class="absolute inset-0 flex flex-col items-center justify-center leading-none">
    <span class="text-[17px] font-semibold tracking-tight tabular-nums">{reachable}</span>
    <span class="mt-0.5 text-[9.5px] text-muted-foreground tabular-nums">of {total}</span>
  </div>
</div>

<style>
  .pending {
    animation: shimmer 1.2s ease-in-out infinite;
  }

  @keyframes shimmer {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pending {
      animation: none;
    }
  }
</style>
