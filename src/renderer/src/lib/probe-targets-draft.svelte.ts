/**
 * The check targets editor's working copy, kept outside the panel that draws it.
 *
 * The popover rebuilds whatever it is showing on every switch — a tab, a detour, a
 * notification asking for the dashboard, a catch-up — and a working copy that lived in
 * the editor went with it: half an edit, gone because a banner was clicked. Kept here, it
 * waits for the editor to come back, along with which sections were open and which
 * fields had been visited. What the editor was in the middle of saying — a notice, an
 * import being checked — is the panel's own, and starts again with it.
 *
 * A module singleton, like the store and the navigation, and for the same reason: there
 * is one popover, and it outlives every panel drawn in it.
 */
import { SvelteSet } from 'svelte/reactivity'
import { DEFAULT_PROBE_TARGETS, type ProbeTargets } from '@shared/probe-targets'
import type { SectionKey } from './probe-targets'

/** What is waiting on main, so its button can say so and the others hold still. */
export type TargetsBusy = 'export' | 'open' | 'save' | 'apply'

class TargetsDraft {
  /**
   * The working copy. It starts as the defaults, and the editor adopts what is saved the
   * first time it is drawn, since nothing has been edited yet to keep.
   */
  doc = $state<ProbeTargets>(structuredClone(DEFAULT_PROBE_TARGETS))
  /** The saved document the working copy was last taken from, to tell edits from pushes. */
  base: ProbeTargets = DEFAULT_PROBE_TARGETS
  /** Fields the user has been into and left, by `pathKey`. */
  readonly touched = new SvelteSet<string>()
  /** Whether a save has been tried, which is when every field's problem is shown. */
  attempted = $state(false)
  /** The sections drawn open. */
  readonly expanded = new SvelteSet<SectionKey>()
  busy = $state<TargetsBusy | null>(null)
  /** A section to bring into view and focus the next time the editor is drawn. */
  reveal = $state<SectionKey | null>(null)

  /** Open a section and bring it into view: where "Replace in Settings" lands. */
  open(key: SectionKey): void {
    this.expanded.add(key)
    this.reveal = key
  }

  /** Back to a fresh editor: the defaults, nothing visited, nothing open. */
  reset(): void {
    this.doc = structuredClone(DEFAULT_PROBE_TARGETS)
    this.base = DEFAULT_PROBE_TARGETS
    this.touched.clear()
    this.attempted = false
    this.expanded.clear()
    this.busy = null
    this.reveal = null
  }
}

export const targetsDraft = new TargetsDraft()
