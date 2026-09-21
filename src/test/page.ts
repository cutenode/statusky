/**
 * The page identity a preload script sees.
 *
 * The generated preload decides whether to expose anything by reading
 * `window.location.href` and comparing it against the origin in
 * `schemas/statusky.eipc`. Outside a browser there is no `window`, so the node test
 * project supplies one — and by making it settable, a test can serve the preload a
 * different origin and check that it is turned away.
 *
 * `src/test/setup.ts` resets this to the popover's real origin between tests. In the
 * renderer project jsdom provides the real thing and this does nothing: assigning to a
 * live `location.href` would try to navigate.
 */
import { APP_INDEX } from '../main/protocol'

/** Where the popover is genuinely served from in a packaged build. */
export const POPOVER_URL = APP_INDEX

type Stub = { window?: { location: { href: string } }; document?: unknown }

/** True in the node project, where `window` is ours to invent. */
function stubbed(): boolean {
  return (globalThis as Stub).document === undefined
}

export function setPageUrl(href: string): void {
  if (!stubbed()) return
  const target = globalThis as Stub
  if (target.window) target.window.location.href = href
  else target.window = { location: { href } }
}

export function resetPage(): void {
  setPageUrl(POPOVER_URL)
}
