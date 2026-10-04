<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { app } from '$lib/app-state.svelte'
  import { Refusals } from '$lib/requests.svelte'
  import { cn } from '$lib/utils'
  import { PROBE_GROUPS, formatLatency, isControl, isReachable } from '@shared/network'
  import { sinceTime } from '@shared/time'
  import type { ProbeGroup } from '@shared/types'
  import Power from '@lucide/svelte/icons/power'
  import WifiOff from '@lucide/svelte/icons/wifi-off'
  import ReachabilityRing from './ReachabilityRing.svelte'
  import Refused from './Refused.svelte'

  let { now, onjump }: { now: number; onjump(group: ProbeGroup): void } = $props()

  const snapshot = $derived(app.snapshot)
  const summary = $derived(app.network)
  const enabled = $derived(app.settings.networkChecks)
  const atmosphere = $derived(snapshot.services.filter((service) => !isControl(service)))
  const measured = $derived(snapshot.finishedAt !== null)

  /**
   * How many of the Atmosphere are answering, counted from the snapshot rather than
   * taken from the rollup. The rollup is only recomputed when a sweep starts and
   * finishes, so a ring reading off it would sit at the starting zero for the whole
   * sweep and then jump — while the rows and the group tallies below, which are counted
   * this way, are already lighting up one by one. The ring has to agree with them.
   */
  const reachable = $derived(atmosphere.filter((service) => isReachable(service.state)).length)

  /** Requests settled out of those started, for the progress bar while a sweep runs. */
  const progress = $derived.by(() => {
    const checks = snapshot.services.flatMap((service) => service.checks)
    const settled = checks.filter((check) => check.ok !== null).length
    return { settled, total: checks.length }
  })

  /**
   * Observed failing, but not confirmed yet: the monitor is re-checking them.
   *
   * Only what is being re-checked. A failure already confirmed in a panel that does not
   * count — `summary.uncounted` — is red on its row too, and counted in here it read as
   * "Re-checking" for as long as the outage lasted, which nothing was.
   */
  const suspect = $derived(atmosphere.filter((s) => s.rechecking).length)
  const uncounted = $derived(summary.uncounted)

  const medianLatency = $derived.by(() => {
    const times = atmosphere
      .map((service) => service.latencyMs)
      .filter((ms): ms is number => ms !== null)
      .toSorted((a, b) => a - b)
    return times.length ? times[times.length >> 1]! : null
  })

  type Tone = 'good' | 'warn' | 'bad' | 'quiet'

  const verdict = $derived.by((): { title: string; tone: Tone } => {
    if (!enabled) return { title: 'Network checks are off', tone: 'quiet' }
    if (snapshot.offline) return { title: 'You’re offline', tone: 'quiet' }
    if (summary.down.length) {
      return {
        title:
          summary.down.length === 1
            ? `${summary.down[0]} is unreachable`
            : `${summary.down.length} services unreachable`,
        tone: 'bad'
      }
    }
    if (summary.degraded.length) {
      return {
        title:
          summary.degraded.length === 1
            ? `${summary.degraded[0]} is degraded`
            : `${summary.degraded.length} services degraded`,
        tone: 'warn'
      }
    }
    if (!measured) {
      return {
        title: snapshot.running ? 'Checking the Atmosphere…' : 'Not checked yet',
        tone: 'quiet'
      }
    }
    if (suspect) {
      return {
        title: `Re-checking ${suspect} service${suspect === 1 ? '' : 's'}`,
        tone: 'warn'
      }
    }
    // Said, but quietly: left out of the menu bar, so not an alarm here either.
    if (uncounted.length) {
      return {
        title:
          uncounted.length === 1
            ? `${uncounted[0]} is failing, not counted`
            : `${uncounted.length} uncounted services failing`,
        tone: 'quiet'
      }
    }
    return { title: 'The Atmosphere is reachable', tone: 'good' }
  })

  const detail = $derived.by((): string => {
    if (!enabled) {
      return 'Turn them on to measure relays, PDSes and AppViews from this computer.'
    }
    if (snapshot.offline) {
      return 'None of the control checks got through, so nothing else can be judged. Checking again as soon as the connection is back.'
    }
    if (snapshot.running) {
      return progress.total
        ? `Checking… ${progress.settled} of ${progress.total} requests answered`
        : 'Starting…'
    }
    if (!measured) return 'Measures every service from this computer.'
    const parts = [`${reachable} of ${atmosphere.length} answering`]
    if (medianLatency !== null) parts.push(`median ${formatLatency(medianLatency)}`)
    return parts.join(' · ')
  })

  /**
   * What the machine's own condition is doing to the sweep schedule, in a few words.
   *
   * Without it, a dashboard last measured forty minutes ago under a ten-minute setting
   * reads as the app having quietly stopped working, rather than as it deliberately
   * staying out of the way of a laptop on battery or a machine that is too hot to
   * measure anything honestly from.
   */
  const restraint = $derived.by((): string | null => {
    switch (snapshot.restraint) {
      case 'battery':
        return 'Checking less often on battery'
      case 'thermal':
        return 'Paused while this machine is under load'
      default:
        return null
    }
  })

  /**
   * The quiet line under the detail: when the sweep last finished, and why it may not be
   * running as often as the setting says. Joined, so no separator is ever left dangling.
   */
  const meta = $derived.by((): string => {
    const parts: string[] = []
    if (snapshot.finishedAt) parts.push(`Checked ${sinceTime(snapshot.finishedAt, now)}`)
    if (restraint) parts.push(restraint)
    return parts.join(' · ')
  })

  const TONE: Record<Tone, { wash: string; title: string }> = {
    good: {
      wash: 'from-sev-resolved/14',
      title: 'text-foreground'
    },
    warn: {
      wash: 'from-sev-investigating/16',
      title: 'text-sev-investigating'
    },
    bad: {
      wash: 'from-sev-outage/18',
      title: 'text-sev-outage'
    },
    quiet: {
      wash: 'from-muted-foreground/10',
      title: 'text-foreground'
    }
  }

  const tone = $derived(TONE[verdict.tone])

  /**
   * What a screen reader is told, and when: once as a sweep starts, and once with the
   * verdict when it is over. The progress line changes with every answer, several times
   * a second through a sweep, and announced as it went it drowned out everything else.
   */
  const announcement = $derived(
    snapshot.running ? 'Checking the Atmosphere…' : `${verdict.title}. ${detail}`
  )

  /** Why main would not switch the checks on, said under the button that asked. */
  const refusals = new Refusals()

  /**
   * Each Atmosphere group's tally, doubling as a way to jump down the list. The control
   * group is left out, as it is from the ring: it measures the user, not the network.
   */
  const groups = $derived(
    PROBE_GROUPS.filter((group) => group.id !== 'internet')
      .map(({ id, title }) => {
        const services = snapshot.services.filter((service) => service.group === id)
        const up = services.filter((service) => isReachable(service.state)).length
        const failing = services.some((s) => s.state === 'down' || s.state === 'partial')
        return { id, title, up, count: services.length, failing }
      })
      .filter((group) => group.count > 0)
  )
