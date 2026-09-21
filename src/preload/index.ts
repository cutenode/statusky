/**
 * The bridge between the sandboxed renderer and the main process.
 *
 * There is nothing to wire by hand any more. Importing the generated preload module
 * checks this frame against the `PopoverOnly` validator in `schemas/statusky.eipc` and,
 * only if it passes, exposes the declared interfaces on `window.statusky` through
 * contextBridge. A page served from anywhere but the popover's own origin — or the
 * popover's own origin inside a sub-frame — gets nothing at all, and even if it did,
 * main re-checks the origin on every individual call.
 *
 * There is deliberately no generic `invoke` escape hatch: only the methods declared in
 * the schema exist, and each one validates its arguments.
 */
import '@ipc/preload/statusky'
