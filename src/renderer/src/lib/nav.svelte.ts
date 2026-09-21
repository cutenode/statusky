/**
 * Which panel the popover is showing.
 *
 * Four tabs, and the popover remembers which one was last open. **Timeline** is what it
 * opens on: the menu bar asked you to look at something, so the first thing shown is
 * that something, with everything already read continuing below it. **Feed** is the AT
 * Protocol status accounts,
 * **Alerts** is everything that arrived on its own — pushed status pages and the
 * network checks' own findings — and **Network** is the dashboard behind them.
 * Accounts and Settings are detours: their header icons toggle them, and closing one
 * goes back to whichever tab it came from.
 *
 * It is a module singleton rather than state owned by `App`, because a feed entry, an
 * account row, a notification and the tray menu can all ask to land on the network
 * dashboard, and none of them sits anywhere near `App`.
 */
export type Tab = 'timeline' | 'feed' | 'alerts' | 'network'
export type View = Tab | 'accounts' | 'settings'

/** Left to right, which is also the order Cmd-1…4 select them in. */
export const TAB_ORDER: readonly Tab[] = ['timeline', 'feed', 'alerts', 'network']

class Navigation {
  view = $state<View>('timeline')
  /** The tab a detour returns to. */
  tab = $state<Tab>('timeline')
  /**
   * A reveal the dashboard has not acted on yet. A fresh object every time, so asking
   * for the same service twice still scrolls to it the second time.
   */
  pending = $state<{ serviceId: string | null } | null>(null)

  /** Switch to a tab. */
  open(tab: Tab): void {
    this.tab = tab
    this.view = tab
  }

  /** Open a detour, or close it when it is already open. */
  toggle(view: 'accounts' | 'settings'): void {
    this.view = this.view === view ? this.tab : view
  }

  /** Show the network dashboard, scrolled to one service if given. */
  reveal(serviceId: string | null): void {
    this.open('network')
    this.pending = { serviceId }
  }

  /** Hand the waiting reveal to the dashboard, exactly once. */
  takeReveal(): { serviceId: string | null } | null {
    const pending = this.pending
    this.pending = null
    return pending
  }

  /** Back to a fresh popover: the timeline, nothing waiting. */
  reset(): void {
    this.view = 'timeline'
    this.tab = 'timeline'
    this.pending = null
  }
}

export const nav = new Navigation()
