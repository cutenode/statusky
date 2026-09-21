<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { app } from '$lib/app-state.svelte'
  import { nav } from '$lib/nav.svelte'
  import { PROBE_GROUPS } from '@shared/network'
  import type { ProbeGroup } from '@shared/types'
  import NetworkHero from './NetworkHero.svelte'
  import ServiceGroup from './ServiceGroup.svelte'

  let { now }: { now: number } = $props()

  let scroller = $state<HTMLElement | null>(null)
  const expanded = new SvelteSet<string>()
  let highlighted = $state<string | null>(null)

  const groups = $derived(
    PROBE_GROUPS.map(({ id, title, blurb }) => ({
      id,
      title,
      blurb,
      services: app.snapshot.services.filter((service) => service.group === id)
    })).filter((group) => group.services.length > 0)
  )

  function toggle(serviceId: string): void {
    if (expanded.has(serviceId)) expanded.delete(serviceId)
    else expanded.add(serviceId)
  }

  function jump(group: ProbeGroup): void {
    scroller
      ?.querySelector(`#group-${group}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // A notification, a feed entry or an account row asked for one service: open it,
  // bring it into view and make it glow once.
  $effect(() => {
    if (!nav.pending) return
    const { serviceId } = untrack(() => nav.takeReveal())!
    if (!serviceId) {
      scroller?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    expanded.add(serviceId)
    highlighted = serviceId
    void tick().then(() => {
      const row = [...(scroller?.querySelectorAll('[data-service]') ?? [])].find(
        (element) => element.getAttribute('data-service') === serviceId
      )
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    setTimeout(() => {
      if (highlighted === serviceId) highlighted = null
    }, 1800)
  })
</script>

<div bind:this={scroller} class="scroll-thin h-full min-h-0 overflow-y-auto px-3 pb-4">
  <NetworkHero {now} onjump={jump} />

  {#if app.settings.networkChecks}
    {#each groups as group (group.id)}
      <ServiceGroup
        id={group.id}
        title={group.title}
        blurb={group.id === 'internet' ? group.blurb : null}
        services={group.services}
        {now}
        {expanded}
        {highlighted}
        offline={app.snapshot.offline}
        ontoggle={toggle}
      />
    {/each}

    <p class="mt-4 px-1 text-center text-[10.5px] leading-relaxed text-muted-foreground/85">
      Every request leaves from this computer, so it measures your own connection to each service.
      Checks and catalogue from
      <button
        type="button"
        class="underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
        onclick={() => app.openExternal('https://status.feeds.blue')}>status.feeds.blue</button
      >
      by Kuba Suder.
    </p>
  {/if}
</div>
