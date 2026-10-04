/**
 * The bookkeeping a control needs around a request to main.
 *
 * Every request answers with an `Outcome` (see `app-state.svelte`), and what to do with
 * one is the same everywhere: say a refusal beside the control that asked, and stop
 * saying it once a request from that control goes through. A list setting toggled an
 * entry at a time needs one more thing, which `PendingList` is.
 */
import { SvelteMap } from 'svelte/reactivity'
import type { Outcome } from './app-state.svelte'

/**
 * Why main refused each control's last request, by a name the component gives it.
 *
 * One per component, so a refusal lives exactly as long as the panel that shows it:
 * leaving the tab and coming back starts from nothing, and from whatever main says now.
 */
export class Refusals {
  #reasons = new SvelteMap<string, string>()

  /** Why the control's last request was refused, or null if it went through. */
  of(key: string): string | null {
    return this.#reasons.get(key) ?? null
  }

  /** Wait for a control's request, and keep its refusal or forget the last one. */
  async track<T>(key: string, request: Promise<Outcome<T>>): Promise<Outcome<T>> {
    const outcome = await request
    if (outcome.ok) this.#reasons.delete(key)
    else this.#reasons.set(key, outcome.error)
    return outcome
  }
}

/**
 * A list setting changed an entry at a time, by clicks that can come faster than main
 * answers them.
 *
 * Each change is built on the list the last unanswered one sent, rather than on the
 * last push. Built on the push, a second click before the first was answered sent a list
 * without the first one's change in it, and quietly undid it.
 *
 * The controls draw `current` too, so what they show is what the next click builds on:
 * the change on its way while there is one, and what main has once every change has
 * been answered — which, after a refusal, puts the control back.
 */
export class PendingList<T> {
  #read: () => readonly T[]
  #sent = $state.raw<readonly T[] | null>(null)
  #waiting = 0

  constructor(read: () => readonly T[]) {
    this.#read = read
  }

  /** The list to draw, and to build the next change on. */
  get current(): readonly T[] {
    return this.#sent ?? this.#read()
  }

  /** Send a change, and build on it until every change sent so far has been answered. */
  async send<R>(next: T[], request: (next: T[]) => Promise<R>): Promise<R> {
    this.#sent = next
    this.#waiting++
    try {
      return await request(next)
    } finally {
      if (--this.#waiting === 0) this.#sent = null
    }
  }
}
