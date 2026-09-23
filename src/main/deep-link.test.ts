import { describe, expect, it, vi, type Mock } from 'vitest'
import { app } from '../test/electron'
import { withPlatform } from '../test/harness'
import {
  deepLinkFromCommandLine,
  openDeepLink,
  parseDeepLink,
  registerProtocolClient,
  removeProtocolClient,
  watchDeepLinks,
  type DeepLinkTarget
} from './deep-link'

/**
 * A `statusky://` link is the one thing in this app that arrives from outside it with no
 * origin to check: anything on the machine can open one, and a web page can put one
 * behind a link. So most of what is asserted here is what a link *cannot* do — reach the
 * renderer, name a service this app does not measure, or survive being malformed — and
 * not merely that the four good shapes work.
 */

/** The four calls a link can make, as spies, plus a service catalogue to check against. */
function target(known: string[] = ['relay:bsky.network']): {
  open: Mock<() => void>
  timeline: Mock<() => void>
  network: Mock<(serviceId: string | null) => void>
  knows: DeepLinkTarget['knows']
} {
  return {
    open: vi.fn(),
    timeline: vi.fn(),
    network: vi.fn(),
    knows: (serviceId: string) => known.includes(serviceId)
  }
}

describe('parseDeepLink', () => {
  it('reads every shape the scheme documents', () => {
    expect(parseDeepLink('statusky://open')).toEqual({ kind: 'open' })
    expect(parseDeepLink('statusky://timeline')).toEqual({ kind: 'timeline' })
    expect(parseDeepLink('statusky://network')).toEqual({ kind: 'network', serviceId: null })
    expect(parseDeepLink('statusky://service/relay:bsky.network')).toEqual({
      kind: 'network',
      serviceId: 'relay:bsky.network'
    })
  })

  it('treats the bare scheme as a request for the app itself', () => {
    expect(parseDeepLink('statusky://')).toEqual({ kind: 'open' })
  })

  /**
   * The WHATWG parser lower-cases the scheme of every URL but only normalises the host
   * of the schemes it considers special, and `statusky:` is not one of them. Without the
   * lower-casing in `parseDeepLink` this link would be an unknown route.
   */
  it('does not care how the link is capitalised', () => {
    expect(parseDeepLink('STATUSKY://Network')).toEqual({ kind: 'network', serviceId: null })
  })

  it('decodes a service id that had to be escaped', () => {
    expect(parseDeepLink('statusky://service/pds%3Absky.social')).toEqual({
      kind: 'network',
      serviceId: 'pds:bsky.social'
    })
  })

  it('refuses a link that is not one of ours, or not a URL at all', () => {
    expect(parseDeepLink('https://statusky.community/network')).toBeNull()
    expect(parseDeepLink('app://statusky/index.html')).toBeNull()
    expect(parseDeepLink('not a url')).toBeNull()
    expect(parseDeepLink('')).toBeNull()
  })

  it('refuses a route it has never heard of', () => {
    expect(parseDeepLink('statusky://settings')).toBeNull()
    expect(parseDeepLink('statusky://accounts/add')).toBeNull()
  })

  /**
   * `statusky://service/` names no service, and a second path segment means the link is
   * describing something this app does not have.
   */
  it('refuses a service link that names no service, or more than one', () => {
    expect(parseDeepLink('statusky://service/')).toBeNull()
    expect(parseDeepLink('statusky://service')).toBeNull()
    expect(parseDeepLink('statusky://service/relay:bsky.network/down')).toBeNull()
  })

  /**
   * `%2F` is how somebody would try to slip a second segment past a parser that decoded
   * before it split, which is why the split happens first: what comes out is one id with
   * a slash in it, which `openDeepLink` then fails to find among the measured services.
   */
  it('keeps an escaped slash inside the one id rather than reading a second segment', () => {
    expect(parseDeepLink('statusky://service/relay%2Fbsky.network')).toEqual({
      kind: 'network',
      serviceId: 'relay/bsky.network'
    })
  })

  it('refuses a service id whose escaping is broken', () => {
    expect(parseDeepLink('statusky://service/%E0%A4%A')).toBeNull()
  })
})

describe('deepLinkFromCommandLine', () => {
  it('finds the URL the OS appended to a relaunch', () => {
    expect(
      deepLinkFromCommandLine([
        'C:\\Users\\a\\AppData\\Local\\statusky\\Statusky.exe',
        '--allow-file-access-from-files',
        'statusky://service/relay:bsky.network'
      ])
    ).toBe('statusky://service/relay:bsky.network')
  })

  it('answers null for an ordinary relaunch', () => {
    expect(deepLinkFromCommandLine(['/Applications/Statusky.app', '--no-sandbox'])).toBeNull()
    expect(deepLinkFromCommandLine([])).toBeNull()
  })

  it('is not fooled by the capitalisation of the scheme', () => {
    expect(deepLinkFromCommandLine(['Statusky.exe', 'Statusky://Open'])).toBe('Statusky://Open')
  })
})

