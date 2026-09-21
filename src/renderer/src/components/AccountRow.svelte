<script lang="ts">
  import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar'
  import { Switch } from '$lib/components/ui/switch'
  import { Tooltip, TooltipContent, TooltipTrigger } from '$lib/components/ui/tooltip'
  import { app } from '$lib/app-state.svelte'
  import { nav } from '$lib/nav.svelte'
  import { cn } from '$lib/utils'
  import { HEALTH_LABEL } from '@shared/status'
  import { sourceLabel } from '@shared/webhook'
  import type { Account } from '@shared/types'
  import Bell from '@lucide/svelte/icons/bell'
  import BellOff from '@lucide/svelte/icons/bell-off'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import Trash from '@lucide/svelte/icons/trash'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import Webhook from '@lucide/svelte/icons/webhook'
  import Activity from '@lucide/svelte/icons/activity'
  import HealthDot from './HealthDot.svelte'

  let { account }: { account: Account } = $props()

  const pushed = $derived(account.kind === 'webhook')
  /** The network checks' own source: it lives in the dashboard, not on the web. */
  const measured = $derived(account.kind === 'probe')

  const healthLabel = $derived.by(() => {
    if (!measured) return HEALTH_LABEL[health]
    const { health: network, reachable, total } = app.network
    if (network === 'off') return 'Checks are off'
    if (network === 'offline') return HEALTH_LABEL.offline
    if (network === 'unknown') return 'Not measured yet'
    return `${reachable} of ${total} services answering`
  })
  /**
   * Where the source lives. A pushed source's handle is the status page's own
   * hostname, so it is its own link; an AT Protocol handle needs a profile URL.
   */
  const profileUrl = $derived(
    pushed ? `https://${account.handle}` : `https://bsky.app/profile/${account.handle}`
  )

  const health = $derived(app.healthByAccount.get(account.did) ?? 'unknown')
  const unread = $derived(app.unreadByAccount.get(account.did) ?? 0)
  const initials = $derived(
    account.displayName
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase() || account.handle.slice(0, 2).toUpperCase()
  )
</script>

<div
  class={cn(
    'group flex items-center gap-2.5 rounded-lg border border-border/60 bg-card/50 px-2.5 py-2 transition-colors',
    account.muted && 'opacity-55'
  )}
>
  {#if measured}
    <span
      class="grid size-8 shrink-0 place-items-center rounded-full bg-primary/12 text-primary"
      aria-hidden="true"
    >
      <Activity class="size-4" strokeWidth={2.25} />
    </span>
  {:else}
    <Avatar class="size-8">
      {#if account.avatar}
        <AvatarImage src={account.avatar} alt="" referrerpolicy="no-referrer" />
      {/if}
      <AvatarFallback>{initials}</AvatarFallback>
    </Avatar>
  {/if}

  <div class="min-w-0 flex-1">
    <div class="flex items-center gap-1.5">
      <p class="truncate text-[12.5px] font-medium">{account.displayName}</p>
      {#if unread > 0 && !account.muted}
        <span
          class="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary tabular-nums"
          >{unread}</span
        >
      {/if}
    </div>
    {#if measured}
      <button
        type="button"
        class="flex max-w-full items-center gap-1 truncate text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        onclick={() => nav.reveal(null)}
        title="Open the network dashboard"
      >
        <span class="truncate">Measured from this computer</span>
      </button>
    {:else}
      <button
        type="button"
        class="flex max-w-full items-center gap-1 truncate text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        onclick={() => app.openExternal(profileUrl)}
        title={pushed ? 'Open the status page' : 'Open profile on Bluesky'}
      >
        {#if pushed}
          <Webhook class="size-2.5 shrink-0 opacity-70" aria-label="Pushed source" />
        {/if}
        <span class="truncate">{sourceLabel(account.did, account.handle)}</span>
        <ExternalLink
          class="size-2.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-70"
        />
      </button>
    {/if}
    {#if !account.muted}
      <div class="mt-0.5 flex items-center gap-1.5">
        <HealthDot {health} pulse />
        <span class="truncate text-[10.5px] text-muted-foreground">{healthLabel}</span>
      </div>
    {/if}
  </div>

  <div class="flex shrink-0 items-center gap-0.5">
    <Tooltip>
      <TooltipTrigger
        class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={() => void app.patchAccount(account.did, { muted: !account.muted })}
        aria-label={account.muted ? 'Show in feed' : 'Hide from feed'}
      >
        {#if account.muted}
          <EyeOff class="size-3.5" />
        {:else}
          <Eye class="size-3.5" />
        {/if}
      </TooltipTrigger>
      <TooltipContent>{account.muted ? 'Hidden from feed' : 'Showing in feed'}</TooltipContent>
    </Tooltip>

    {#if !account.builtin}
      <Tooltip>
        <TooltipTrigger
          class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/12 hover:text-destructive"
          onclick={() => void app.removeAccount(account.did)}
          aria-label="Stop tracking"
        >
          <Trash class="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>Stop tracking this source</TooltipContent>
      </Tooltip>
    {/if}

    <Tooltip>
      <TooltipTrigger class="ml-1 flex items-center gap-1.5" aria-label="Toggle notifications">
        {#if account.notify}
          <Bell class="size-3.5 text-primary" />
        {:else}
          <BellOff class="size-3.5 text-muted-foreground" />
        {/if}
        <Switch
          checked={account.notify}
          onCheckedChange={(checked) => void app.patchAccount(account.did, { notify: checked })}
          aria-label={`Notifications for ${sourceLabel(account.did, account.handle)}`}
        />
      </TooltipTrigger>
      <TooltipContent>
        {account.notify ? 'Notifying you about new posts' : 'Notifications off'}
      </TooltipContent>
    </Tooltip>
  </div>
</div>
