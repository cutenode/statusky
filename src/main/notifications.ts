import { Notification, shell } from 'electron'
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
  onOpened(post: StatusPost): void
  /** Called when the OS refuses a notification, e.g. authorisation is denied. */
  onFailed?(reason: string, post?: StatusPost): void
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
    const notification = new Notification({
      title: `${post.authorDisplayName} · ${SEVERITY_LABEL[post.severity]}`,
      body: truncate(post.text, MAX_BODY) || 'Posted a status update.',
      subtitle: sourceLabel(post.authorDid, post.authorHandle),
      silent: !settings.notificationSound,
      timeoutType: 'default'
    })

    notification.on('click', () => {
      deps.onOpened(post)
      // A pushed update need not link anywhere; marking it read is still the point.
      if (post.url) void shell.openExternal(post.url)
    })

    // A dropped banner is the one failure the user cannot see for themselves.
    void show(notification).catch((error: Error) => deps.onFailed?.(error.message, post))
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
