import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { net, privilegedSchemes, protocolHandlers, servedFiles, session } from '../test/electron'
import {
  APP_INDEX,
  APP_ORIGIN,
  denyRendererPermissions,
  registerAppScheme,
  resolveWithin,
  serveRenderer
} from './protocol'

const ROOT = '/Applications/Statusky.app/Contents/Resources/app/out/renderer'

/** Ask the installed `app:` handler for a URL, the way Chromium would. */
function request(url: string): Promise<Response> {
  const handler = protocolHandlers.get('app')
  if (!handler) throw new Error('No app: handler is installed.')
  return handler({ url } as Request)
}

beforeEach(() => {
  serveRenderer(ROOT)
  servedFiles.set(join(ROOT, 'index.html'), '<!doctype html><title>Statusky</title>')
  servedFiles.set(join(ROOT, 'assets/app.js'), 'export const a = 1')
  servedFiles.set(join(ROOT, 'assets/app.css'), ':root{}')
  servedFiles.set(join(ROOT, 'assets/icon.bin'), 'binary')
})

describe('registerAppScheme', () => {
  it('registers app: as a standard, secure scheme', () => {
    registerAppScheme()

    expect(privilegedSchemes).toEqual([
      {
        scheme: 'app',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true
        }
      }
    ])
  })

  // `standard` is what gives the popover a real origin instead of an opaque one, which
  // is the whole reason the IPC layer can validate it. The two are written in different
  // languages in different files, so nothing but this keeps them naming the same origin.
  it('produces the origin the IPC schema validates against', () => {
    expect(new URL(APP_INDEX).protocol + '//' + new URL(APP_INDEX).host).toBe(APP_ORIGIN)
    const schema = readFileSync(resolve('schemas/statusky.eipc'), 'utf8')
    expect(schema).toContain(`origin is "${APP_ORIGIN}"`)
  })
})

describe('resolveWithin', () => {
  it('maps the root to index.html', () => {
    expect(resolveWithin(ROOT, '/')).toBe(join(ROOT, 'index.html'))
  })

  it('resolves a nested asset', () => {
    expect(resolveWithin(ROOT, '/assets/app.js')).toBe(join(ROOT, 'assets/app.js'))
  })

  it('decodes percent-escapes in the path', () => {
    expect(resolveWithin(ROOT, '/assets/a%20b.js')).toBe(join(ROOT, 'assets/a b.js'))
  })

  it.each([
    ['a parent segment', '/../../../../etc/passwd'],
    ['a parent segment mid-path', '/assets/../../secrets.env'],
    ['a percent-encoded parent segment', '/%2e%2e/%2e%2e/etc/passwd'],
    ['the root itself', '/..']
  ])('refuses %s', (_name, pathname) => {
    expect(resolveWithin(ROOT, pathname)).toBeNull()
  })

  it('refuses a NUL byte', () => {
    expect(resolveWithin(ROOT, '/index.html%00.png')).toBeNull()
  })

  it('refuses a path that is not valid percent-encoding', () => {
    expect(resolveWithin(ROOT, '/%E0%A4%A')).toBeNull()
  })
})

describe('serveRenderer', () => {
  it('serves index.html as HTML', async () => {
    const response = await request(APP_INDEX)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    await expect(response.text()).resolves.toContain('Statusky')
  })

  // A module script served without a JavaScript type is refused by Chromium outright,
  // so the renderer would come up blank.
  it.each([
    ['/assets/app.js', 'text/javascript; charset=utf-8'],
    ['/assets/app.css', 'text/css; charset=utf-8']
  ])('labels %s correctly', async (path, type) => {
    const response = await request(`${APP_ORIGIN}${path}`)
    expect(response.headers.get('content-type')).toBe(type)
  })

  it('leaves an unrecognised extension to whatever net.fetch said', async () => {
    const response = await request(`${APP_ORIGIN}/assets/icon.bin`)
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('binary')
  })

  it('404s a file that is not in the bundle', async () => {
    const response = await request(`${APP_ORIGIN}/assets/missing.js`)
    expect(response.status).toBe(404)
  })

  it('404s another host on the same scheme', async () => {
    const response = await request('app://elsewhere/index.html')

    expect(response.status).toBe(404)
    expect(net.fetch).not.toHaveBeenCalled()
  })

  // URL parsing collapses parent segments before the handler sees them, encoded or
  // not, so a traversal lands inside the bundle and simply is not there.
  it.each([
    ['a literal parent segment', '/../../../../etc/passwd'],
    ['a percent-encoded parent segment', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd']
  ])('cannot escape the bundle with %s', async (_name, path) => {
    const response = await request(`${APP_ORIGIN}${path}`)

    expect(response.status).toBe(404)
    expect(net.fetch).toHaveBeenCalledWith(expect.stringContaining(`${ROOT}/etc/passwd`))
    expect(net.fetch).not.toHaveBeenCalledWith(expect.stringMatching(/file:\/\/\/etc\/passwd/))
  })

  // `resolveWithin` is the backstop for anything URL parsing hands through intact.
  it.each([
    ['a NUL byte', '/index.html%00.png'],
    ['broken percent-encoding', '/%E0%A4%A']
  ])('403s %s without ever reading a file', async (_name, path) => {
    const response = await request(`${APP_ORIGIN}${path}`)

    expect(response.status).toBe(403)
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('serves the bundle from the root it was given', async () => {
    await request(`${APP_ORIGIN}/assets/app.js`)
    expect(net.fetch).toHaveBeenCalledWith(pathToFileURL(join(ROOT, 'assets/app.js')).toString())
  })
})

describe('renderer permissions', () => {
  /** Permissions Chromium will hand a page unless something says otherwise. */
  const PERMISSIONS = [
    'media',
    'geolocation',
    'midi',
    'midiSysex',
    'notifications',
    'clipboard-read',
    'display-capture',
    'openExternal'
  ] as const

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(PERMISSIONS)('refuses a request for %s', (permission) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    denyRendererPermissions()

    expect(session.defaultSession.request(permission)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(permission))
  })

  // The silent half. `navigator.permissions.query` and `Notification.permission` read
  // this one, so a page denied the prompt could still believe it held the capability.
  it.each(PERMISSIONS)('reports %s as not held, without a prompt', (permission) => {
    denyRendererPermissions()

    expect(session.defaultSession.check(permission)).toBe(false)
  })

  // The popover's own origin gets no exemption: it has no use for any of this, and an
  // origin allowlist here would only be a second place for the real one to drift from.
  it('denies the popover’s own origin as flatly as any other', () => {
    denyRendererPermissions()

    expect(session.defaultSession.check('notifications', APP_ORIGIN)).toBe(false)
    expect(session.defaultSession.check('notifications', 'https://evil.test')).toBe(false)
  })
})
