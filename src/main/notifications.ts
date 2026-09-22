import { Notification, shell } from 'electron'
import { probeServiceId } from '../shared/network'
import { SEVERITY_LABEL } from '../shared/status'
import { sourceLabel } from '../shared/webhook'
import type { Settings, StatusPost } from '../shared/types'

/** macOS truncates notification bodies aggressively; keep them scannable. */
const MAX_BODY = 220

/**
 * How long to wait for the OS to confirm a notification before assuming it
 * worked. macOS rejects within milliseconds when authorisation is missing, so
 * this only ever elapses on platforms that emit neither `show` nor `failed`.
 */
const CONFIRM_TIMEOUT_MS = 5_000

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

/**
 * Electron's `Notification` is a thin wrapper around a native object: once the
 * last JS reference goes away the banner can be collected before the OS has
 * shown it. Hold every live notification here until it resolves.
 */
const live = new Set<Notification>()

export interface NotificationDeps {
  /** The banner itself was clicked: open what it is about, and deal with it. */
  onOpened(post: StatusPost): void
  /** The banner's *Mark as read* button: deal with it without opening anything. */
  onMarkRead(post: StatusPost): void
  /** The banner's *Show on dashboard* button, offered only for what the checks filed. */
  onShowNetwork(serviceId: string): void
  /** Called when the OS refuses a notification, e.g. authorisation is denied. */
  onFailed?(reason: string, post?: StatusPost): void
}

/** A button on a banner, and what pressing it does. */
interface BannerAction {
  text: string
  run(): void
}

/**
 * The buttons on one update's banner.
 *
 * A banner that can only be clicked or ignored is an interruption: the only way to
 * finish with it is to stop what you are doing, let it open a browser tab, and come
 * back. Both of these end the task where it started — one deals with the update, the
 * other takes you to the one place that can say more about it than the banner can.
 *
 * Order is load-bearing. `notification.on('action')` reports which button was pressed
 * as an index into this array and nothing else, so the array is built once and indexed
 * back into rather than re-derived; a second list of labels somewhere else is how the
 * wrong button ends up marking something read.
 *
 * *Show on dashboard* is conditional because the dashboard cannot show an ordinary
 * status post: an operator's sentence about an incident lives on their status page,
 * which is what clicking the banner opens. Only the entries this app's own checks filed
 * are about a service the dashboard has a row for, and `probeServiceId` is what says so.
 *
 * On macOS these buttons need the same thing notifications themselves need, and fail
 * the same way without it: a properly signed build. An unsigned development build is
 * never granted notification authorisation at all — see `explainFailure` — so there is
 * no banner for the buttons to be missing from. `NSUserNotificationAlertStyle: 'alert'`
 * in forge.config.ts is the other half: a banner-style notification on macOS shows its
 * actions only under the hover-revealed chevron, while an alert shows them outright.
 */
function bannerActions(post: StatusPost, deps: NotificationDeps): BannerAction[] {
  const actions: BannerAction[] = [{ text: 'Mark as read', run: () => deps.onMarkRead(post) }]

  const serviceId = probeServiceId(post)
  if (serviceId) {
    actions.push({ text: 'Show on dashboard', run: () => deps.onShowNetwork(serviceId) })
  }
  return actions
}

/**
 * The Action Center slot an update should take; nothing, for one that gets its own.
 *
 * A relay that flaps produces one entry per transition, and on Windows each is a
 * separate row in the Action Center: come back to the machine and find nine of them,
 * eight of which are already wrong. Windows replaces rather than stacks a toast whose
 * `Group` and `Tag` match one already showing, so keying the tag on the service leaves
 * exactly one row per service, saying what that service is doing *now* — which is the
 * only thing anybody wants from a notification about a machine.
 *
 * Electron reaches both properties through the constructor: `id` is the toast's `Tag`
 * and `groupId` is its `Group`. Doing it this way rather than through a raw `toastXml`
 * is deliberate and is worth saying why, because the XML route is the one the internet
 * suggests. `Tag` and `Group` are properties of the `ToastNotification` object and not
 * attributes of the toast XML, so a hand-written document cannot carry them at all;
 * Electron sets both from these options whether the XML is custom or its own. And
 * `toastXml` *replaces* the body Electron would have built, which is where the action
 * buttons above live — so taking the XML route would mean re-emitting those buttons by
 * hand, with `arguments` in the private format Electron parses an action index back out
 * of. Two descriptions of one banner, one of them undocumented, in exchange for nothing.
 *
 * macOS is given the same keys, which is not what this was for but is right for the
 * same reason: `id` is the `UNNotificationRequest` identifier and re-using it replaces
 * the delivered banner, so a flapping service occupies one slot in Notification Center
 * there too, and `groupId` threads them together.
 *
 * Only the checks' own entries collapse. A status page posting *investigating*, then
 * *identified*, then *resolved* is telling a story, and replacing each sentence with
 * the next one would throw away the two the operator wrote first.
 */
