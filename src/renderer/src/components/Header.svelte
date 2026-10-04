<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Tooltip, TooltipContent, TooltipTrigger } from '$lib/components/ui/tooltip'
  import { app } from '$lib/app-state.svelte'
  import { nav, TAB_ORDER, type Tab } from '$lib/nav.svelte'
  import { Refusals } from '$lib/requests.svelte'
  import { HEALTH_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import { HEALTH_NOUN } from '@shared/status'
  import { sinceTime } from '@shared/time'
  import type { LucideIcon } from '@lucide/svelte'
  import Activity from '@lucide/svelte/icons/activity'
  import CheckCheck from '@lucide/svelte/icons/check-check'
  import Inbox from '@lucide/svelte/icons/inbox'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Newspaper from '@lucide/svelte/icons/newspaper'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Settings from '@lucide/svelte/icons/settings'
  import Users from '@lucide/svelte/icons/users'
  import WifiOff from '@lucide/svelte/icons/wifi-off'
  import X from '@lucide/svelte/icons/x'
  import HealthDot from './HealthDot.svelte'
  import Refused from './Refused.svelte'

  let { now }: { now: number } = $props()

  const line = $derived(app.headlineAt(now))
  const style = $derived(HEALTH_STYLE[line.health])
  const syncing = $derived(app.sync.status === 'syncing')
  const lastSynced = $derived(
    app.sync.lastSyncedAt ? sinceTime(app.sync.lastSyncedAt, now) : 'never'
  )

  /**
   * Who the headline rests on, for the line underneath it.
   *
   * When the app is only repeating what somebody posted, saying so is the difference
   * between a fact and a quotation — and the age is what lets the reader discount it,
   * which is the judgement the app used to make badly on their behalf.
   *
   * A current claim needs only its source and its age: the headline above already names
   * the stage. A stale one has to name the stage too, because the headline has stopped
   * doing so — the verdict has moved to what this machine measured, and this line is
   * what keeps the post on screen instead of dropping it silently.
   *
   * When nothing is being quoted, this is null and the line goes back to saying when we
   * last looked.
   */
  const provenance = $derived.by(() => {
    const source = line.attribution
    if (!source) return null
    const who = source.others > 0 ? `${source.name} +${source.others}` : source.name
    const when = sinceTime(source.at, now)
    return source.stale
      ? `${who} reported ${HEALTH_NOUN[source.health]} ${when}`
      : `${who} · ${when}`
  })

  /** On the dashboard, refreshing means measuring again; everywhere else, polling. */
  const onNetwork = $derived(nav.view === 'network')
  const refreshing = $derived(onNetwork ? app.snapshot.running : syncing)
  const refreshLabel = $derived(onNetwork ? 'Run network checks' : 'Refresh now')

  /** Why main refused the last thing one of these buttons asked for, said under them. */
  const refusals = new Refusals()

  function refresh(): void {
    void refusals.track('header', onNetwork ? app.runNetworkChecks() : app.refresh())
  }

  /**
   * Three tabs in a 440px popover, so the labels go and the icons carry the names —
   * each button keeps its label as `aria-label` and its tooltip, which is also what a
   * test asks for it by. Only the selected tab spells itself out, which fits because
   * exactly one ever does.
   */
  const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
    { id: 'timeline', label: 'Timeline', icon: Inbox },
    { id: 'feed', label: 'Feed', icon: Newspaper },
    { id: 'network', label: 'Network', icon: Activity }
  ]

  /** Where the sliding selection indicator sits, as a share of the strip. */
  const tabIndex = $derived(Math.max(0, TAB_ORDER.indexOf(nav.tab)))

  /**
   * The arrow keys, Home and End move along the strip, the way a tab list is expected to
   * work: one tab stop for the whole strip, and the keys to choose within it. A tab is
   * opened as it is reached, since opening one costs nothing and nothing is lost by it.
   */
  function onTabKey(event: KeyboardEvent & { currentTarget: HTMLElement }, index: number): void {
    const last = TABS.length - 1
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (index + last) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    nav.open(TABS[next]!.id)
    const strip = event.currentTarget.closest('[role="tablist"]')
    strip?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  /** Per-tab unread counts, so a badge says which tab is asking for attention. */
  function unreadFor(tab: Tab): number {
    if (tab === 'timeline') return app.unreadCount
    if (tab === 'feed') return app.feedUnreadCount
    return 0
  }

  /** What the Network tab says about itself without being opened. */
  const networkBadge = $derived.by(() => {
    const summary = app.network
    if (summary.health === 'off') return { kind: 'text', text: 'Off' } as const
    if (summary.health === 'offline') return { kind: 'offline' } as const
    if (summary.running) return { kind: 'running' } as const
    const failing = summary.down.length + summary.degraded.length
    if (failing) {
      return { kind: 'count', count: failing, tone: summary.down.length ? 'bad' : 'warn' } as const
    }
    if (summary.health === 'operational') return { kind: 'dot' } as const
    return { kind: 'none' } as const
  })
</script>

<header class="drag-region shrink-0 px-3 pt-2.5 pb-2">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <HealthDot health={line.health} pulse />
        <h1
          class={cn(
            'truncate text-[14px] leading-none font-semibold transition-colors',
            style.text
          )}
        >
          {line.label}
        </h1>
      </div>
      <p class="mt-1 truncate text-[11px] text-muted-foreground">
        {#if syncing}
          Checking for updates…
        {:else if app.sync.error}
          <span class="text-destructive">Refresh failed</span> · retried automatically
        {:else}
          {#if provenance}
            <span class={cn(line.attribution?.stale && 'italic')}>{provenance}</span>
          {:else}
            Last checked {lastSynced}
          {/if}
          {#if app.unreadCount > 0}
            · <span class="font-medium text-primary">{app.unreadCount} unread</span>
          {/if}
        {/if}
      </p>
    </div>

    <div class="no-drag flex shrink-0 items-center gap-0.5">
      {#if app.unreadCount > 0}
        <Tooltip>
          <TooltipTrigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="ghost"
                size="icon-sm"
                onclick={() => void refusals.track('header', app.markAllRead())}
                aria-label="Mark all as read"
              >
                <CheckCheck class="size-3.5" />
              </Button>
            {/snippet}
          </TooltipTrigger>
          <TooltipContent>Mark all as read</TooltipContent>
        </Tooltip>
      {/if}

      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              disabled={refreshing || (onNetwork && !app.settings.networkChecks)}
              onclick={refresh}
              aria-label={refreshLabel}
            >
              <RefreshCw class={cn('size-3.5', refreshing && 'animate-spin')} />
            </Button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent>{refreshLabel}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              class={cn(
                nav.view === 'accounts' && 'bg-primary/12 text-primary hover:bg-primary/15'
              )}
              aria-label="Accounts"
              aria-pressed={nav.view === 'accounts'}
              onclick={() => nav.toggle('accounts')}
            >
              <Users class="size-3.5" />
            </Button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent>Accounts</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              class={cn(
                nav.view === 'settings' && 'bg-primary/12 text-primary hover:bg-primary/15'
              )}
              aria-label="Settings"
              aria-pressed={nav.view === 'settings'}
              onclick={() => nav.toggle('settings')}
            >
              <Settings class="size-3.5" />
            </Button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              onclick={() => app.hide()}
              aria-label="Close"
            >
              <X class="size-3.5" />
            </Button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent>Close (Esc)</TooltipContent>
      </Tooltip>
    </div>
  </div>

  {#if app.sync.error}
    <p
      class="selectable mt-2 rounded-md border border-destructive/25 bg-destructive/8 px-2 py-1 text-[11px] text-destructive"
    >
      {app.sync.error}
    </p>
  {/if}
  <Refused class="mt-1.5 pb-0" text={refusals.of('header')} />

  <!-- The three things the app is for. A detour to accounts or settings leaves all unselected. -->
  <div
    class="no-drag relative mt-2.5 grid grid-cols-3 gap-[2px] rounded-lg bg-muted/60 p-[3px]"
    role="tablist"
    aria-label="View"
  >
    <span
      class={cn(
        'pointer-events-none absolute top-[3px] bottom-[3px] left-[3px] w-[calc(100%/3-3.333px)] rounded-md bg-elevated shadow-sm transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]',
        nav.view !== nav.tab && 'opacity-0'
      )}
      style:transform={`translateX(calc(${tabIndex * 100}% + ${tabIndex * 2}px))`}
      aria-hidden="true"
    ></span>

    {#each TABS as tab, index (tab.id)}
      {@const selected = nav.view === tab.id}
      {@const unread = unreadFor(tab.id)}
      {@const Icon = tab.icon}
      {@const badge = `tab-badge-${tab.id}`}
      {@const described = tab.id === 'network' ? networkBadge.kind !== 'none' : unread > 0}
      <!--
        The label is the tab's name and its badge is its description, so a screen reader
        hears "Feed, tab, 3 unread" rather than a name that changes with every count.
      -->
      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={tab.label}
              aria-controls="view"
              aria-describedby={described ? badge : undefined}
              tabindex={tab.id === nav.tab ? 0 : -1}
              onclick={() => nav.open(tab.id)}
              onkeydown={(event) => onTabKey(event, index)}
              class={cn(
                'relative z-10 flex items-center justify-center gap-1 rounded-md py-[5px] text-[12px] font-medium transition-colors',
                selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon class="size-3.5 shrink-0" />
              {#if selected}
                <span class="truncate">{tab.label}</span>
              {/if}

              {#if tab.id === 'network'}
                {#if networkBadge.kind === 'text'}
                  <span id={badge} class="text-[10.5px] font-normal text-muted-foreground"
                    >{networkBadge.text}</span
                  >
                {:else if networkBadge.kind === 'offline'}
                  <span id={badge}>
                    <WifiOff class="size-3 text-muted-foreground" aria-hidden="true" />
                    <span class="sr-only">Offline</span>
                  </span>
                {:else if networkBadge.kind === 'running'}
                  <span id={badge}>
                    <LoaderCircle
                      class="size-3 animate-spin text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span class="sr-only">Checking</span>
                  </span>
                {:else if networkBadge.kind === 'count'}
                  <span
                    id={badge}
                    class={cn(
                      'min-w-4 rounded-full px-1 text-[10px] leading-4 font-semibold text-white tabular-nums',
                      networkBadge.tone === 'bad' ? 'bg-sev-outage' : 'bg-sev-investigating'
                    )}
                    ><span aria-hidden="true">{networkBadge.count}</span><span class="sr-only"
                      >{`${networkBadge.count} with problems`}</span
                    ></span
                  >
                {:else if networkBadge.kind === 'dot'}
                  <span id={badge}>
                    <span
                      class="block size-1.5 rounded-full bg-sev-resolved shadow-[0_0_6px_var(--sev-resolved)]"
                      aria-hidden="true"
                    ></span>
                    <span class="sr-only">All reachable</span>
                  </span>
                {/if}
              {:else if unread > 0}
                <span
                  id={badge}
                  class="min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums"
                  ><span aria-hidden="true">{unread}</span><span class="sr-only"
                    >{`${unread} unread`}</span
                  ></span
                >
              {/if}
            </button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent>{tab.label}</TooltipContent>
      </Tooltip>
    {/each}
  </div>
</header>
