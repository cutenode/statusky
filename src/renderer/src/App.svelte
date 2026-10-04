<script lang="ts">
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { TooltipProvider } from '$lib/components/ui/tooltip'
  import { app } from '$lib/app-state.svelte'
  import { nav, TAB_ORDER, type Tab } from '$lib/nav.svelte'
  import { startReducedMotionSync, transitionMs } from '$lib/motion.svelte'
  import { startThemeSync } from '$lib/theme.svelte'
  import { ipcErrorMessage } from '@shared/bridge'
  import CloudOff from '@lucide/svelte/icons/cloud-off'
  import Rss from '@lucide/svelte/icons/rss'
  import AccountsPanel from '@components/AccountsPanel.svelte'
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

  /** What each tab's panel is called, the same as the tab that opens it. */
  const TAB_LABELS: Record<Tab, string> = {
    timeline: 'Timeline',
    feed: 'Feed',
    network: 'Network'
  }

  /** Cmd/Ctrl and the digit each tab sits at, counting from the left. */
  const TAB_KEYS: Record<string, Tab> = Object.fromEntries(
    TAB_ORDER.map((tab, index) => [String(index + 1), tab])
  )

  /**
   * Esc closes the popover, Cmd/Ctrl-R refreshes whatever is showing, and Cmd/Ctrl-1
   * through -3 select a tab in the order they are drawn — all expected of a menu bar
   * app.
   *
   * Only once nothing closer has answered the key. Esc closes an open select or cancels
   * an edit before it ever reaches the window, and the thing that answered it says so by
   * preventing its default; a key that is still composing text belongs to the input
   * method. Taking either as "close the popover" threw away the edit along with the
   * window.
   */
  function onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return
    const command = event.metaKey || event.ctrlKey
    const tab = command ? TAB_KEYS[event.key] : undefined
    if (event.key === 'Escape') {
      app.hide()
    } else if (event.key === 'r' && command) {
      event.preventDefault()
      if (nav.view === 'network') void app.runNetworkChecks()
      else void app.refresh()
    } else if (tab) {
      event.preventDefault()
      nav.open(tab)
    }
  }

  /**
   * Chromium is told the connection changed the instant it happens, and main is not.
   * Passing it on lets the network checks stop waiting out their offline retry; main
   * confirms it for itself before believing it. See `Popover` in schemas/statusky.eipc.
   */
  function onOnline(): void {
    app.reportOnline(true)
  }

  function onOffline(): void {
    app.reportOnline(false)
  }

  /** Ticks so relative timestamps stay honest without every card holding a timer. */
  let now = $state(Date.now())

  /**
   * Why the first state could not be loaded, or null while it is loading or has loaded.
   * Said, with a way to try again, rather than leaving the loading light on for good.
   */
  let failed = $state<string | null>(null)
  let stopState: (() => void) | undefined
  let mounted = true

  function load(): void {
    failed = null
    app.init().then(
      (stop) => {
        // Unmounted while waiting: there is nobody left to keep the subscription for.
        if (mounted) stopState = stop
        else stop()
      },
      (error: unknown) => {
        failed = ipcErrorMessage(error)
      }
    )
  }

  onMount(() => {
    const stopTheme = startThemeSync()
    // The tray's heartbeat is in the main process, which cannot read this; the popover
    // can. See `Popover` in schemas/statusky.eipc.
    const stopMotion = startReducedMotionSync((reduce) => app.reportReducedMotion(reduce))
    const ticker = setInterval(() => (now = Date.now()), 30_000)

    load()

    window.addEventListener('keydown', onKey)

    // Opening the popover is the natural moment to refresh.
    const onFocus = (): void => {
      now = Date.now()
      void app.refresh()
      app.runNetworkChecksIfStale(NETWORK_STALE_MS, now)
    }
    window.addEventListener('focus', onFocus)

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      mounted = false
      stopTheme()
      stopMotion()
      stopState?.()
      clearInterval(ticker)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  })
</script>

<TooltipProvider delayDuration={400}>
  <div
    class="flex h-screen flex-col overflow-hidden rounded-xl border border-border/50 bg-transparent"
  >
    <Header {now} />

    <!--
      The panel the header's tabs control, when it is one of theirs. A detour to accounts
      or settings is no tab's, so it is not called one.
    -->
    <div
      id="view"
      class="min-h-0 flex-1"
      role={nav.view === nav.tab ? 'tabpanel' : undefined}
      aria-label={nav.view === nav.tab ? TAB_LABELS[nav.tab] : undefined}
    >
      {#key nav.view}
        <div class="h-full" in:fade={{ duration: transitionMs(120) }}>
          {#if nav.view === 'accounts'}
            <AccountsPanel />
          {:else if nav.view === 'settings'}
            <SettingsPanel {now} />
          {:else if failed}
            <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
              <CloudOff class="size-5 text-muted-foreground" />
              <p class="text-[13px] font-medium">Statusky could not load</p>
              <p class="selectable max-w-[18rem] text-[12px] text-muted-foreground" role="alert">
                {failed}
              </p>
              <button
                type="button"
                class="mt-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-primary transition-colors hover:bg-primary/10"
                onclick={load}>Try again</button
              >
            </div>
          {:else if !app.ready}
            <div class="flex h-full items-center justify-center text-muted-foreground">
              <Rss class="size-5 animate-pulse" />
            </div>
          {:else if nav.view === 'network'}
            <NetworkPanel {now} />
          {:else if nav.view === 'feed'}
            <Feed {now} />
          {:else}
            <TimelinePanel {now} />
          {/if}
        </div>
      {/key}
    </div>
  </div>
</TooltipProvider>
