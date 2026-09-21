<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Tooltip, TooltipContent, TooltipTrigger } from '$lib/components/ui/tooltip'
  import { app } from '$lib/app-state.svelte'
  import { nav, TAB_ORDER, type Tab } from '$lib/nav.svelte'
  import { HEALTH_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import { sinceTime } from '@shared/time'
  import type { Component } from 'svelte'
  import Activity from '@lucide/svelte/icons/activity'
  import CheckCheck from '@lucide/svelte/icons/check-check'
  import Inbox from '@lucide/svelte/icons/inbox'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Newspaper from '@lucide/svelte/icons/newspaper'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Settings from '@lucide/svelte/icons/settings'
  import Siren from '@lucide/svelte/icons/siren'
  import Users from '@lucide/svelte/icons/users'
  import WifiOff from '@lucide/svelte/icons/wifi-off'
  import X from '@lucide/svelte/icons/x'
  import HealthDot from './HealthDot.svelte'

  let { now }: { now: number } = $props()

  const style = $derived(HEALTH_STYLE[app.overall])
  const syncing = $derived(app.sync.status === 'syncing')
  const lastSynced = $derived(
    app.sync.lastSyncedAt ? sinceTime(app.sync.lastSyncedAt, now) : 'never'
  )

  /** On the dashboard, refreshing means measuring again; everywhere else, polling. */
  const onNetwork = $derived(nav.view === 'network')
  const refreshing = $derived(onNetwork ? app.snapshot.running : syncing)
  const refreshLabel = $derived(onNetwork ? 'Run network checks' : 'Refresh now')

  function refresh(): void {
    if (onNetwork) app.runNetworkChecks()
    else void app.refresh()
  }

  /**
   * Four tabs in a 440px popover, so the labels go and the icons carry the names —
   * each button keeps its label as `aria-label` and its tooltip, which is also what a
   * test asks for it by. Only the selected tab spells itself out, which fits because
   * exactly one ever does.
   */
  const TABS: { id: Tab; label: string; icon: Component }[] = [
    { id: 'timeline', label: 'Timeline', icon: Inbox },
    { id: 'feed', label: 'Feed', icon: Newspaper },
    { id: 'alerts', label: 'Alerts', icon: Siren },
    { id: 'network', label: 'Network', icon: Activity }
  ]

  /** Where the sliding selection indicator sits, as a share of the strip. */
  const tabIndex = $derived(Math.max(0, TAB_ORDER.indexOf(nav.tab)))

  /** Per-tab unread counts, so a badge says which tab is asking for attention. */
  function unreadFor(tab: Tab): number {
    if (tab === 'timeline') return app.unreadCount
    if (tab === 'feed') return app.feedUnreadCount
    if (tab === 'alerts') return app.alertUnreadCount
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
        <HealthDot health={app.overall} pulse />
        <h1
          class={cn(
            'truncate text-[14px] leading-none font-semibold transition-colors',
            style.text
          )}
        >
          {app.headline.label}
        </h1>
      </div>
      <p class="mt-1 truncate text-[11px] text-muted-foreground">
        {#if syncing}
          Checking for updates…
        {:else if app.sync.error}
          <span class="text-destructive">Refresh failed</span> · retried automatically
        {:else}
          Last checked {lastSynced}
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
                onclick={() => void app.markAllRead()}
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

  <!-- The four things the app is for. A detour to accounts or settings leaves all unselected. -->
  <div
    class="no-drag relative mt-2.5 grid grid-cols-4 gap-[2px] rounded-lg bg-muted/60 p-[3px]"
    role="tablist"
    aria-label="View"
  >
    <span
      class={cn(
        'pointer-events-none absolute top-[3px] bottom-[3px] left-[3px] w-[calc(25%-3px)] rounded-md bg-elevated shadow-sm transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]',
        nav.view !== nav.tab && 'opacity-0'
      )}
      style:transform={`translateX(calc(${tabIndex * 100}% + ${tabIndex * 2}px))`}
      aria-hidden="true"
    ></span>

    {#each TABS as tab (tab.id)}
      {@const selected = nav.view === tab.id}
      {@const unread = unreadFor(tab.id)}
      {@const Icon = tab.icon}
      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={tab.label}
              onclick={() => nav.open(tab.id)}
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
                  <span class="text-[10.5px] font-normal text-muted-foreground"
                    >{networkBadge.text}</span
                  >
                {:else if networkBadge.kind === 'offline'}
                  <WifiOff class="size-3 text-muted-foreground" aria-label="Offline" />
                {:else if networkBadge.kind === 'running'}
                  <LoaderCircle
                    class="size-3 animate-spin text-muted-foreground"
                    aria-label="Checking"
                  />
                {:else if networkBadge.kind === 'count'}
                  <span
                    class={cn(
                      'min-w-4 rounded-full px-1 text-[10px] leading-4 font-semibold text-white tabular-nums',
                      networkBadge.tone === 'bad' ? 'bg-sev-outage' : 'bg-sev-investigating'
                    )}
                    aria-label={`${networkBadge.count} with problems`}>{networkBadge.count}</span
                  >
                {:else if networkBadge.kind === 'dot'}
                  <span
                    class="size-1.5 rounded-full bg-sev-resolved shadow-[0_0_6px_var(--sev-resolved)]"
                    aria-label="All reachable"
                  ></span>
                {/if}
              {:else if unread > 0}
                <span
                  class="min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums"
                  aria-label={`${unread} unread`}>{unread}</span
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
