import type { Action } from 'svelte/action'
import { app } from './app-state.svelte'

/**
 * Marking a post read once it has actually been on screen — the `seen` setting.
 *
 * Every card that mounts unread watches itself with an `IntersectionObserver`, which is
 * the only honest answer to "has this been looked at": the popover is short, the feed is
 * not, and a post below the fold has not been read however long the window was open.
 *
 * The URIs are collected rather than sent one at a time. Scrolling reveals several cards
 * within a frame or two of each other, and each `markRead` is an IPC round trip that
 * comes back as a whole new `AppState`, so a flick down the feed would otherwise be a
 * burst of them. One trailing flush coalesces a scroll into a single call.
 */

/** How much of a card has to be showing before it counts as seen. */
const VISIBLE_RATIO = 0.6

/** Trailing window, long enough to swallow one flick of the scroll wheel. */
const FLUSH_MS = 400

const pending = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  timer = null
  if (!pending.size) return
  const uris = [...pending]
  pending.clear()
  void app.markRead(uris)
}

function queue(uri: string): void {
  pending.add(uri)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, FLUSH_MS)
}

/** Send anything waiting immediately. The popover can be dismissed mid-window. */
export function flushSeen(): void {
  if (timer) clearTimeout(timer)
  flush()
}

/**
 * Watch a post card and mark it read once enough of it has been on screen.
 *
 * Does nothing unless `markReadOn` is `seen` and the post is currently unread, so a
 * read card carries no observer at all. Both are read when the card mounts rather than
 * tracked: changing the setting means a trip through the settings panel, and coming
 * back rebuilds the feed — the popover swaps panels with `{#key nav.view}`.
 */
export const seen: Action<HTMLElement, string> = (node, uri) => {
  let observer: IntersectionObserver | null = null

  const stop = (): void => {
    observer?.disconnect()
    observer = null
  }

  const start = (target: string): void => {
    stop()
    if (app.settings.markReadOn !== 'seen' || !app.isUnread(target)) return
    observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.intersectionRatio >= VISIBLE_RATIO)) return
        stop()
        queue(target)
      },
      { threshold: VISIBLE_RATIO }
    )
    observer.observe(node)
  }

  start(uri)

  return {
    update: (next: string) => start(next),
    destroy: stop
  }
}