</script>

<section
  class={cn(
    'relative overflow-hidden rounded-xl border border-border/60 bg-card/60 bg-gradient-to-br via-transparent to-transparent p-3',
    tone.wash
  )}
>
  <div class="flex items-center gap-3.5">
    <ReachabilityRing
      states={atmosphere.map((service) => service.state)}
      reachable={measured || snapshot.running ? reachable : 0}
      total={atmosphere.length}
      dim={!enabled || snapshot.offline}
    />

    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5">
        {#if snapshot.offline}
          <WifiOff class="size-3.5 shrink-0 text-muted-foreground" />
        {/if}
        <h2 class={cn('truncate text-[14px] leading-tight font-semibold', tone.title)}>
          {verdict.title}
        </h2>
      </div>
      <p class="mt-1 text-[11.5px] leading-snug text-muted-foreground">
        {detail}
      </p>
      {#if enabled && !snapshot.running && !snapshot.offline && meta}
        <p class="mt-0.5 truncate text-[10.5px] text-muted-foreground/80">{meta}</p>
      {/if}
    </div>

    <!--
      The only action here is switching the checks back on. Measuring again is the
      header's refresh button, which means exactly that while this tab is open — a
      second control for it would sit a few pixels below the first.
    -->
    {#if !enabled}
      <Button
        size="sm"
        class="shrink-0"
        onclick={() => void refusals.track('enable', app.patchSettings({ networkChecks: true }))}
      >
        <Power class="size-3.5" />
        Turn on
      </Button>
    {/if}
  </div>
  <Refused class="pt-2 pb-0" text={refusals.of('enable')} />
  <p class="sr-only" aria-live="polite">{announcement}</p>

  {#if enabled && groups.length}
    <div class="mt-2.5 flex flex-wrap gap-1">
      {#each groups as group (group.id)}
        <button
          type="button"
          onclick={() => onjump(group.id)}
          class={cn(
            'flex items-center gap-1 rounded-full border border-border/60 bg-background/35 px-1.5 py-[1px] text-[10px] transition-colors hover:bg-accent/60',
            group.failing && !snapshot.offline ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          <span
            class={cn(
              'size-1.5 rounded-full',
              snapshot.offline
                ? 'bg-muted-foreground/40'
                : group.failing
                  ? 'bg-sev-outage'
                  : group.up === group.count
                    ? 'bg-sev-resolved'
                    : 'bg-muted-foreground/40'
            )}
            aria-hidden="true"
          ></span>
          {group.id === 'infrastructure' ? 'Infra' : group.title}
          <span class="tabular-nums opacity-75">{group.up}/{group.count}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if snapshot.running && progress.total}
    <div class="absolute inset-x-0 bottom-0 h-[2px] bg-border/40" aria-hidden="true">
      <div
        class="progress h-full bg-primary transition-[width] duration-300 ease-out"
        style:width="{Math.round((progress.settled / progress.total) * 100)}%"
      ></div>
    </div>
  {/if}
</section>

<style>
  .progress {
    background-image: linear-gradient(
      90deg,
      transparent,
      color-mix(in oklch, white 45%, transparent),
      transparent
    );
    background-size: 60px 100%;
    background-repeat: no-repeat;
    animation: sheen 1.1s linear infinite;
  }

  /* The bar still fills as answers come in; only the shine running along it stops. */
  @media (prefers-reduced-motion: reduce) {
    .progress {
      animation: none;
    }
  }

  @keyframes sheen {
    from {
      background-position: -60px 0;
    }
    to {
      background-position: calc(100% + 60px) 0;
    }
  }
</style>
