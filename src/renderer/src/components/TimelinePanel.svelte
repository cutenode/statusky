<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from '$lib/app-state.svelte'
  import { nav } from '$lib/nav.svelte'
  import { dayLabel } from '@shared/time'
  import type { StatusPost } from '@shared/types'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import EmptyState from './EmptyState.svelte'
  import TimelineRow from './TimelineRow.svelte'

  /**
   * The tab the popover opens on: every source merged back into one chronology, with
   * what you have not read at the top of it.
   *
   * The menu bar asked you to look at something. This is that something — one stop per
   * update, no filters to set and no decisions to make. Feed and Network are where you
   * go when you want to browse by source; this is where you land when you were
   * summoned, and it keeps reading downwards into what you have already seen.
   *
   * It is also the only place a pushed delivery or a network finding is listed. Those
   * are machine-filed and terse — a named service moved between states — so a tab of
   * their own said nothing this one does not.
   *
   * **Opening it is reading it.** Everything unread is marked read the moment the tab
   * appears, and again whenever the popover is brought back to the front, which for a
   * menu bar app is the same gesture without a remount. That is unconditional: the
   * Settings › Feed *Mark as read* preference governs the Feed tab, where you are
   * browsing rather than being caught up.
   *
   * Which means the top section has to survive its own catch-up. Letting the batch fall
   * into **Read** the instant it is marked would empty the section out from under the
   * person reading it and leave the thing they were summoned for nowhere near the top,
   * so what was unread when the tab opened is held in `held` and stays above the line
   * for as long as the tab does. Anything that arrives afterwards joins it live — still
   * genuinely unread, and wearing a dot to say so — and is swept into `held` at the next
   * catch-up. The batch drops into **Read** on the next visit, when it is behind you.
   *
   * `held` is this component's, so leaving for another tab and coming back drops the
   * last batch into Read. That is the honest answer: you did read it.
   */
  let { now }: { now: number } = $props()

  /** URIs the top section is committed to showing, whatever their read state became. */
  let held = $state(new Set<string>())

  function caughtUp(): void {
    const unread = app.unreadUris
    if (!unread.length) return
    held = new Set([...held, ...unread])
    void app.markAllRead()
  }

  onMount(() => {
    caughtUp()
    window.addEventListener('focus', caughtUp)
    return () => window.removeEventListener('focus', caughtUp)
  })

  /**
   * Held from the catch-up, plus anything unread right now — the second clause is what
   * makes an incident arriving while you watch appear at the top instead of waiting for
   * a refocus.
   */
  const unread = $derived(app.posts.filter((post) => held.has(post.uri) || app.isUnread(post.uri)))
  /** Everything behind you: read before this visit, and read in the strictest sense. */
  const read = $derived(app.posts.filter((post) => !held.has(post.uri) && !app.isUnread(post.uri)))

  /** Break a section into date groups, the same way the other tabs do. */
  function byDay(posts: StatusPost[]): { label: string; posts: StatusPost[] }[] {
    const out: { label: string; posts: StatusPost[] }[] = []
    for (const post of posts) {
      const label = dayLabel(post.createdAt, now)
      const last = out.at(-1)
      if (last?.label === label) last.posts.push(post)
      else out.push({ label, posts: [post] })
    }
    return out
  }
</script>

{#snippet heading(title: string, count: number | null, quiet: boolean)}
  <!--
    The section is what sticks here, where the other tabs stick the day. With two of
    them, which side of the line you are reading is the thing worth keeping on screen,
    and only one bar can hold the top: the popover is glass, so a second one stacked
    under it would show the first through the blur rather than cover it. The dates go
    back to being plain markers on the thread, which is where they read best anyway.
  -->
  <div
    class="sticky top-0 z-20 -mx-2 mb-1 flex items-center gap-2 px-4 pt-1.5 pb-1.5 backdrop-blur-md"
  >
    <h2
      class="text-[11px] font-semibold tracking-[0.09em] uppercase {quiet
        ? 'text-muted-foreground'
        : 'text-foreground/85'}"
    >
      {title}
    </h2>
    {#if count !== null}
      <span
        class="rounded-full bg-primary/14 px-1.5 py-px text-[10px] font-semibold text-primary tabular-nums"
        >{count}</span
      >
    {/if}
    <span class="h-px flex-1 bg-gradient-to-r from-border/70 to-transparent"></span>
  </div>
{/snippet}

{#snippet section(title: string, posts: StatusPost[], count: number | null, quiet: boolean)}
  {@render heading(title, count, quiet)}
  {#each byDay(posts) as group, index (group.label)}
    <!-- A marker on the thread rather than a bar across it: the date is an aside. -->
    <div class={index === 0 ? 'mb-1 pl-8' : 'mt-2.5 mb-1 pl-8'}>
      <h3 class="text-[10px] font-semibold tracking-[0.11em] text-muted-foreground uppercase">
        {group.label}
      </h3>
    </div>
    <!-- A hair of daylight between washed rows, so two of them do not read as one
         block. The thread breaks by the same two pixels, which at one pixel wide and
         a fading grey is not a thing the eye finds. -->
    <div class="flex flex-col gap-0.5">
      {#each group.posts as post, row (post.uri)}
        <TimelineRow {post} {now} dimmed={quiet} last={row === group.posts.length - 1} />
      {/each}
    </div>
  {/each}
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-4">
    {#if !unread.length && !read.length}
      <EmptyState
        icon={CircleCheck}
        title="All caught up"
        description="Nothing new since you last looked. Anything that arrives will show up here first."
      >
        {#snippet action()}
          <button
            type="button"
            onclick={() => nav.open('feed')}
            class="rounded-md px-2 py-1 text-[11.5px] font-medium text-primary transition-colors hover:bg-primary/10"
            >Browse the feed</button
          >
        {/snippet}
      </EmptyState>
    {:else}
      {#if unread.length}
        {@render section('Unread', unread, unread.length, false)}
      {:else}
        <!-- Said rather than left out: being caught up is the answer you came for. -->
        {@render heading('Unread', null, false)}
        <div class="mb-1 flex items-center gap-2 px-2 py-1.5 pl-3.5">
          <CircleCheck class="size-3.5 shrink-0 text-sev-resolved" />
          <p class="text-[11.5px] text-muted-foreground">All caught up.</p>
        </div>
      {/if}

      {#if read.length}
        <div class="mt-3">
          {@render section('Read', read, null, true)}
        </div>
      {/if}
    {/if}
  </div>
</div>
