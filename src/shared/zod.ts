/**
 * Zod, configured for whichever process has loaded it.
 *
 * Zod compiles a fast path for every object schema with `new Function`, and finds out
 * whether it is allowed to by trying once, the moment the first object schema is built.
 * The popover's page runs under a Content-Security-Policy with no `'unsafe-eval'` (see
 * src/renderer/index.html), so that probe fails — which Zod expects and swallows, and
 * which Chromium reports anyway, as a `securitypolicyviolation` and a console error on
 * every launch, about code nobody asked to run. The renderer builds these schemas now,
 * because the probe targets the Settings panel edits are validated there as well as at
 * the IPC boundary, so anywhere with a `document` is told up front to go without. Main
 * has no page and no policy, and keeps the compiled path.
 *
 * Everything in `src/shared` that builds a schema imports `z` from here rather than from
 * `zod`: the setting only counts if it lands before the first schema is built.
 */
import { z } from 'zod'

if ('document' in globalThis) z.config({ jitless: true })

export { z }
