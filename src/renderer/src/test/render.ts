/**
 * Renderer test helpers.
 *
 * `app` (the renderer store) is a module singleton, so each test re-points it at a
 * fresh bridge and re-runs `init()`. That mirrors what happens when the popover
 * loads, and keeps state from leaking between tests.
 */
import { act, fireEvent, render, type BoundFunction, type queries } from '@testing-library/svelte'
import { afterEach } from 'vitest'
import { installBridge, type BridgeOptions, type TestBridge } from '../../../test/bridge'
import { app } from '$lib/app-state.svelte'
import { nav } from '$lib/nav.svelte'
import Providers from './Providers.svelte'

type AnyComponent = Parameters<typeof render>[0]

type BoundQueries = { [P in keyof typeof queries]: BoundFunction<(typeof queries)[P]> }

/**
 * What the render helpers hand back: the standard Testing Library queries, plus
 * the handles a test needs to drive and tear down the component.
 */
export type Rendered = BoundQueries & {
  container: HTMLElement
  baseElement: HTMLElement
  debug(el?: HTMLElement | DocumentFragment): void
  rerender(props: Record<string, unknown>): Promise<void>
  unmount(): void
}

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
export async function renderWith(
  Component: AnyComponent,
  props: Record<string, unknown> = {},
  options: BridgeOptions = {}
): Promise<{ bridge: TestBridge } & Rendered> {
  const bridge = await connect(options)
  // Wrapped in the same providers `App.svelte` establishes, so components that
  // use a tooltip or another context-bound primitive mount the way they really do.
  const result = render(Component as never, { props } as never, {
    wrapper: Providers as never
  }) as unknown as Rendered
  await act()
  return { bridge, ...result }
}

/**
 * Render `App.svelte`, which establishes its own providers and calls `app.init()`
 * itself. Unlike `renderWith`, this does not connect the store first — doing so
 * would leave a second subscription behind and mask a real leak.
 */
export async function renderApp(
  Component: AnyComponent,
  options: BridgeOptions = {}
): Promise<{ bridge: TestBridge } & Rendered> {
  teardown()
  const bridge = installBridge(options)
  active = bridge
  const result = render(Component as never) as unknown as Rendered
  await act()
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
}

afterEach(teardown)
