<script lang="ts">
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { TooltipProvider } from '$lib/components/ui/tooltip'
  import { app } from '$lib/app-state.svelte'
  import { nav, TAB_ORDER } from '$lib/nav.svelte'
  import { startThemeSync } from '$lib/theme.svelte'
  import Rss from '@lucide/svelte/icons/rss'
  import AccountsPanel from '@components/AccountsPanel.svelte'
  import AlertsPanel from '@components/AlertsPanel.svelte'
  import Feed from '@components/Feed.svelte'
  import Header from '@components/Header.svelte'
  import NetworkPanel from '@components/NetworkPanel.svelte'
  import SettingsPanel from '@components/SettingsPanel.svelte'
  import TimelinePanel from '@components/TimelinePanel.svelte'

  /**
   * Opening the popover re-measures the network if the last sweep is older than this.
   * Long enough that flicking the popover open and shut does not keep re-sweeping.
   */
  const NETWORK_STALE_MS = 2 * 60_000

  /**
   * Esc closes the popover, Cmd/Ctrl-R refreshes whatever is showing, and Cmd/Ctrl-1
   * through -4 select a tab in the order they are drawn — all expected of a menu bar
   * app.
   */
  function onKey(event: KeyboardEvent): void {
    const command = event.metaKey || event.ctrlKey
    if (event.key === 'Escape') {
      app.hide()
    } else if (event.key === 'r' && command) {
      event.preventDefault()
      if (nav.view === 'network') app.runNetworkChecks()
      else void app.refresh()
    } else if (command && event.key >= '1' && event.key <= '4') {
      const tab = TAB_ORDER[Number(event.key) - 1]
      if (!tab) return
      event.preventDefault()
      nav.open(tab)
    }
  }

  /** Ticks so relative timestamps stay honest without every card holding a timer. */
  let now = $state(Date.now())

  onMount(() => {
    const stopTheme = startThemeSync()
    const ticker = setInterval(() => (now = Date.now()), 30_000)
    let stopState: (() => void) | undefined

    void app.init().then((stop) => {
      stopState = stop
    })

    window.addEventListener('keydown', onKey)

    // Opening the popover is the natural moment to refresh.
    const onFocus = (): void => {
      now = Date.now()
      void app.refresh()
      app.runNetworkChecksIfStale(NETWORK_STALE_MS, now)
    }
    window.addEventListener('focus', onFocus)

    return () => {
      stopTheme()
      stopState?.()
      clearInterval(ticker)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('focus', onFocus)
    }
  })
</script>

<TooltipProvider delayDuration={400}>
  <div
    class="flex h-screen flex-col overflow-hidden rounded-xl border border-border/50 bg-transparent"
  >
    <Header {now} />

    <div class="min-h-0 flex-1">
      {#key nav.view}
        <div class="h-full" in:fade={{ duration: 120 }}>
          {#if nav.view === 'accounts'}
            <AccountsPanel />
          {:else if nav.view === 'settings'}
            <SettingsPanel {now} />
          {:else if !app.ready}
            <div class="flex h-full items-center justify-center text-muted-foreground">
              <Rss class="size-5 animate-pulse" />
            </div>
          {:else if nav.view === 'network'}
            <NetworkPanel {now} />
          {:else if nav.view === 'feed'}
            <Feed {now} />
          {:else if nav.view === 'alerts'}
            <AlertsPanel {now} />
          {:else}
            <TimelinePanel {now} />
          {/if}
        </div>
      {/key}
    </div>
  </div>
</TooltipProvider>
