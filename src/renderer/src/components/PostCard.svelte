<script lang="ts">
  import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar'
  import { app } from '$lib/app-state.svelte'
  import { nav } from '$lib/nav.svelte'
  import { seen } from '$lib/seen.svelte'
  import { SEVERITY_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import { probeServiceId } from '@shared/network'
  import { absoluteTime, compactRelativeTime } from '@shared/time'
  import { sourceLabel } from '@shared/webhook'
  import type { StatusPost } from '@shared/types'
  import Activity from '@lucide/svelte/icons/activity'
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import ChevronsDown from '@lucide/svelte/icons/chevrons-down'
  import Radar from '@lucide/svelte/icons/radar'
  import EmbedCard from './EmbedCard.svelte'
  import RichText from './RichText.svelte'
  import SeverityBadge from './SeverityBadge.svelte'

  let { post, now }: { post: StatusPost; now: number } = $props()

  const style = $derived(SEVERITY_STYLE[post.severity])
  const unread = $derived(app.isUnread(post.uri))
  const initials = $derived(
    post.authorDisplayName
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase() || post.authorHandle.slice(0, 2).toUpperCase()
  )

  // A pushed update does not always carry a link back to the status page it came
  // from, and there is nothing to open when it does not.
  const link = $derived(post.url || null)
  /** An entry the network checks filed links back into the dashboard instead. */
  const serviceId = $derived(probeServiceId(post))

  function open(): void {
    app.openExternal(post.url)
    if (unread) void app.markRead([post.uri])
  }

  function reveal(): void {
    nav.reveal(serviceId)
    if (unread) void app.markRead([post.uri])
  }

  /**
   * Worth offering only when something older is still unread — on the oldest unread
   * post it would do exactly what clicking it does, and on a read post, nothing.
   */
  const canReadThrough = $derived(app.hasUnreadBelow(post))

  const actionClass = $derived(
    cn(
      'shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-all',
      'group-hover:opacity-100 hover:bg-background/70 hover:text-foreground focus-visible:opacity-100',
      // Whichever control comes first pushes the run of them to the right edge; the
      // unread dot takes that job when it is showing.
      unread || canReadThrough ? 'ml-1.5' : 'ml-auto'
    )
  )
</script>

<article
  use:seen={post.uri}
  class={cn(
    'group relative flex gap-2.5 rounded-lg py-2.5 pr-2 pl-3 transition-colors',
    'hover:bg-accent/45',
    unread && 'bg-primary/[0.055]'
  )}
>
  <!-- Severity rail: the fastest signal when scanning a long feed. -->
  <span
    class={cn(
      'absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full transition-opacity',
      style.rail,
      unread ? 'opacity-100' : 'opacity-45'
    )}
    aria-hidden="true"
  ></span>

  {#if serviceId}
    <!-- Measured, not posted: no face to show, so the tile wears the entry's colour. -->
    <span
      class={cn(
        'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full',
        style.bg,
        style.text
      )}
      aria-hidden="true"
    >
      <Activity class="size-3.5" strokeWidth={2.25} />
    </span>
  {:else}
    <Avatar class="mt-0.5 size-7">
      {#if post.authorAvatar}
        <AvatarImage src={post.authorAvatar} alt="" referrerpolicy="no-referrer" />
      {/if}
      <AvatarFallback>{initials}</AvatarFallback>
    </Avatar>
  {/if}

  <div class="min-w-0 flex-1">
    <div class="mb-1 flex items-center gap-1.5">
      <SeverityBadge severity={post.severity} />
      <span class="truncate text-[11.5px] font-medium text-muted-foreground"
        >{sourceLabel(post.authorDid, post.authorHandle)}</span
      >
      <span class="text-muted-foreground/40" aria-hidden="true">·</span>
      <time
        class="shrink-0 text-[11.5px] text-muted-foreground tabular-nums"
        datetime={post.createdAt}
        title={absoluteTime(post.createdAt)}>{compactRelativeTime(post.createdAt, now)}</time
      >

      {#if unread}
        <span
          class="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
          title="Unread"
          aria-label="Unread"
        ></span>
      {/if}

      {#if canReadThrough}
        <button
          type="button"
          onclick={() => void app.markReadThrough(post.uri)}
          title="Mark this and everything older as read"
          aria-label="Mark this and everything older as read"
          class={cn(actionClass, !unread && 'ml-auto')}
        >
          <ChevronsDown class="size-3.5" />
        </button>
      {/if}

      {#if serviceId}
        <button
          type="button"
          onclick={reveal}
          title="Show on the network dashboard"
          aria-label="Show on the network dashboard"
          class={actionClass}
        >
          <Radar class="size-3.5" />
        </button>
      {:else if link}
        <button
          type="button"
          onclick={open}
          title="Open the original"
          aria-label="Open the original"
          class={actionClass}
        >
          <ArrowUpRight class="size-3.5" />
        </button>
      {/if}
    </div>

    <RichText segments={post.segments} text={post.text} />

    {#if post.embed}
      <EmbedCard embed={post.embed} />
    {/if}
  </div>
</article>
