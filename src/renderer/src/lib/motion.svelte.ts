/**
 * Report the OS's reduced-motion preference to the main process.
 *
 * The mirror image of `theme.svelte.ts`: there, main owns the answer and the page
 * mirrors it; here the page is the only one who can be told, and main is the one that
 * needs to know. Electron's `nativeTheme` covers dark mode and high contrast and stops,
 * so `matchMedia` in a renderer is the whole of this app's access to the setting.
 *
 * What needs it is the menu bar icon's heartbeat — ten icon swaps a second, in the
 * corner of the screen, for as long as something is unread — which is exactly the kind
 * of motion the preference exists to stop, and which lives in the main process where
 * nothing can read it. See `Popover` in schemas/statusky.eipc for the crossing, and
 * `resolveStyle` in src/main/tray.ts for what is done with the answer.
 *
 * Pushed once on mount as well as on every change: main assumes reduced motion until a
 * page says otherwise, so this first call is what gives their heartbeat back to everyone
 * who never asked for it to stop.
 */
export function startReducedMotionSync(report: (reduce: boolean) => void): () => void {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')

  const push = (): void => report(query.matches)

  push()
  query.addEventListener('change', push)
  return () => query.removeEventListener('change', push)
}
