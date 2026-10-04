/**
 * Renderer test helpers.
 *
 * `app` (the renderer store) is a module singleton, so each test re-points it at a
 * fresh bridge and re-runs `init()`. That mirrors what happens when the popover
 * loads, and keeps state from leaking between tests.
 */
import { act, fireEvent, render, type BoundFunction, type queries } from '@testing-library/svelte'
import type { Component, MountOptions } from 'svelte'
import { afterEach } from 'vitest'
import { installBridge, type BridgeOptions, type TestBridge } from '../../../test/bridge'
import { app } from '$lib/app-state.svelte'
import { motion } from '$lib/motion.svelte'
import { nav } from '$lib/nav.svelte'
import { targetsDraft } from '$lib/probe-targets-draft.svelte'
import Providers from './Providers.svelte'

type BoundQueries = { [P in keyof typeof queries]: BoundFunction<(typeof queries)[P]> }

/**
 * What the render helpers hand back: the standard Testing Library queries, plus
 * the handles a test needs to drive and tear down the component.
 */
export type Rendered<Props extends Record<string, unknown> = Record<string, unknown>> =
  BoundQueries & {
    container: HTMLElement
    baseElement: HTMLElement
    debug(el?: HTMLElement | DocumentFragment): void
    rerender(props: Partial<Props>): Promise<void>
    unmount(): void
  }

/**
 * The rest of `renderWith`'s arguments: the component's props, which may be left out
 * only when it has none that are required, then the bridge.
 */
type RenderArgs<Props> = {} extends Props
  ? [props?: Props, options?: BridgeOptions]
  : [props: Props, options?: BridgeOptions]

let active: TestBridge | null = null
let stopListening: (() => void) | null = null

/** Install a bridge and connect the renderer store to it. */
export async function connect(options: BridgeOptions = {}): Promise<TestBridge> {
  teardown()
  const bridge = installBridge(options)
  active = bridge
  stopListening = await app.init()
  return bridge
}

/** Render a component against a fresh bridge. */
export async function renderWith<Props extends Record<string, unknown>>(
  Component: Component<Props>,
  ...[props, options = {}]: RenderArgs<Props>
): Promise<{ bridge: TestBridge } & Rendered<Props>> {
  const bridge = await connect(options)
  // Wrapped in the same providers `App.svelte` establishes, so components that
  // use a tooltip or another context-bound primitive mount the way they really do.
  //
  // The props were checked against the component by `RenderArgs`. Svelte's own options
  // type makes `props` optional or not by whether any prop is required, which it cannot
  // decide for a type parameter, so it is told rather than asked.
  const result = render(Component, { props: props ?? {} } as Partial<MountOptions<Props>>, {
    wrapper: Providers
  })
  await act()
  return { bridge, ...result }
}

/**
 * Render `App.svelte`, which establishes its own providers and calls `app.init()`
 * itself. Unlike `renderWith`, this does not connect the store first — doing so
 * would leave a second subscription behind and mask a real leak.
 */
export async function renderApp(
  Component: Component,
  options: BridgeOptions = {}
): Promise<{ bridge: TestBridge } & Rendered> {
  teardown()
  const bridge = installBridge(options)
  active = bridge
  const result = render(Component)
  // The first state takes a few turns of the microtask queue to arrive — one per answer,
  // since each is applied as it lands — so wait those out, but no longer: a test that
  // holds the first state back, or fails it, has to see the popover still waiting.
  for (let turn = 0; turn < 5 && !app.ready; turn++) {
    // One at a time on purpose: each turn is what lets the next answer land.
    // oxlint-disable-next-line no-await-in-loop
    await act()
  }
  return { bridge, ...result }
}

/** Push a network dashboard patch through the bridge and wait for the UI to settle. */
export async function pushNetwork(
  bridge: TestBridge,
  patch: Parameters<TestBridge['pushNetwork']>[0]
): Promise<void> {
  bridge.pushNetwork(patch)
  await act()
}

/** Push a state patch through the bridge and wait for the UI to settle. */
export async function pushState(
  bridge: TestBridge,
  patch: Parameters<TestBridge['push']>[0]
): Promise<void> {
  bridge.push(patch)
  await act()
}

/** Let Svelte flush pending effects. */
export async function settle(): Promise<void> {
  await act()
}

function pointer(type: string): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerType: 'mouse'
  })
}

/**
 * Open a bits-ui select and return its listbox. The primitive drives itself from
 * pointer events rather than clicks, so a plain `click` would do nothing.
 */
export async function openSelect(trigger: Element): Promise<HTMLElement> {
  await fireEvent(trigger, pointer('pointerdown'))
  await act()
  const listbox = document.querySelector('[role="listbox"]')
  if (!listbox) throw new Error('The select did not open a listbox.')
  return listbox as HTMLElement
}

/** Open a select and pick the option with the given visible label. */
export async function chooseOption(trigger: Element, label: string): Promise<void> {
  const listbox = await openSelect(trigger)
  const option = [...listbox.querySelectorAll('[role="option"]')].find(
    (node) => node.textContent?.trim() === label
  )
  if (!option) {
    throw new Error(
      `No option labelled ${JSON.stringify(label)}; saw ${JSON.stringify(
        [...listbox.querySelectorAll('[role="option"]')].map((n) => n.textContent?.trim())
      )}`
    )
  }
  await fireEvent(option, pointer('pointerdown'))
  await fireEvent(option, pointer('pointerup'))
  await act()
}

function teardown(): void {
  stopListening?.()
  stopListening = null
  active?.restore()
  active = null
  // The store and the navigation are module singletons: every test starts from nothing
  // loaded, on the feed, rather than reading the last test's state for a tick.
  app.reset()
  nav.reset()
  // Likewise the check targets editor's working copy, which outlives any one panel, and
  // the motion preference, which only `App` keeps current.
  targetsDraft.reset()
  motion.reduced = false
}

afterEach(teardown)
