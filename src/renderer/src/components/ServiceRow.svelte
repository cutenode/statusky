<script lang="ts">
  import { slide } from 'svelte/transition'
  import { PROBE_STATE_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import {
    SLOW_MS,
    checkDetail,
    describeFailure,
    formatLatency,
    humanDuration,
    isControl,
    splitHost
  } from '@shared/network'
  import type { ProbeCheck, ServiceProbe } from '@shared/types'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ProbeLed from './ProbeLed.svelte'
  import UptimeStrip from './UptimeStrip.svelte'

  let {
    service,
    now,
    expanded = false,
    highlighted = false,
    offline = false,
    ontoggle
  }: {
    service: ServiceProbe
    now: number
    expanded?: boolean
    /**
     * This machine is offline, so what the service "did" says nothing about it. Drawn
     * neutral rather than red — except the control checks, which are the evidence.
     */
    offline?: boolean
    /** Just revealed from a notification or a feed entry: draw the eye to it. */
    highlighted?: boolean
    ontoggle(): void
  } = $props()

  const muted = $derived(offline && !isControl(service))
  /**
   * Hobby and sandbox infrastructure, which publishes no uptime promise. It is measured
   * and filed like anything else, but it never reaches the header or the tray — so the
   * row says so, or a red light here would look like it had been ignored.
   */
  const community = $derived(service.tier === 'community')
  const style = $derived(PROBE_STATE_STYLE[service.state])
  const [head, tail] = $derived(
    // A service with a friendly name ("Discover feed") is not split like a hostname.
    service.label === service.host ? splitHost(service.host) : [service.label, '']
  )
  const passed = $derived(service.checks.filter((check) => check.ok === true).length)
  const settled = $derived(service.checks.filter((check) => check.ok !== null).length)

  /** Still waiting after the point where status.feeds.blue calls a service slow. */
  const waitingLong = $derived(
    service.state === 'pending' &&
      service.startedAt !== null &&
      now - Date.parse(service.startedAt) >= SLOW_MS
  )

  /** The one thing the collapsed row says on the right. */
  const verdict = $derived.by((): { text: string; tone: string } => {
    if (muted) return { text: 'No connection', tone: 'text-muted-foreground' }
    if (service.state === 'pending') {
      return {
        text: service.rechecking ? 'Re-checking…' : waitingLong ? 'Still waiting…' : 'Checking…',
        tone: 'text-muted-foreground'
      }
    }
    if (service.state === 'live') {
      return {
        text: service.latencyMs === null ? 'Live' : formatLatency(service.latencyMs),
        tone: 'text-muted-foreground'
      }
    }
    if (service.state === 'partial') {
      return { text: `${passed} of ${service.checks.length} passing`, tone: style.text }
    }
    if (service.state === 'slow' && service.latencyMs !== null) {
      return { text: `Slow · ${formatLatency(service.latencyMs)}`, tone: style.text }
    }
    return { text: style.label, tone: style.text }
  })

  /** Plain words for how long the service has been the way it is. */
  const conditionLine = $derived.by((): { text: string; tone: string } | null => {
    if (isControl(service)) {
      return { text: 'Control check: judges your connection', tone: 'text-muted-foreground' }
    }
    if (community && (service.condition === 'down' || service.condition === 'partial')) {
      const lasted = service.since ? now - Date.parse(service.since) : 0
      const span = lasted < 60_000 ? 'since just now' : `for ${humanDuration(lasted)}`
      const state = service.condition === 'down' ? 'Unreachable' : 'Partly failing'
      return { text: `${state} ${span} · best effort, so not counted`, tone: style.text }
    }
    if (muted) {
      return { text: 'Judged again once you are back online', tone: 'text-muted-foreground' }
    }
    if (service.rechecking) {
      return {
        text: 'Failed once. Re-checking before believing it',
        tone: 'text-sev-investigating'
      }
    }
    if (!service.since) return null
    const lasted = now - Date.parse(service.since)
    // The clock ticks every thirty seconds, so "for 0 seconds" is all a fresh change
    // could otherwise say.
    const span = lasted < 60_000 ? 'since just now' : `for ${humanDuration(lasted)}`
    switch (service.condition) {
      case 'down':
        return { text: `Unreachable ${span}`, tone: 'text-sev-outage' }
      case 'partial':
        return { text: `Partly failing ${span}`, tone: 'text-sev-investigating' }
      case 'up':
        return { text: `Answering ${span}`, tone: 'text-muted-foreground' }
      default:
        return null
    }
  })

  function result(check: ProbeCheck): { dot: string; duration: string } {
    const dot =
      check.ok === true
        ? 'bg-sev-resolved'
        : check.ok === false
          ? 'bg-sev-outage'
          : 'animate-pulse bg-muted-foreground/40'
    const duration =
      check.ok === null ? '…' : check.durationMs === null ? '—' : formatLatency(check.durationMs)
    return { dot, duration }
  }
</script>

<div
  class={cn('service-row transition-colors', highlighted && 'highlighted')}
  data-service={service.id}
>
  <button
    type="button"
    class="flex w-full items-center gap-2.5 px-3 py-[7px] text-left transition-colors hover:bg-accent/40"
    aria-expanded={expanded}
    onclick={ontoggle}
  >
    <ProbeLed
      state={muted ? 'pending' : service.state}
      rechecking={service.rechecking}
      still={muted}
    />
    <span class="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={service.host}>
      <span class="text-foreground">{head}</span><span class="text-muted-foreground/80">{tail}</span
      >
    </span>
    {#if community}
      <span
        class="shrink-0 rounded-sm bg-muted px-1 py-px text-[9.5px] tracking-wide text-muted-foreground uppercase"
        title="Community infrastructure: measured and filed, but never counted in the header or the tray"
      >
        community
      </span>
    {/if}
    <span data-verdict class={cn('shrink-0 text-[11px] tabular-nums', verdict.tone)}
      >{verdict.text}</span
    >
    <ChevronDown
      class={cn(
        'size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200',
        expanded && 'rotate-180'
      )}
    />
  </button>

  {#if expanded}
    <div class="px-3 pt-1 pb-3" in:slide={{ duration: 180 }}>
      <UptimeStrip history={service.history} />

      <ul class="mt-2.5 overflow-hidden rounded-lg bg-muted/45 py-1">
        {#each service.checks as check, index (index)}
          {@const { dot, duration } = result(check)}
          {@const detail = checkDetail(check)}
          {@const failure = check.error ? describeFailure(check.error) : null}
          <li class="px-2 py-[3px]" title={check.target ?? undefined}>
            <div class="flex items-center gap-2 text-[11px]">
              <span class={cn('size-1.5 shrink-0 rounded-full', dot)} aria-hidden="true"></span>
              <span class="shrink-0 font-mono text-foreground/90">{check.label}</span>
              {#if detail}
                <span class="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/75"
                  >{detail}</span
                >
              {/if}
              <span
                class={cn(
                  'ml-auto shrink-0 tabular-nums',
                  check.ok === true && (check.durationMs ?? 0) >= SLOW_MS
                    ? 'text-sev-degraded'
                    : 'text-muted-foreground'
                )}>{duration}</span
              >
            </div>
            {#if failure}
              <!-- Why it failed reads as the check's second line, wrapping rather than cut. -->
              <p
                data-failure
                title={check.durationMs === null
                  ? check.error
                  : `${check.error} · after ${duration}`}
                class="selectable pl-3.5 text-[10.5px] leading-snug text-pretty text-sev-outage/85"
              >
                {#if failure.code}<span class="font-mono font-medium text-sev-outage tabular-nums"
                    >{failure.code}</span
                  >{' '}{/if}{failure.text}
              </p>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="mt-2 flex items-center justify-between gap-2 text-[10.5px]">
        {#if conditionLine}
          <span class={conditionLine.tone}>{conditionLine.text}</span>
        {:else}
          <span></span>
        {/if}
        {#if service.checks.length}
          <span class="shrink-0 text-muted-foreground tabular-nums">
            {settled < service.checks.length
              ? `${settled} of ${service.checks.length} answered`
              : `${passed} of ${service.checks.length} passed`}
          </span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /* A revealed row glows once, so the eye lands on it after the scroll. */
  .highlighted {
    animation: reveal 1.8s ease-out;
  }

  @keyframes reveal {
    0%,
    30% {
      background: color-mix(in oklch, var(--primary) 16%, transparent);
    }
    100% {
      background: transparent;
    }
  }
</style>
