<script lang="ts">
  import { PROBE_STATE_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import { HISTORY_LENGTH, formatLatency, uptimePercent } from '@shared/network'
  import type { ProbeSample } from '@shared/types'

  /**
   * The service's recent history: one bar per observation, newest on the right. Colour
   * is what the observation found; height is how long it took, so a service getting
   * slower shows up before it starts failing. A failure fills the bar.
   */
  let { history }: { history: ProbeSample[] } = $props()

  const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

  const slots = $derived.by(() => {
    const recent = history.slice(-HISTORY_LENGTH)
    const slowest = Math.max(1, ...recent.map((sample) => sample.latencyMs ?? 0))
    const bars = recent.map((sample) => {
      const failed = sample.state === 'down' || sample.state === 'partial'
      const ratio = failed || sample.latencyMs === null ? 1 : sample.latencyMs / slowest
      const at = Date.parse(sample.at)
      return {
        sample,
        height: `${Math.round(30 + ratio * 70)}%`,
        title: [
          Number.isNaN(at) ? null : timeFormat.format(at),
          PROBE_STATE_STYLE[sample.state].label,
          sample.latencyMs === null ? null : formatLatency(sample.latencyMs)
        ]
          .filter(Boolean)
          .join(' · ')
      }
    })
    return [...Array.from({ length: HISTORY_LENGTH - bars.length }, () => null), ...bars]
  })

  const uptime = $derived(uptimePercent(history))
</script>

<div>
  <div class="flex h-5 items-end gap-[2px]" role="img" aria-label="Recent checks">
    {#each slots as slot, index (index)}
      {#if slot}
        <span
          class={cn(
            'min-w-0 flex-1 rounded-[2px] transition-[height] duration-500',
            PROBE_STATE_STYLE[slot.sample.state].bar
          )}
          style:height={slot.height}
          title={slot.title}
        ></span>
      {:else}
        <span class="h-[3px] min-w-0 flex-1 rounded-[2px] bg-muted"></span>
      {/if}
    {/each}
  </div>
  <div class="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
    <span>
      {history.length
        ? `Last ${Math.min(history.length, HISTORY_LENGTH)} check${history.length === 1 ? '' : 's'}`
        : 'No history yet'}
    </span>
    {#if uptime !== null}
      <span>{uptime}% answered</span>
    {/if}
  </div>
</div>
