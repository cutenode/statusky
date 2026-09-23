import { Notification, shell } from 'electron'
import { probeServiceId } from '../shared/network'
import {
  bannerSound,
  inQuietHours,
  quietHoursEnd,
  snoozedUntil,
  URGENT_SEVERITIES
} from '../shared/notify'
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
      // Hidden text still leaves a body: an empty one reads as a broken banner.
      body: settings.notificationShowBody
        ? truncate(post.text, MAX_BODY) || 'Posted a status update.'
        : 'Posted a status update.',
      subtitle: sourceLabel(post.authorDid, post.authorHandle),
      silent: !bannerSound(settings, [post.severity]),
      // `never` only holds on macOS when Statusky's banners are set to the Alerts style,
      // which forge.config.ts asks for; everywhere else it is a request the OS may round
      // down, and the worst it can do is behave like `default`.
      timeoutType: settings.notifyStickyOutages && post.severity === 'outage' ? 'never' : 'default',
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
export function notifyDigest(
  posts: StatusPost[],
  settings: Settings,
  deps: DigestDeps,
  heading: string = 'While you were away'
): void {
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
    title: `Statusky · ${heading}`,
    body: truncate(`${posts.length} updates from ${sources}`, MAX_BODY),
    silent: !bannerSound(
      settings,
      posts.map((post) => post.severity)
    ),
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
  /** The clock, for tests. */
  now?(): number
}

export interface Notifier {
  /** Announce these updates, or hold them back if this is not the moment. */
  notify(posts: StatusPost[]): void
  /** Somebody is back at the machine: say once what was held for them. */
  release(): void
  /**
   * The settings changed, or a timer came due: announce whatever is no longer held back
   * by a snooze or quiet hours. Unlike `release` this does not take anyone's presence
   * for granted, so it is safe to call on every state change.
   */
  reconsider(): void
  /** Forget every timer, for shutdown and for tests. */
  dispose(): void
}

/** Why a banner is waiting. Each has its own line on the summary that ends the wait. */
type HoldReason = 'snooze' | 'quiet' | 'away'

const DIGEST_HEADING: Record<HoldReason | 'burst', string> = {
  snooze: 'While notifications were paused',
  quiet: 'During quiet hours',
  away: 'While you were away',
  burst: 'More updates'
}

/**
 * How long after a banner further updates are folded into one summary rather than
 * raised one by one. An incident tends to arrive as a status post, a second post that
 * corrects it and the checks' own entry within a minute or two of each other.
 */
export const BURST_WINDOW_MS = 2 * 60_000

/** Slack on the timers that end a hold, so they land after the boundary and not on it. */
const WAKE_SLACK_MS = 1_000

/**
 * The notification path, with a waiting room in front of it.
 *
 * `selectNotifiable` and `applyFollowUps` have already decided *what* is worth a banner;
 * this decides *when*. A measured outage can be made to wait out a grace period, and a
 * recovery inside it cancels both banners. Banners wait out a snooze, quiet hours (bar
 * outages, if the user lets them through) and an absence, then go up as one summary.
 * Updates that arrive just after a banner are folded into one summary at the end of a
 * short window.
 *
 * Holding changes nothing about what an update *is*: a held banner marks nothing read
 * and moves no cursor, so an incident the user never saw a banner for is still unread
 * when they sit back down, and the tray icon has been beating at them the whole time.
 * That is also what makes the release safe to filter — anything dealt with in the
 * popover while its banner waited is no longer news, and announcing it then would be
 * the notification resurrecting something the user had already finished with.
 */
