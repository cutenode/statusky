import { app } from 'electron'

/**
 * The `statusky://` URL scheme: the OS's way of asking this app for a particular view.
 *
 * **This is not `app://statusky`, and the difference is the whole of this file's
 * safety.** `app://statusky` is the private, privileged scheme the popover's own page is
 * served from (src/main/protocol.ts); `origin is "app://statusky"` in
 * schemas/statusky.eipc is what tells the IPC layer a call came from our own UI. A
 * `statusky://` link is the opposite kind of thing in every respect: anything on the
 * machine can hand one to Launch Services or `xdg-open`, a web page can put one behind a
 * link, and the content is entirely attacker-chosen. The two names look alike, which is
 * exactly why the rule has to be written down: **nothing arriving here is ever loaded,
 * navigated to, or handed to the renderer as a URL.** A link is parsed into one of a
 * closed set of intentions below, and only that intention crosses into the app — the
 * same treatment `Host.openExternal` gives a post's link, and for the same reason.
 *
 * The shapes, which are the documented interface:
 *
 * - `statusky://open` — show the popover, wherever it was left. A bare `statusky://`
 *   means this too, because that is what somebody typing the scheme alone wants.
 * - `statusky://timeline` — show the popover on the Timeline, the tab that catches you up.
 * - `statusky://network` — show the network dashboard.
 * - `statusky://service/<id>` — show the dashboard scrolled to one service, where `<id>`
 *   is a probe id such as `relay:bsky.network`. The id is checked against the services
 *   this build actually measures before it goes anywhere near the popover; an unknown
 *   one falls back to the dashboard rather than being passed along.
 *
 * Deliberately no shape that carries text, a URL, an account to add, or anything else
 * that would end up rendered or acted on. Everything here names a view this app already
 * has, and the worst a hostile link can do is put the popover on screen.
 */
export const DEEP_LINK_SCHEME = 'statusky'

/** What a `statusky://` link resolves to. A closed set, on purpose. */
export type DeepLink =
  | { kind: 'open' }
  | { kind: 'timeline' }
  /** `serviceId` is null for the dashboard itself. */
  | { kind: 'network'; serviceId: string | null }

/**
 * Turn a URL the OS handed us into an intention, or null if it is not one of ours.
 *
 * The host is lower-cased here rather than trusted to arrive that way: the WHATWG URL
 * parser normalises the case of the *scheme* for every URL, but only normalises the host
 * for the schemes it considers special (http, https, ws, file…), and `statusky:` is not
 * one of them. `statusky://Network` therefore arrives with a capital N, and without this
 * it would be an unknown route.
 */
export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null

  switch (url.hostname.toLowerCase()) {
    // `statusky://` with nothing after it: the scheme on its own is a request for the app.
    case '':
    case 'open':
      return { kind: 'open' }
    case 'timeline':
      return { kind: 'timeline' }
    case 'network':
      return { kind: 'network', serviceId: null }
    case 'service': {
      // One path segment, decoded. A link with more than that is malformed rather than
      // meaningful, and `%2F` inside the id is how somebody would try to smuggle a second
      // segment past a naive split, so the decoding happens after the segment is taken.
      const [segment, ...rest] = url.pathname.replace(/^\//, '').split('/')
      if (!segment || rest.length) return null
      try {
        return { kind: 'network', serviceId: decodeURIComponent(segment) }
      } catch {
        return null
      }
    }
    default:
      return null
  }
}

/**
 * The `statusky://` URL in a command line, or null when there is none.
 *
 * Windows and Linux do not have macOS's `open-url`: a deep link opened while the app is
 * already running arrives as an argument to a *second copy* of the app, which the
 * single-instance lock turns into a `second-instance` event carrying that copy's whole
 * command line. Searched from the end because that is where the OS appends it, and
 * matched on the scheme rather than on position because the rest of the command line is
 * Chromium's and grows switches between releases.
 */
export function deepLinkFromCommandLine(argv: readonly string[]): string | null {
  for (let index = argv.length - 1; index >= 0; index--) {
    const argument = argv[index]
    if (argument?.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) return argument
  }
  return null
}

/** The views a deep link is allowed to ask for, and the one question it may ask. */
export interface DeepLinkTarget {
  /** Show the popover, wherever it was left. */
  open(): void
  /** Show the Timeline. */
  timeline(): void
  /** Show the network dashboard, at one service when one was named. */
  network(serviceId: string | null): void
  /** Whether this app is actually measuring a service with that id. */
  knows(serviceId: string): boolean
}

