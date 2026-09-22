import { extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol, session } from 'electron'

/**
 * The popover's own scheme.
 *
 * A packaged build used to load the renderer over `file:`, where every local page —
 * anything on disk, including something a user was tricked into opening — shares the
 * single opaque `file://` origin. That makes "is this call coming from my UI?"
 * unanswerable, which is exactly the question the IPC layer's origin validator asks.
 * Serving the renderer from `app://statusky` instead gives it a real, private origin
 * that nothing else on the machine can claim, so `origin is "app://statusky"` in
 * `schemas/statusky.eipc` means something.
 */
export const APP_SCHEME = 'app'
export const APP_HOST = 'statusky'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_INDEX = `${APP_ORIGIN}/index.html`

/** Extensions the renderer bundle actually ships. Anything else is served as bytes. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

/**
 * Declare `app:` as a standard, secure scheme. Standard is what gives it a tuple
 * origin (`app://statusky`) rather than an opaque one; secure is what lets it use the
 * APIs a normal https page can. Chromium only reads this table once, so it has to run
 * before `app.whenReady()`.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/**
 * Resolve a request path inside `root`, or `null` if it escapes.
 *
 * The path comes from the page, so `..` segments and absolute paths have to be refused
 * rather than clamped: this is the only thing standing between a renderer bug and the
 * rest of the disk.
 */
export function resolveWithin(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null

  const target = resolve(join(root, decoded === '/' ? '/index.html' : decoded))
  const inside = relative(root, target)
  if (inside === '' || inside.startsWith('..') || inside.startsWith(sep)) return null
  return target
}

/** Serve the built renderer from `root` over `app://statusky/`. Call after app ready. */
export function serveRenderer(root: string): void {
  const base = resolve(root)

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 })

    const file = resolveWithin(base, url.pathname)
    if (!file) return new Response('Forbidden', { status: 403 })

    const response = await net.fetch(pathToFileURL(file).toString())
    if (!response.ok) return response

    // `net.fetch` on a file: URL does not always label the body, and the renderer
    // needs the right type for its module scripts and stylesheets to load at all.
    const type = CONTENT_TYPES[extname(file).toLowerCase()]
    if (!type) return response
    const headers = new Headers(response.headers)
    headers.set('Content-Type', type)
    return new Response(response.body, { status: response.status, headers })
  })
}

/**
 * Refuse every permission a page can ask this app for.
 *
 * Giving the renderer its own origin is only half of the answer to "what is this page
 * allowed to do?" — the other half is Chromium's permission model, which decides on
 * its own defaults when nothing configures it. A menu bar popover that shows a feed
 * needs none of them: not the camera, not the microphone, not geolocation, not MIDI,
 * not the clipboard to read from, and not renderer-side notifications, because the
 * only notification path in this app is `src/main/notifications.ts` and it runs in the
 * main process where it can be told what was clicked.
 *
 * Both handlers matter, and they answer different questions. `setPermissionRequestHandler`
 * is the prompt — "may I?" — and `setPermissionCheckHandler` is the silent one Chromium
 * runs to decide whether a capability is already held, which is what synchronous APIs
 * like `navigator.permissions.query` and `Notification.permission` read. Denying only
 * the first would leave a page believing it had been granted something it could then
 * quietly use.
 *
 * This is the default session because the popover has no `partition`, so it is the
 * session the popover actually loads in. Device access — WebUSB, WebHID, Web Serial —
 * needs no handler of its own: with none installed Electron grants no device at all,
 * and installing one here could only widen that.
 */
export function denyRendererPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    // The popover asks for nothing, so anything reaching here is either a bug or a
    // page that is not ours. Either is worth a line; neither is worth a prompt.
    console.warn(`Refused a permission the popover should never ask for: ${permission}`)
    callback(false)
  })

  session.defaultSession.setPermissionCheckHandler(() => false)
}