export function createNotifier(settings: () => Settings, deps: NotifierDeps): Notifier {
  const now = (): number => deps.now?.() ?? Date.now()

  let held: { post: StatusPost; reason: HoldReason }[] = []
  /** Measured outages waiting out `notifyProbeGraceSec`, by service. */
  const grace = new Map<string, { post: StatusPost; timer: ReturnType<typeof setTimeout> }>()
  let burst: StatusPost[] = []
  let burstUntil = 0
  let burstTimer: ReturnType<typeof setTimeout> | null = null
  let wakeTimer: ReturnType<typeof setTimeout> | null = null

  function holdReason(post: StatusPost, presenceKnown: boolean): HoldReason | null {
    const current = settings()
    const at = new Date(now())
    if (snoozedUntil(current, at)) return 'snooze'
    const breaksThrough =
      current.quietHoursBreakthrough && URGENT_SEVERITIES.includes(post.severity)
    if (inQuietHours(current, at) && !breaksThrough) return 'quiet'
    if (!presenceKnown && current.notifyWhenAway !== 'deliver' && deps.away()) return 'away'
    return null
  }

  /** Book a wake-up for when the snooze or quiet hours holding something end. */
  function scheduleWake(): void {
    if (wakeTimer) clearTimeout(wakeTimer)
    wakeTimer = null
    if (!held.some((entry) => entry.reason !== 'away')) return

    const current = settings()
    const at = new Date(now())
    const ends = [
      snoozedUntil(current, at),
      inQuietHours(current, at) ? quietHoursEnd(current, at) : null
    ].filter((end): end is Date => end !== null)
    // No end in sight means the hold ended while its wake-up was still waiting out the
    // slack, and an update delivered in that second has just cleared it. What it held is
    // free to go, so book the wake-up for now rather than drop it.
    const soonest = ends.length ? Math.min(...ends.map((end) => end.getTime())) : now()
    wakeTimer = setTimeout(
      () => {
        wakeTimer = null
        settle(false)
      },
      Math.max(soonest - now(), 0) + WAKE_SLACK_MS
    )
    wakeTimer.unref?.()
  }

  /** One update is a banner; more than one is a summary that opens the Timeline. */
  function summarise(posts: StatusPost[], reason: HoldReason | 'burst'): void {
    if (!posts.length) return
    // One update is not a digest. Summarising a single incident as "1 update from
    // Bluesky" throws away the sentence the operator wrote, and the ordinary banner
    // already opens the right thing.
    if (posts.length === 1) {
      notifyPosts(posts, settings(), deps)
      return
    }
    notifyDigest(
      posts,
      settings(),
      { onOpened: () => deps.onCatchUp(), onFailed: deps.onFailed },
      DIGEST_HEADING[reason]
    )
  }

  function flushBurst(): void {
    burstTimer = null
    const posts = deps.stillWorthSaying(burst.splice(0))
    summarise(posts, 'burst')
    if (posts.length) burstUntil = now() + BURST_WINDOW_MS
  }

  function present(posts: StatusPost[]): void {
    if (!posts.length) return
    const current = settings()
    if (!current.notifyCombineBursts) {
      notifyPosts(posts, current, deps)
      return
    }
    if (now() < burstUntil) {
      burst.push(...posts)
      if (!burstTimer) {
        burstTimer = setTimeout(flushBurst, burstUntil - now())
        burstTimer.unref?.()
      }
      return
    }
    notifyPosts(posts, current, deps)
    burstUntil = now() + BURST_WINDOW_MS
  }

  function deliver(posts: StatusPost[]): void {
    if (!settings().notificationsEnabled) return
    const ready: StatusPost[] = []
    for (const post of posts) {
      const reason = holdReason(post, false)
      if (!reason) ready.push(post)
      // Staying silent while away is holding and then saying nothing, which is the same
      // as never holding: the update is unread either way.
      else if (reason !== 'away' || settings().notifyWhenAway === 'digest') {
        held.push({ post, reason })
      }
    }
    scheduleWake()
    present(ready)
  }

  /** Announce whatever is no longer held back. `presenceKnown`: somebody just came back. */
  function settle(presenceKnown: boolean): void {
    if (!held.length) return
    if (!settings().notificationsEnabled) {
      held = []
      scheduleWake()
      return
    }
    const waiting: typeof held = []
    const ready: typeof held = []
    for (const entry of held) {
      const reason = holdReason(entry.post, presenceKnown)
      if (reason) waiting.push({ post: entry.post, reason })
      else ready.push(entry)
    }
    held = waiting
    scheduleWake()
    if (!ready.length) return

    const worthSaying = deps.stillWorthSaying(ready.map((entry) => entry.post))
    summarise(worthSaying, ready[0]!.reason)
  }

  return {
    notify(posts: StatusPost[]): void {
      if (!posts.length) return
      const graceMs = settings().notifyProbeGraceSec * 1000
      const immediate: StatusPost[] = []

      for (const post of posts) {
        const serviceId = probeServiceId(post)
        const pending = serviceId ? grace.get(serviceId) : undefined

        if (serviceId && pending) {
          if (post.severity === 'resolved') {
            // Back inside the grace period: a blip, and not worth either banner.
            clearTimeout(pending.timer)
            grace.delete(serviceId)
          } else {
            // Down became partial or the other way round; the clock keeps running.
            pending.post = post
          }
          continue
        }

        if (serviceId && graceMs > 0 && post.severity !== 'resolved') {
          const timer = setTimeout(() => {
            const entry = grace.get(serviceId)
            grace.delete(serviceId)
            if (entry) deliver([entry.post])
          }, graceMs)
          timer.unref?.()
          grace.set(serviceId, { post, timer })
          continue
        }

        immediate.push(post)
      }

      deliver(immediate)
    },

    release(): void {
      settle(true)
    },

    reconsider(): void {
      settle(false)
    },

    dispose(): void {
      for (const { timer } of grace.values()) clearTimeout(timer)
      grace.clear()
      if (burstTimer) clearTimeout(burstTimer)
      if (wakeTimer) clearTimeout(wakeTimer)
      burstTimer = wakeTimer = null
      held = []
      burst = []
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
      silent: settings.notificationSound === 'never'
    })
  )
}