describe('openDeepLink', () => {
  it('routes each shape to the view it names', () => {
    const deps = target()

    expect(openDeepLink('statusky://open', deps)).toBe(true)
    expect(openDeepLink('statusky://timeline', deps)).toBe(true)
    expect(openDeepLink('statusky://network', deps)).toBe(true)
    expect(openDeepLink('statusky://service/relay:bsky.network', deps)).toBe(true)

    expect(deps.open).toHaveBeenCalledTimes(1)
    expect(deps.timeline).toHaveBeenCalledTimes(1)
    expect(deps.network).toHaveBeenNthCalledWith(1, null)
    expect(deps.network).toHaveBeenNthCalledWith(2, 'relay:bsky.network')
  })

  /**
   * The one check that cannot be done by parsing: a service id is a string an attacker
   * chose until it has been matched against what this app is really measuring. An
   * unknown one is not passed on at all — the dashboard itself is the nearest honest
   * answer, and is what somebody with a stale bookmark wanted.
   */
  it('will not pass on a service it is not measuring', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deps = target()
    try {
      expect(openDeepLink('statusky://service/relay:evil.example', deps)).toBe(true)
      expect(deps.network).toHaveBeenCalledWith(null)
      expect(warn).toHaveBeenCalledWith(expect.any(String), 'relay:evil.example')
    } finally {
      warn.mockRestore()
    }
  })

  it('drops a link that means nothing, without interrupting anybody', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deps = target()
    try {
      expect(openDeepLink('statusky://drop-everything', deps)).toBe(false)
      expect(deps.open).not.toHaveBeenCalled()
      expect(deps.timeline).not.toHaveBeenCalled()
      expect(deps.network).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

/** An `open-url` event, including the `preventDefault` Electron expects to be called. */
function openUrl(url: string): ReturnType<typeof vi.fn> {
  const preventDefault = vi.fn()
  app.emit('open-url', { preventDefault }, url)
  return preventDefault
}

describe('watchDeepLinks', () => {
  /**
   * The case that decides whether this is worth having at all: a link that *launched*
   * the app. `open-url` fires as soon as the app is ready, which is before the startup
   * sequence has a popover to show, and Electron does not hold it for a listener
   * registered later. Held here, delivered when there is somewhere to deliver it to.
   */
  it('holds a link that arrives before the app can act on it', () => {
    const watcher = watchDeepLinks()
    const prevented = openUrl('statusky://network')
    expect(prevented).toHaveBeenCalled()

    const handle = vi.fn()
    watcher.route(handle)

    expect(handle).toHaveBeenCalledWith('statusky://network')
  })

  it('delivers later links as they arrive, in order', () => {
    const watcher = watchDeepLinks()
    const handle = vi.fn()
    watcher.route(handle)

    openUrl('statusky://open')
    openUrl('statusky://timeline')

    expect(handle.mock.calls).toEqual([['statusky://open'], ['statusky://timeline']])
  })

  it('hands over everything it held, exactly once', () => {
    const watcher = watchDeepLinks()
    openUrl('statusky://open')
    const first = vi.fn()
    watcher.route(first)

    const second = vi.fn()
    watcher.route(second)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })
})

describe('registering the scheme with the OS', () => {
  /**
   * The trailing `--` is the documented mitigation for the Electron protocol-handler
   * command-line injection bug (CVE-2018-1000006 and its bypass): Windows appends the
   * clicked URL to this command line verbatim, and without a terminator Chromium reads a
   * crafted link as switches rather than as a URL. Asserted rather than described,
   * because it is one edit away from being lost.
   */
  it('claims the scheme on Windows, with switch parsing terminated', async () => {
    await withPlatform('win32', () => {
      app.isPackaged = true
      expect(registerProtocolClient()).toBe(true)
    })

    expect(app.protocolClients).toEqual([
      { scheme: 'statusky', path: process.execPath, args: ['--'] }
    ])
  })

  /**
   * macOS registers through Launch Services from the packaged Info.plist and Linux
   * through the `.desktop` file, both written by forge.config.ts. Doing it from here as
   * well would be claiming the scheme for whatever binary happens to be running.
   */
  it('leaves macOS and Linux to the packaging', async () => {
    app.isPackaged = true
    await withPlatform('darwin', () => expect(registerProtocolClient()).toBe(false))
    await withPlatform('linux', () => expect(registerProtocolClient()).toBe(false))
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })

  /**
   * A build running out of the repository would point the whole machine's `statusky://`
   * handler at a copy of Electron in `node_modules`.
   */
  it('refuses to register an unpackaged build', async () => {
    await withPlatform('win32', () => expect(registerProtocolClient()).toBe(false))
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })

  it('gives the scheme back on uninstall, with the arguments it registered', async () => {
    await withPlatform('win32', () => {
      app.isPackaged = true
      registerProtocolClient()
    })

    expect(removeProtocolClient()).toBe(true)
    expect(app.removeAsDefaultProtocolClient).toHaveBeenCalledWith('statusky', process.execPath, [
      '--'
    ])
    expect(app.protocolClients).toEqual([])
  })
})
