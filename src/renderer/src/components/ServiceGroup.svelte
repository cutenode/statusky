<script lang="ts">
  import { isReachable } from '@shared/network'
  import type { ProbeGroup, ServiceProbe } from '@shared/types'
  import ServiceRow from './ServiceRow.svelte'

  let {
    id,
    title,
    blurb = null,
    services,
    now,
    expanded,
    highlighted,
    offline = false,
    ontoggle
  }: {
    /** Also the section's anchor, `#group-<id>`, which the dashboard's summary jumps to. */
    id: ProbeGroup
    title: string
    /** Shown under the title; only the control group needs explaining. */
    blurb?: string | null
    services: ServiceProbe[]
    now: number
    expanded: ReadonlySet<string>
    highlighted: string | null
    offline?: boolean
    ontoggle(serviceId: string): void
  } = $props()

  const answered = $derived(services.filter((service) => isReachable(service.state)).length)
  const measured = $derived(services.some((service) => service.state !== 'pending'))
</script>

<section class="mt-4" aria-labelledby="group-{id}">
  <div class="mb-1.5 flex items-baseline justify-between px-0.5">
    <h2
      id="group-{id}"
      class="text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
    >
      {title}
    </h2>
    {#if measured}
      <span class="text-[10.5px] text-muted-foreground tabular-nums">
        {answered}/{services.length}
      </span>
    {/if}
  </div>
  {#if blurb}
    <p class="-mt-1 mb-1.5 px-0.5 text-[10.5px] leading-snug text-muted-foreground/80">{blurb}</p>
  {/if}

  <div
    class="divide-y divide-border/45 overflow-hidden rounded-xl border border-border/60 bg-card/55 shadow-[0_1px_0_color-mix(in_oklch,var(--foreground)_3%,transparent)]"
  >
    {#each services as service (service.id)}
      <ServiceRow
        {service}
        {now}
        expanded={expanded.has(service.id)}
        highlighted={highlighted === service.id}
        {offline}
        ontoggle={() => ontoggle(service.id)}
      />
    {/each}
  </div>
</section>
