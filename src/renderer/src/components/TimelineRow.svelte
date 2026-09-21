<script lang="ts">
  import { app } from '$lib/app-state.svelte'
  import { nav } from '$lib/nav.svelte'
  import { SEVERITY_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import { probeServiceId } from '@shared/network'
  import { SEVERITY_LABEL } from '@shared/status'
  import { absoluteTime, compactRelativeTime } from '@shared/time'
  import { sourceLabel } from '@shared/webhook'
  import type { StatusPost } from '@shared/types'
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import Radar from '@lucide/svelte/icons/radar'

  /**
   * One stop on the timeline: a severity node on the spine, who and when beside it,
   * and the first two lines of what.
   *
   * Deliberately less than a `PostCard` — no avatar, no rich text, no embed, no
   * per-post read controls. This view exists to be read in one pass, so everything
   * that invites you to linger on a single update belongs in Feed or Alerts instead.
   * What survives is what tells you whether to care: the colour, the source and enough
   * prose to recognise the incident.
   *
   * The severity is drawn twice on purpose, and neither is redundant. The node is what
   * you scan — a colour and a glyph at a fixed x, so a column of them reads as a shape
   * before it reads as words. The word is what you land on once something has caught
   * you, because `outage` and `degraded` are the same red at a glance and the app went
   * to some trouble to tell them apart. So the node is loud and the word is quiet,
   * rather than the two of them competing at the same volume.
   */
  let {
    post,
    now,
    dimmed = false,
    last = false
  }: {
    post: StatusPost
    now: number
    /** Below the line: read before this visit, so it recedes rather than competes. */
    dimmed?: boolean
    /** The spine stops at the last stop of a day; it is a thread, not a border. */
    last?: boolean
  } = $props()

  const style = $derived(SEVERITY_STYLE[post.severity])
  const Icon = $derived(style.icon)
  /** An entry the network checks filed opens the dashboard rather than a web page. */
  const serviceId = $derived(probeServiceId(post))
  /** A pushed update does not always carry a link back to the page it came from. */
  const link = $derived(serviceId ? null : post.url || null)
  /**
   * Still unread means it landed after this view caught up — while the popover was
   * open, in front of you. Everything else above the line was read the moment the tab
   * appeared, and everything below it before this visit.
   */
  const unread = $derived(app.isUnread(post.uri))

  const label = $derived(
    serviceId
      ? `${SEVERITY_LABEL[post.severity]}: ${post.text} — show on the network dashboard`
      : `${SEVERITY_LABEL[post.severity]}: ${post.text} — open the original`
  )

  function activate(): void {
    if (serviceId) nav.reveal(serviceId)
    else if (link) app.openExternal(link)
    else return
    if (unread) void app.markRead([post.uri])
  }

  const interactive = $derived(!!(serviceId || link))

  const rowClass = $derived(
    cn(
      'group relative flex w-full gap-2.5 rounded-xl px-2 py-2 text-left',
      'transition-[background-color,box-shadow] duration-150',
      // Above the line a row carries a breath of its own severity, below it nothing:
      // the quietest way to make the two halves feel different, and it costs no border.
      !dimmed && style.wash,
      interactive && 'hover:bg-accent/40 focus-visible:bg-accent/40'
    )
  )
</script>

{#snippet body()}
  <!--
    The gutter: the node, and the thread running on to the next stop. Drawn per row
    rather than as one line behind the section, because the node has to sit *on* the
    thread and every surface here is translucent — a line behind a tinted disc shows
    straight through it.
  -->
  <span class="relative -my-2 flex w-5 shrink-0 flex-col items-center pt-2" aria-hidden="true">
    <span
      class={cn(
        'flex size-5 items-center justify-center rounded-full ring-1 transition-shadow duration-150',
        style.bg,
        style.ring,
        // A lit node for something still unread, the way the dashboard lights an LED.
        unread && style.glow,
        // The one place read is allowed to fade: the node is decorative, and the word
        // beside it says the same thing in text at full strength.
        dimmed && 'opacity-65'
      )}
    >
      <Icon class={cn('size-[11px]', style.text)} />
    </span>
    {#if !last}
      <span class="mt-1 w-px flex-1 rounded-full bg-gradient-to-b from-border to-border/30"></span>
    {/if}
  </span>

  <div class="min-w-0 flex-1 pb-0.5">
    <div class="flex items-baseline gap-1.5">
      <span class={cn('shrink-0 text-[10px] font-semibold tracking-[0.04em] uppercase', style.text)}
        >{SEVERITY_LABEL[post.severity]}</span
      >
      <span class="truncate text-[11.5px] text-muted-foreground"
        >{sourceLabel(post.authorDid, post.authorHandle)}</span
      >

      <span class="ml-auto flex shrink-0 items-center gap-1.5">
        {#if unread}
          <span
            class="size-1.5 rounded-full bg-primary shadow-[0_0_0_2.5px_color-mix(in_oklch,var(--primary)_22%,transparent)]"
            title="Unread"
            aria-label="Unread"
          ></span>
        {/if}
        <time
          class="text-[11px] text-muted-foreground tabular-nums"
          datetime={post.createdAt}
          title={absoluteTime(post.createdAt)}>{compactRelativeTime(post.createdAt, now)}</time
        >
        {#if interactive}
          <span
            class={cn(
              'text-muted-foreground opacity-0 transition-opacity duration-150',
              'group-hover:opacity-100 group-focus-visible:opacity-100'
            )}
            aria-hidden="true"
          >
            {#if serviceId}
              <Radar class="size-3.5" />
            {:else}
              <ArrowUpRight class="size-3.5" />
            {/if}
          </span>
        {/if}
      </span>
    </div>

    <p
      class={cn(
        'mt-1 line-clamp-2 text-[12.5px] leading-snug',
        dimmed ? 'text-foreground/65' : 'text-foreground/90'
      )}
    >
      {post.text}
    </p>
  </div>
{/snippet}

{#if interactive}
  <button type="button" onclick={activate} aria-label={label} class={rowClass}>
    {@render body()}
  </button>
{:else}
  <div class={rowClass}>{@render body()}</div>
{/if}
