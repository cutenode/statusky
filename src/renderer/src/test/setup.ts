/**
 * jsdom shims for the browser APIs the UI layer expects but jsdom does not ship.
 *
 * bits-ui's floating/dismissable primitives (tooltips, selects) reach for pointer
 * capture, element animations and observers; without these they throw during
 * mount and every component test using them fails for the wrong reason.
 */
import '@testing-library/svelte/vitest'
import { afterEach, vi } from 'vitest'

class FakeObserver {
  constructor(private readonly callback: unknown) {
    void this.callback
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] {
    return []
  }
}

/**
 * A driveable `IntersectionObserver`, because one piece of the UI is about what has
 * actually been on screen: `markReadOn: 'seen'`. jsdom lays nothing out, so nothing
 * ever intersects on its own — `scrollIntoView` below is what a test calls to say an
 * element has been looked at.
 */
class FakeIntersectionObserver {
  private readonly targets = new Set<Element>()

  constructor(private readonly callback: (entries: IntersectionObserverEntry[]) => void) {
    intersectionObservers.add(this)
  }

  observe(target: Element): void {
    this.targets.add(target)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.targets.clear()
    intersectionObservers.delete(this)
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  /** Report `target` as `ratio` visible, if this observer is watching it. */
  reveal(target: Element, ratio: number): boolean {
    if (!this.targets.has(target)) return false
    this.callback([
      { target, isIntersecting: ratio > 0, intersectionRatio: ratio }
    ] as IntersectionObserverEntry[])
    return true
  }
}

const intersectionObservers = new Set<FakeIntersectionObserver>()

/**
 * Tell whatever is watching `element` how much of it is now showing, and say whether
 * anything was. A test asserting that a card is *not* being watched checks the `false`.
 */
export function scrollIntoView(element: Element, ratio = 1): boolean {
  let seen = false
  for (const observer of Array.from(intersectionObservers)) {
    if (observer.reveal(element, ratio)) seen = true
  }
  return seen
}

/**
 * jsdom ships a `matchMedia` stub that is not callable, so replace it outright with
 * one whose `matches` a test can flip — that is how the theme sync is driven.
 */
const mediaListeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>()
const mediaMatches = new Map<string, boolean>()

function listenersFor(query: string): Set<(event: MediaQueryListEvent) => void> {
  let set = mediaListeners.get(query)
  if (!set) {
    set = new Set()
    mediaListeners.set(query, set)
  }
  return set
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    media: query,
    get matches(): boolean {
      return mediaMatches.get(query) ?? false
    },
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listenersFor(query).add(listener)
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listenersFor(query).delete(listener)
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) =>
      listenersFor(query).add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) =>
      listenersFor(query).delete(listener),
    dispatchEvent: () => true
  })
})

/** Set a media query's result and notify anything listening to it. */
export function setMediaQuery(query: string, matches: boolean): void {
  mediaMatches.set(query, matches)
  for (const listener of listenersFor(query)) {
    listener({ matches, media: query } as MediaQueryListEvent)
  }
}

/** Live listener count for a query, so tests can prove cleanup unsubscribes. */
export function mediaListenerCount(query: string): number {
  return listenersFor(query).size
}

globalThis.ResizeObserver ??= FakeObserver
globalThis.IntersectionObserver ??=
  FakeIntersectionObserver as unknown as typeof IntersectionObserver

Element.prototype.scrollIntoView ??= function scrollIntoViewStub(): void {}
Element.prototype.scrollTo ??= function scrollTo(): void {}
Element.prototype.hasPointerCapture ??= function hasPointerCapture(): boolean {
  return false
}
Element.prototype.setPointerCapture ??= function setPointerCapture(): void {}
Element.prototype.releasePointerCapture ??= function releasePointerCapture(): void {}
Element.prototype.animate ??= function animate(): Animation {
  return {
    cancel(): void {},
    finish(): void {},
    play(): void {},
    pause(): void {},
    addEventListener(): void {},
    removeEventListener(): void {},
    finished: Promise.resolve(),
    onfinish: null
  } as unknown as Animation
}

if (!('scrollTo' in window)) {
  Object.defineProperty(window, 'scrollTo', { writable: true, value: () => {} })
}

afterEach(() => {
  for (const observer of Array.from(intersectionObservers)) observer.disconnect()
  vi.useRealTimers()
  mediaListeners.clear()
  mediaMatches.clear()
  document.documentElement.className = ''
  document.documentElement.style.colorScheme = ''
})
