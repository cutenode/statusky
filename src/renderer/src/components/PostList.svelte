<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from '$lib/app-state.svelte'
  import { flushSeen } from '$lib/seen.svelte'
  import { cn } from '$lib/utils'
  import { groupByDay } from '$lib/days'
  import { sourceLabel } from '@shared/webhook'
  import type { Account, StatusPost } from '@shared/types'
  import type { LucideIcon } from '@lucide/svelte'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import EmptyState from './EmptyState.svelte'
  import PostCard from './PostCard.svelte'

  /**
   * A chronology of full cards over one slice of the feed, with a chip per source to
   * filter it. `Feed` is what hands it the status accounts; it stays separate from that
   * tab because the browsing behaviour — filter chips, the `markReadOn` setting, the
   * seen-while-scrolling flush — is the part with rules, and the tab is just a slice
   * and an empty state.
   */
  let {
    now,
    posts,
    accounts,
    emptyIcon,
    emptyTitle,
    emptyDescription
  }: {
    now: number
    posts: StatusPost[]
    accounts: Account[]
    emptyIcon: LucideIcon
    emptyTitle: string
    emptyDescription: string
  } = $props()

  /**
   * The `open` setting: showing a tab is taken as having read what is in it. That
   * covers the tab being opened and being switched back to, because both mount this
   * component — and again whenever the popover is brought back to the front, which for
   * a menu bar app is the same gesture without a remount.
   *
   * Only this tab's own posts are read, not the whole feed: opening Feed should not
   * quietly clear an unread network finding you have not looked at. The Timeline, which
   * shows everything, is the one that catches you up on everything.
   *
   * `seen` flushes on the way out instead: whatever scrolled past in the last few
   * hundred milliseconds should not be lost because the popover was dismissed.
   */
  function caughtUp(): void {
    if (app.settings.markReadOn !== 'open') return
    const unread = posts.filter((post) => app.isUnread(post.uri)).map((post) => post.uri)
    if (unread.length) void app.markRead(unread)
  }

  onMount(() => {
    caughtUp()
    window.addEventListener('focus', caughtUp)
    return () => {
      window.removeEventListener('focus', caughtUp)
      flushSeen()
    }
  })

  type Filter = 'all' | 'unread'
  let filter = $state<Filter>('all')
  /** DID of the account being filtered to, or null for every account. */
  let accountFilter = $state<string | null>(null)

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'unread', label: 'Unread' }
  ]

  /** Unread within this tab, which is what its own Unread filter counts. */
  const unreadHere = $derived(posts.filter((post) => app.isUnread(post.uri)).length)

  const filtered = $derived(
    posts.filter((post) => {
      if (accountFilter && post.authorDid !== accountFilter) return false
      if (filter === 'unread') return app.isUnread(post.uri)
      return true
    })
  )

  /** Break the list into date sections so long histories stay navigable. */
  const groups = $derived(groupByDay(filtered, now))

  const visibleAccounts = $derived(accounts.filter((a) => !a.muted))
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- Filter bar -->
  <div class="flex items-center gap-1.5 px-3 pb-2">
    <div class="flex items-center gap-0.5 rounded-lg bg-muted/60 p-[3px]">
      {#each FILTERS as item (item.id)}
        <button
          type="button"
          onclick={() => (filter = item.id)}
          class={cn(
            'rounded-md px-2 py-[3px] text-[11.5px] font-medium transition-all',
            filter === item.id
              ? 'bg-elevated text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {item.label}
          {#if item.id === 'unread' && unreadHere > 0}
            <span class="ml-1 tabular-nums text-primary">{unreadHere}</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if visibleAccounts.length > 1}
      <div class="chip-scroller -mx-1 flex flex-1 items-center gap-1 overflow-x-auto px-1">
        <button
          type="button"
          onclick={() => (accountFilter = null)}
          class={cn(
            'shrink-0 rounded-full border px-2 py-[2px] text-[11px] transition-colors',
            accountFilter === null
              ? 'border-primary/40 bg-primary/12 text-primary'
              : 'border-border/70 text-muted-foreground hover:bg-accent/50'
          )}>Everyone</button
        >
        {#each visibleAccounts as account (account.did)}
          <button
            type="button"
            onclick={() => (accountFilter = accountFilter === account.did ? null : account.did)}
            title={sourceLabel(account.did, account.handle)}
            class={cn(
              'max-w-[7.5rem] shrink-0 truncate rounded-full border px-2 py-[2px] text-[11px] transition-colors',
              accountFilter === account.did
                ? 'border-primary/40 bg-primary/12 text-primary'
                : 'border-border/70 text-muted-foreground hover:bg-accent/50'
            )}>{account.displayName}</button
          >
        {/each}
      </div>
    {/if}
  </div>

  <!-- The list -->
  <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
    {#if !filtered.length}
      {#if filter === 'unread'}
        <EmptyState
          icon={CircleCheck}
          title="All caught up"
          description="You've read everything here. New updates will appear as they arrive."
        />
      {:else}
        <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
      {/if}
    {:else}
      {#each groups as group (group.key)}
        <div class="sticky top-0 z-10 -mx-2 mb-0.5 px-4 py-1.5 backdrop-blur-md">
          <h2 class="text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            {group.label}
          </h2>
        </div>
        <div class="mb-1 flex flex-col gap-0.5">
          {#each group.items as post (post.uri)}
            <PostCard {post} {now} />
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  /* Hide the scrollbar but keep the row scrollable, and fade the trailing edge so
     a clipped account chip reads as "more to scroll" rather than a layout bug. */
  .chip-scroller {
    scrollbar-width: none;
    mask-image: linear-gradient(to right, black calc(100% - 1.25rem), transparent);
  }
  .chip-scroller::-webkit-scrollbar {
    display: none;
  }
</style>