function collapseKeys(post: StatusPost): { id: string; groupId: string } | undefined {
  const serviceId = probeServiceId(post)
  return serviceId ? { id: serviceId, groupId: 'services' } : undefined
}

export function notifySupported(): boolean {
  return Notification.isSupported()
}

/**
 * Turn the OS's own wording into something a user can act on.
 *
 * macOS reports a missing authorisation as the opaque `UNErrorDomain error 1`
 * (`UNErrorCodeNotificationsNotAllowed`), which tells the user nothing about the
 * two things that actually cause it: permission denied in System Settings, or a
 * build macOS will not register at all because it is not properly code signed.
 */
export function explainFailure(raw: string): string {
  const notAllowed = /UNErrorDomain error 1\b/.test(raw) || /not allowed/i.test(raw)
  if (!notAllowed) return raw

  return (
    'macOS is blocking notifications from this app. ' +
    'Allow them under System Settings › Notifications — and note that ' +
    'unsigned development builds are never offered that permission.'
  )
}

/**
 * Show a notification and settle once the OS has accepted or refused it.
 *
 * `failed` (darwin, win32) is the only signal that Notification Center dropped
 * the banner — an unauthorised app gets no other feedback — so never ignore it.
 */
function show(notification: Notification): Promise<void> {
  live.add(notification)

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      live.delete(notification)
      fn()
    }

    const timer = setTimeout(() => settle(resolve), CONFIRM_TIMEOUT_MS)
    timer.unref?.()

    notification.once('show', () => settle(resolve))
    notification.once('failed', (_event, error) =>
      settle(() =>
        reject(new Error(explainFailure(String(error)) || 'The system refused the notification.'))
      )
    )

    notification.show()
  })
}

/**
 * Raise one OS notification per post. Callers pass posts oldest-first so the
 * newest incident ends up on top of the notification stack.
 */
export function notifyPosts(posts: StatusPost[], settings: Settings, deps: NotificationDeps): void {
  if (!Notification.isSupported()) {
    if (posts.length) deps.onFailed?.('This system does not support notifications.')
    return
  }

  for (const post of posts) {
    const actions = bannerActions(post, deps)
    const notification = new Notification({
      title: `${post.authorDisplayName} · ${SEVERITY_LABEL[post.severity]}`,
      body: truncate(post.text, MAX_BODY) || 'Posted a status update.',
      subtitle: sourceLabel(post.authorDid, post.authorHandle),
      silent: !settings.notificationSound,
      timeoutType: 'default',
      actions: actions.map((action) => ({ type: 'button' as const, text: action.text })),
      ...collapseKeys(post)
    })

    notification.on('click', () => {
      deps.onOpened(post)
      // A pushed update need not link anywhere; marking it read is still the point.
      if (post.url) void shell.openExternal(post.url)
    })

    // The index is read off the event object rather than the deprecated positional
    // argument beside it. An index the OS reports that this banner has no button for
    // is not a thing that should happen and is not worth crashing the main process
    // over, so it is simply dropped.
    notification.on('action', (event) => actions[event.actionIndex]?.run())

    // A dropped banner is the one failure the user cannot see for themselves.
    void show(notification).catch((error: Error) => deps.onFailed?.(error.message, post))
  }
}

/** "Bluesky", "Bluesky and Blacksky", "Bluesky, Blacksky and 2 others". */
function listSources(names: string[]): string {
  const unique = [...new Set(names)]
  if (unique.length <= 2) return unique.join(' and ')
  const [first, second, ...rest] = unique
  return `${first}, ${second} and ${rest.length} other${rest.length === 1 ? '' : 's'}`
}