/**
 * Act on a `statusky://` URL, and report whether it meant anything.
 *
 * The service id is checked against what is really being measured before it is passed
 * on, which is the one piece of validation that cannot be done by parsing. It is not
 * about the popover being harmed by an unknown id — `reveal` would simply find nothing
 * to scroll to — but about keeping the promise this file opens with: what crosses into
 * the app is a view this app already has, never a string an attacker chose. An id we do
 * not know falls back to the dashboard itself, because that is the nearest thing to what
 * the link asked for and is certainly what somebody with a stale bookmark wants.
 *
 * A URL that is not one of ours is logged and dropped. There is no dialog: a deep link
 * can be sent by anything on the machine, and an app that opens a message box on demand
 * is an app anything on the machine can use to interrupt you.
 */
export function openDeepLink(raw: string, target: DeepLinkTarget): boolean {
  const link = parseDeepLink(raw)
  if (!link) {
    console.warn('Ignored a deep link that names nothing in this app:', raw)
    return false
  }

  switch (link.kind) {
    case 'open':
      target.open()
      return true
    case 'timeline':
      target.timeline()
      return true
    default: {
      const { serviceId } = link
      if (serviceId !== null && !target.knows(serviceId)) {
        console.warn('Deep link named a service that is not measured here:', serviceId)
        target.network(null)
        return true
      }
      target.network(serviceId)
      return true
    }
  }
}

export interface DeepLinkWatcher {
  /**
   * Start handling links, including any that arrived before the app was ready to.
   * Called once, from the startup sequence.
   */
  route(handle: (url: string) => void): void
}

/**
 * Listen for macOS's `open-url` from the moment the process starts.
 *
 * This has to be attached before `app.whenReady()` resolves, and cannot wait for the
 * rest of the startup sequence. A deep link that *launches* the app — the app was not
 * running, the user clicked a `statusky://` link, Launch Services started us — is
 * delivered as `open-url` as soon as the app is ready, and Electron does not queue it
 * for a listener that is not there yet. Registering late means the link that started the
 * app is the one link that does nothing, which is the worst possible one to lose.
 *
 * So the listener goes on immediately and holds what it receives until there is
 * something to do with it. `preventDefault` tells Electron we have handled the URL; the
 * default is to do nothing, but saying so is what stops that changing under us.
 */
export function watchDeepLinks(): DeepLinkWatcher {
  const waiting: string[] = []
  let handle: ((url: string) => void) | null = null

  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (handle) handle(url)
    else waiting.push(url)
  })

  return {
    route(next: (url: string) => void): void {
      handle = next
      for (const url of waiting.splice(0)) next(url)
    }
  }
}

/**
 * Claim `statusky://` from Windows at runtime.
 *
 * Forge writes no registry entries — `packagerConfig.protocols` reaches macOS's
 * `Info.plist` and nothing else, and the Squirrel installer has no protocol support at
 * all — so on Windows the running app registers itself, every launch. That also keeps
 * the registration pointing at the right binary: Squirrel installs each version into its
 * own `app-<version>` directory, so an entry written once at install time would name a
 * path that the next update deletes.
 *
 * **The trailing `'--'` is not optional.** It is the documented mitigation for the
 * Electron protocol-handler command-line injection class of bug — CVE-2018-1000006 and
 * the bypass found in its first fix. Windows appends the clicked URL to the registered
 * command line verbatim, so without a terminator a crafted `statusky://` link is read by
 * Chromium as *switches* rather than as a URL: `--gpu-launcher=`, `--no-sandbox`,
 * `--renderer-cmd-prefix=` and friends turn a link on a web page into arbitrary command
 * execution on the machine. `--` ends switch parsing, so everything after it can only
 * ever be positional — which is all this app wants from it anyway.
 *
 * Only for a packaged Windows build. macOS registers through Launch Services from the
 * bundle's `Info.plist` and Linux through the `.desktop` file's `MimeType=`, both
 * written at packaging time; and registering from a build running out of the repository
 * would point the whole machine's `statusky://` handler at a copy of Electron in
 * `node_modules`, which is a thing to do to your own computer on purpose, never by
 * accident.
 */
export function registerProtocolClient(): boolean {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  return app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, ['--'])
}

/**
 * Hand `statusky://` back, on the way out of an uninstall.
 *
 * Takes the same executable and arguments as the registration: Electron matches the
 * entry it is asked to remove against them, and a mismatch is not an error, it is a
 * registry key left behind pointing at an application that no longer exists.
 */
export function removeProtocolClient(): boolean {
  return app.removeAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, ['--'])
}