export interface DigestDeps {
  /** The summary was clicked. Its job is to open the Timeline; see `notifyDigest`. */
  onOpened(): void
  onFailed?(reason: string): void
}

/**
 * Raise one banner for everything that happened while nobody was at the machine.
 *
 * An incident that broke and resolved over lunch is two banners nobody saw, and six of
 * them stacked in Notification Center on the way back is worse than one: they arrive out
 * of any order that means anything, each one opens a single post, and the state they
 * describe has already moved on. One line saying how many and from where, opening the
 * tab that shows the lot in order, is the same information in the form the app already
 * argues for — the Timeline is what catches you up.
 *
 * Deliberately not a per-post path with a different title: it opens nowhere in
 * particular and marks nothing read, because the user has not read any of it yet.
 */
export function notifyDigest(posts: StatusPost[], settings: Settings, deps: DigestDeps): void {
  if (!Notification.isSupported()) {
    deps.onFailed?.('This system does not support notifications.')
    return
  }

  const sources = listSources(posts.map((post) => post.authorDisplayName))
  // No action buttons, deliberately. Both of the ones an ordinary banner carries answer
  // for a specific update, and this banner has deliberately not shown the user any: its
  // body is a count and a list of sources, so *Mark as read* here would be marking
  // things read on behalf of somebody who has not seen them, which is the one thing the
  // waiting room in `createNotifier` exists to avoid. Its single gesture is the click
  // that opens the Timeline, where the updates are, in order, still unread.
  const notification = new Notification({
    title: 'Statusky · While you were away',
    body: truncate(`${posts.length} updates from ${sources}`, MAX_BODY),
    silent: !settings.notificationSound,
    timeoutType: 'default'
  })

  notification.on('click', () => deps.onOpened())
  void show(notification).catch((error: Error) => deps.onFailed?.(error.message))
}

export interface NotifierDeps extends NotificationDeps {
  /** Whether nobody is at the machine, asked the moment a banner would go up. */
  away(): boolean
  /** Of the held updates, the ones still worth announcing. See `Model.stillUnread`. */
  stillWorthSaying(posts: StatusPost[]): StatusPost[]
  /** The summary was clicked: show the Timeline. */
  onCatchUp(): void
}

export interface Notifier {
  /** Announce these updates, or hold them back if there is nobody there to see them. */
  notify(posts: StatusPost[]): void
  /** Somebody is back: say once what was held back, and forget it either way. */
  release(): void
}

/**
 * The notification path, with a waiting room in front of it.
 *
 * Holding changes nothing about what an update *is*: a held banner marks nothing read
 * and moves no cursor, so an incident the user never saw a banner for is still unread
 * when they sit back down, and the tray icon has been beating at them the whole time.
 * That is also what makes the release safe to filter — anything dealt with in the
 * popover while its banner waited is no longer news, and announcing it then would be
 * the notification resurrecting something the user had already finished with.
 */
export function createNotifier(settings: () => Settings, deps: NotifierDeps): Notifier {
  let pending: StatusPost[] = []

  return {
    notify(posts: StatusPost[]): void {
      if (!posts.length) return
      if (deps.away()) {
        pending.push(...posts)
        return
      }
      notifyPosts(posts, settings(), deps)
    },

    release(): void {
      const worthSaying = deps.stillWorthSaying(pending)
      pending = []
      if (!worthSaying.length) return
      // One update is not a digest. Summarising a single incident as "1 update from
      // Bluesky" throws away the sentence the operator wrote, and the ordinary banner
      // already opens the right thing.
      if (worthSaying.length === 1) {
        notifyPosts(worthSaying, settings(), deps)
        return
      }
      notifyDigest(worthSaying, settings(), {
        onOpened: () => deps.onCatchUp(),
        onFailed: deps.onFailed
      })
    }
  }
}

/**
 * Send the sample notification behind the settings panel's "Send test" button.
 * Rejects when the OS refuses, so the UI can say so instead of claiming success.
 */
export async function notifyTest(settings: Settings): Promise<void> {
  if (!Notification.isSupported()) {
    throw new Error('This system does not support notifications.')
  }

  await show(
    new Notification({
      title: 'Statusky · Monitoring',
      body: 'Notifications are working. You will see status updates here.',
      silent: !settings.notificationSound
    })
  )
}
