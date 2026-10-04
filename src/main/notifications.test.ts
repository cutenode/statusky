import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notification, notifications, openedExternally } from '../test/electron'
import { makePost, makeSettings } from '../test/factories'
import { PROBE_SOURCE_DID } from '../shared/network'
import type { Settings, StatusPost } from '../shared/types'
import {
  BURST_WINDOW_MS,
  createNotifier,
  explainFailure,
  isRetained,
  MAX_RETAINED_NOTIFICATIONS,
  notifyDigest,
  notifyPosts,
  notifySupported,
  notifyTest,
  type NotificationDeps
} from './notifications'

const settings = makeSettings()

/**
 * An entry this app's own checks filed about a service, which is what `probeServiceId`
 * recognises — and the only kind of update the dashboard has a row for. `at` is what
 * makes two entries about the same service distinct records.
 */
function measured(text = 'bsky.network is unreachable', at = 1767225600): StatusPost {
  return makePost({
    authorDid: PROBE_SOURCE_DID,
    authorDisplayName: 'Network checks',
    uri: `${PROBE_SOURCE_DID}/relay:bsky.network/${at}`,
    url: '',
    text
  })
}

/**
 * The three things a banner can do, as spies.
 *
 * All three are required, because a banner is built with its buttons on and the buttons
 * have to be wired to something; a test names only the one it is about and lets the
 * others stand. `onFailed` stays optional, as it is in the interface.
 */
function banner(overrides: Partial<NotificationDeps> = {}): NotificationDeps {
  return { onOpened: vi.fn(), onMarkRead: vi.fn(), onShowNetwork: vi.fn(), ...overrides }
}

describe('notifySupported', () => {
  it('mirrors the platform capability', () => {
    expect(notifySupported()).toBe(true)
    Notification.supported = false
    expect(notifySupported()).toBe(false)
  })
})

describe('notifyPosts', () => {
  it('raises one notification per post, in the order given', () => {
    notifyPosts(
      [
        makePost({ text: 'First', authorDisplayName: 'Bluesky Status' }),
        makePost({ text: 'Second', authorDisplayName: 'Bluesky Status' })
      ],
      settings,
      banner()
    )

    expect(notifications.map((n) => n.options.body)).toEqual(['First', 'Second'])
    expect(notifications.every((n) => n.shown)).toBe(true)
  })

  it('titles the notification with the author and the severity', () => {
    notifyPosts(
      [
        makePost({
          text: 'Investigating elevated error rates',
          authorDisplayName: 'Bluesky Status',
          authorHandle: 'status.bsky.app'
        })
      ],
      settings,
      banner()
    )

    expect(notifications[0]?.options.title).toBe('Bluesky Status · Investigating')
    expect(notifications[0]?.options.subtitle).toBe('@status.bsky.app')
  })

  it('collapses whitespace and truncates a long body', () => {
    const text = `Investigating\n\n${'a'.repeat(400)}`
    notifyPosts([makePost({ text })], settings, banner())

    const body = String(notifications[0]?.options.body)
    expect(body).toHaveLength(220)
    expect(body.endsWith('…')).toBe(true)
    expect(body).not.toContain('\n')
  })

  it('falls back to a placeholder body for an empty post', () => {
    notifyPosts([makePost({ text: '   ' })], settings, banner())
    expect(notifications[0]?.options.body).toBe('Posted a status update.')
  })

  it('opens the post and marks it read when clicked', () => {
    const onOpened = vi.fn()
    const post = makePost({ text: 'Outage' })

    notifyPosts([post], settings, banner({ onOpened }))
    notifications[0]?.click()

    expect(onOpened).toHaveBeenCalledWith(post)
    expect(openedExternally).toEqual([post.url])
  })

  it('does nothing when the platform cannot show notifications', () => {
    const onFailed = vi.fn()
    Notification.supported = false
    notifyPosts([makePost()], settings, banner({ onFailed }))
    expect(notifications).toHaveLength(0)
    expect(onFailed).toHaveBeenCalledWith('This system does not support notifications.')
  })

  it('does nothing for an empty batch', () => {
    const onFailed = vi.fn()
    notifyPosts([], settings, banner({ onFailed }))
    expect(notifications).toHaveLength(0)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('reports the post the OS refused instead of dropping it silently', async () => {
    const onFailed = vi.fn()
    const post = makePost({ text: 'Outage' })
    Notification.failWith = 'Notifications are not allowed for this application'

    notifyPosts([post], settings, banner({ onFailed }))
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalled())

    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining('System Settings'), post)
  })
})

/**
 * The buttons on a banner, which are what turn it from an interruption into somewhere
 * the update can be finished with.
 *
 * Pressing one needs a real banner and a person to press it, so this is the only place
 * the wiring from a button's index back to what it does can be exercised automatically.
 */
describe('the buttons on a banner', () => {
  it('offers to deal with any update without opening anything', () => {
    notifyPosts([makePost()], settings, banner())

    expect(notifications[0]?.options.actions).toEqual([{ type: 'button', text: 'Mark as read' }])
  })

  /**
   * The dashboard has a row for a service this app measures and nothing at all for an
   * operator's sentence about an incident — that lives on their status page, which is
   * what clicking the banner opens.
   */
  it('offers the dashboard only for what this app measured', () => {
    notifyPosts([measured()], settings, banner())

    expect(notifications[0]?.options.actions).toEqual([
      { type: 'button', text: 'Mark as read' },
      { type: 'button', text: 'Show on dashboard' }
    ])
  })

  it('runs the button the OS says was pressed', () => {
    const onMarkRead = vi.fn()
    const onShowNetwork = vi.fn()
    const post = measured()

    notifyPosts([post], settings, banner({ onMarkRead, onShowNetwork }))
    notifications[0]!.act(0)
    notifications[0]!.act(1)

    expect(onMarkRead).toHaveBeenCalledWith(post)
    expect(onShowNetwork).toHaveBeenCalledWith('relay:bsky.network')
  })

  it('does not open anything when an update is dealt with from the banner', () => {
    notifyPosts([makePost()], settings, banner())
    notifications[0]!.act(0)

    expect(openedExternally).toEqual([])
  })

  /**
   * The index comes from the OS and is read back into the array the buttons were built
   * from. One the banner has no button for should not be able to reach into the main
   * process at all, let alone mark something read.
   */
  it('ignores an action index that belongs to no button', () => {
    const onMarkRead = vi.fn()
    notifyPosts([makePost()], settings, banner({ onMarkRead }))

    notifications[0]!.emit('action', { actionIndex: 7, selectionIndex: -1 })

    expect(onMarkRead).not.toHaveBeenCalled()
  })
})

/**
 * Which banners replace one another rather than piling up. On Windows the keys become
 * the toast's `Group` and `Tag`, and a toast whose pair matches one already showing
 * replaces it in the Action Center; on macOS they are the request identifier and the
 * thread identifier, which behave the same way. None of that is observable from here —
 * what is asserted is that the right updates carry the keys and the right ones do not.
 */
describe('collapsing repeated banners', () => {
  /**
   * A flapping relay is the case this exists for: nine transitions in an afternoon is
   * nine rows in the Action Center, eight of which are already wrong. Keyed on the
   * service, each one takes the same slot and the slot says what that service is doing
   * now.
   */
  it('gives each service one slot, keyed on the service', () => {
    notifyPosts(
      [measured('bsky.network is unreachable', 1), measured('bsky.network is back', 2)],
      settings,
      banner()
    )

    expect(notifications.map((n) => n.options.id)).toEqual([
      'relay:bsky.network',
      'relay:bsky.network'
    ])
    expect(notifications.map((n) => n.options.groupId)).toEqual(['services', 'services'])
  })

  /**
   * A status page posting *investigating*, then *identified*, then *resolved* is telling
   * a story, and collapsing it would throw away the two sentences the operator wrote
   * first. Only the machine-filed entries collapse.
   */
  it('lets a published update keep its own place', () => {
    notifyPosts([makePost({ text: 'Investigating' })], settings, banner())

    expect(notifications[0]?.options.id).toBeUndefined()
    expect(notifications[0]?.options.groupId).toBeUndefined()
  })
})

describe('notifyTest', () => {
  it('shows a recognisable sample notification', async () => {
    await notifyTest(settings)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.options.title).toBe('Statusky · Monitoring')
    expect(notifications[0]?.shown).toBe(true)
  })

  it('rejects with actionable wording when the OS refuses the notification', async () => {
    Notification.failWith = "The operation couldn't be completed. (UNErrorDomain error 1.)"
    await expect(notifyTest(settings)).rejects.toThrow('System Settings')
  })

  it('rejects on a platform without notifications', async () => {
    Notification.supported = false
    await expect(notifyTest(settings)).rejects.toThrow('does not support notifications')
    expect(notifications).toHaveLength(0)
  })

  /** The button is how somebody finds out what a banner will sound like, if anything. */
  it('makes a sound unless every banner is set to arrive silently', async () => {
    await notifyTest(makeSettings({ notificationSound: 'urgent' }))
    await notifyTest(makeSettings({ notificationSound: 'never' }))

    expect(notifications.map((n) => n.options.silent)).toEqual([false, true])
  })
})

describe('an OS that answers oddly', () => {
  it('gives up waiting and treats silence as delivered', async () => {
    vi.useFakeTimers()
    try {
      Notification.neverAnswers = true
      const pending = notifyTest(settings)

      await vi.advanceTimersByTimeAsync(5_000)

      await expect(pending).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a second answer once the first has settled', async () => {
    const onFailed = vi.fn()
    notifyPosts([makePost()], settings, banner({ onFailed }))
    await vi.waitFor(() => expect(notifications[0]?.shown).toBe(true))

    notifications[0]!.emit('failed', {}, 'too late')
    await Promise.resolve()

    expect(onFailed).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when the OS gives no reason at all', async () => {
    Notification.failWith = ''
    await expect(notifyTest(settings)).rejects.toThrow('The system refused the notification.')
  })

  it('marks a pushed update read on click even though it links nowhere', async () => {
    const post = makePost({
      authorDid: 'webhook:pg',
      authorHandle: 'status.bsky.app',
      uri: 'webhook:pg/component/cmp/x',
      url: ''
    })
    const onOpened = vi.fn()
    notifyPosts([post], settings, banner({ onOpened }))

    notifications.at(-1)!.emit('click')

    expect(onOpened).toHaveBeenCalledWith(post)
    expect(openedExternally).toEqual([])
  })

  // Nothing that builds `post.url` today builds anything else; this is what keeps a
  // future one honest. The banner still does everything else a click does.
  it('opens nothing for a link to anywhere but the web', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const post = makePost({ url: 'search-ms:query=x&crumb=location:\\\\attacker.test\\x' })
    const onOpened = vi.fn()
    notifyPosts([post], settings, banner({ onOpened }))

    notifications.at(-1)!.click()

    expect(onOpened).toHaveBeenCalledWith(post)
    expect(openedExternally).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('names a pushed source without an @ it does not have', () => {
    notifyPosts(
      [makePost({ authorDid: 'webhook:pg', authorHandle: 'status.bsky.app' })],
      settings,
      banner()
    )

    expect(notifications.at(-1)!.options.subtitle).toBe('status.bsky.app')
  })

  it('does not require an onFailed handler to be given', () => {
    Notification.supported = false
    expect(() => notifyPosts([makePost()], settings, banner())).not.toThrow()
  })
})

/**
 * A banner that has gone up is still clickable for as long as it sits in Notification
 * Center, and a click on one whose JS side has been collected does nothing at all. So
 * being shown is not the end of a banner's life: it is held until it is clicked, one of
 * its buttons is pressed, it is closed, or the OS refuses it — and no more than
 * `MAX_RETAINED_NOTIFICATIONS` are held at once.
 */
describe('holding on to a banner', () => {
  /** Raise one banner and wait for the OS to put it up. */
  async function raised(): Promise<(typeof notifications)[number]> {
    notifyPosts([makePost()], settings, banner())
    const notification = notifications.at(-1)!
    await vi.waitFor(() => expect(notification.shown).toBe(true))
    await Promise.resolve()
    return notification
  }

  it('keeps a banner after the OS has shown it', async () => {
    expect(isRetained(await raised())).toBe(true)
  })

  it('keeps a banner the OS never answered about, which may well be on screen', async () => {
    vi.useFakeTimers()
    try {
      Notification.neverAnswers = true
      const pending = notifyTest(settings)
      await vi.advanceTimersByTimeAsync(5_000)
      await pending

      expect(isRetained(notifications.at(-1)!)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['clicked', (n: (typeof notifications)[number]) => n.click()],
    ['answered with a button', (n: (typeof notifications)[number]) => n.act(0)],
    ['closed', (n: (typeof notifications)[number]) => n.emit('close', {})]
  ])('lets go of a banner once it is %s', async (_how, finish) => {
    const notification = await raised()
    finish(notification)
    expect(isRetained(notification)).toBe(false)
  })

  it('lets go of a banner the OS refused', async () => {
    Notification.failWith = 'UNErrorDomain error 1'
    await expect(notifyTest(settings)).rejects.toThrow()
    expect(isRetained(notifications.at(-1)!)).toBe(false)
  })

  it('lets go of the oldest once it is holding as many as it will', async () => {
    Notification.neverAnswers = true
    for (let i = 0; i <= MAX_RETAINED_NOTIFICATIONS; i++) {
      notifyPosts([makePost()], settings, banner())
    }

    const all = notifications.slice(-(MAX_RETAINED_NOTIFICATIONS + 1))
    expect(isRetained(all[0]!)).toBe(false)
    expect(all.slice(1).every((notification) => isRetained(notification))).toBe(true)
  })
})

describe('notifyDigest', () => {
  const away = [
    makePost({ text: 'Investigating', authorDisplayName: 'Bluesky Status' }),
    makePost({ text: 'Identified', authorDisplayName: 'Bluesky Status' }),
    makePost({ text: 'bsky.network is unreachable', authorDisplayName: 'Network checks' })
  ]

  /**
   * Deliberately none. Both of an ordinary banner's buttons answer for one specific
   * update, and this banner has shown the user none: its body is a count and a list of
   * sources. *Mark as read* here would be marking things read on behalf of somebody who
   * has not seen them, which is the one thing the waiting room exists to avoid.
   */
  it('carries no buttons, because it has shown nobody anything yet', () => {
    notifyDigest(away, settings, { onOpened: vi.fn() })
    expect(notifications[0]?.options.actions).toBeUndefined()
  })

  it('raises one banner for the lot, saying how many and from where', () => {
    notifyDigest(away, settings, { onOpened: vi.fn() })

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.options.title).toBe('Statusky · While you were away')
    expect(notifications[0]?.options.body).toBe('3 updates from Bluesky Status and Network checks')
  })

  it('names two sources and counts the rest', () => {
    notifyDigest(
      [
        ...away,
        makePost({ authorDisplayName: 'Blacksky Status' }),
        makePost({ authorDisplayName: 'Tangled' })
      ],
      settings,
      { onOpened: vi.fn() }
    )

    expect(notifications[0]?.options.body).toBe(
      '5 updates from Bluesky Status, Network checks and 2 others'
    )
  })

  it('counts one remaining source in the singular', () => {
    notifyDigest([...away, makePost({ authorDisplayName: 'Blacksky Status' })], settings, {
      onOpened: vi.fn()
    })

    expect(notifications[0]?.options.body).toBe(
      '4 updates from Bluesky Status, Network checks and 1 other'
    )
  })

  it('opens the Timeline rather than any one post', () => {
    const onOpened = vi.fn()
    notifyDigest(away, settings, { onOpened })

    notifications[0]?.click()

    expect(onOpened).toHaveBeenCalledTimes(1)
    expect(openedExternally).toEqual([])
  })

  it('silences the sound when the preference is off', () => {
    notifyDigest(away, makeSettings({ notificationSound: 'never' }), { onOpened: vi.fn() })
    expect(notifications[0]?.options.silent).toBe(true)
  })

  it('reports a refusal rather than dropping it silently', async () => {
    const onFailed = vi.fn()
    Notification.failWith = 'Notifications are not allowed for this application'

    notifyDigest(away, settings, { onOpened: vi.fn(), onFailed })
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalled())

    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining('System Settings'))
  })

  it('says so when the platform cannot show notifications at all', () => {
    const onFailed = vi.fn()
    Notification.supported = false

    notifyDigest(away, settings, { onOpened: vi.fn(), onFailed })

    expect(notifications).toHaveLength(0)
    expect(onFailed).toHaveBeenCalledWith('This system does not support notifications.')
  })
})

describe('createNotifier', () => {
  interface Built {
    notifier: ReturnType<typeof createNotifier>
    /** Flip to take the user away from the machine. */
    away: { value: boolean }
    /** URIs the user has not dealt with; everything held is assumed unread unless set. */
    dealtWith: Set<string>
    onOpened: ReturnType<typeof vi.fn>
    onCatchUp: ReturnType<typeof vi.fn>
    onMarkRead: ReturnType<typeof vi.fn>
    onShowNetwork: ReturnType<typeof vi.fn>
  }

  function build(): Built {
    const away = { value: false }
    const dealtWith = new Set<string>()
    const onOpened = vi.fn()
    const onCatchUp = vi.fn()
    const onMarkRead = vi.fn()
    const onShowNetwork = vi.fn()
    const notifier = createNotifier(() => settings, {
      away: () => away.value,
      stillWorthSaying: (posts) => posts.filter((post) => !dealtWith.has(post.uri)),
      onOpened,
      onCatchUp,
      onMarkRead,
      onShowNetwork
    })
    return { notifier, away, dealtWith, onOpened, onCatchUp, onMarkRead, onShowNetwork }
  }

  it('raises an ordinary banner per post while somebody is there', () => {
    const built = build()

    built.notifier.notify([makePost({ text: 'First' }), makePost({ text: 'Second' })])

    expect(notifications.map((n) => n.options.body)).toEqual(['First', 'Second'])
  })

  it('raises nothing at all while nobody is', () => {
    const built = build()
    built.away.value = true

    built.notifier.notify([makePost({ text: 'Investigating' })])

    expect(notifications).toHaveLength(0)
  })

  it('says everything held back in one summary on the way in', () => {
    const built = build()
    built.away.value = true
    built.notifier.notify([makePost({ text: 'Investigating' })])
    built.notifier.notify([makePost({ text: 'Identified' }), makePost({ text: 'Resolved' })])

    built.away.value = false
    built.notifier.release()

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.options.title).toBe('Statusky · While you were away')
    expect(notifications[0]?.options.body).toContain('3 updates')
  })

  it('opens the Timeline from that summary', () => {
    const built = build()
    built.away.value = true
    built.notifier.notify([makePost({ text: 'a' }), makePost({ text: 'b' })])
    built.notifier.release()

    notifications[0]?.click()

    expect(built.onCatchUp).toHaveBeenCalledTimes(1)
    expect(built.onOpened).not.toHaveBeenCalled()
  })

  // Summarising one incident as "1 update from Bluesky" throws away the sentence the
  // operator wrote, and the ordinary banner already opens the right thing.
  it('keeps the ordinary banner when only one update was held', () => {
    const built = build()
    built.away.value = true
    const post = makePost({ text: 'Investigating elevated error rates' })
    built.notifier.notify([post])

    built.notifier.release()

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.options.body).toBe('Investigating elevated error rates')
    notifications[0]?.click()
    expect(built.onOpened).toHaveBeenCalledWith(post)
  })

  it('drops whatever was dealt with in the popover while its banner waited', () => {
    const built = build()
    built.away.value = true
    const read = makePost({ text: 'Investigating' })
    const unread = makePost({ text: 'Identified' })
    const alsoUnread = makePost({ text: 'Resolved' })
    built.notifier.notify([read, unread, alsoUnread])
    built.dealtWith.add(read.uri)

    built.notifier.release()

    expect(notifications[0]?.options.body).toContain('2 updates')
  })

  it('says nothing at all when the user dealt with all of it themselves', () => {
    const built = build()
    built.away.value = true
    const posts = [makePost({ text: 'a' }), makePost({ text: 'b' })]
    built.notifier.notify(posts)
    for (const post of posts) built.dealtWith.add(post.uri)

    built.notifier.release()

    expect(notifications).toHaveLength(0)
  })

  it('forgets what it released, so coming back twice says it once', () => {
    const built = build()
    built.away.value = true
    built.notifier.notify([makePost({ text: 'a' }), makePost({ text: 'b' })])

    built.notifier.release()
    built.notifier.release()

    expect(notifications).toHaveLength(1)
  })

  it('holds nothing, and says nothing, for an empty batch', () => {
    const built = build()
    built.away.value = true

    built.notifier.notify([])
    built.notifier.release()

    expect(notifications).toHaveLength(0)
  })
})

describe('explainFailure', () => {
  it('translates the opaque macOS authorisation error', () => {
    const message = explainFailure("The operation couldn't be completed. (UNErrorDomain error 1.)")
    expect(message).toContain('System Settings')
    expect(message).toContain('listed there as Electron')
    expect(message).not.toContain('UNErrorDomain')
  })

  it('translates the same refusal in its worded form', () => {
    expect(explainFailure('Notifications are not allowed for this application')).toContain(
      'System Settings'
    )
  })

  it('passes an unrecognised error through untouched', () => {
    expect(explainFailure('UNErrorDomain error 3')).toBe('UNErrorDomain error 3')
  })
})

describe('how a banner presents itself', () => {
  it('plays the sound only for outages when asked to', () => {
    const quiet = makeSettings({ notificationSound: 'urgent' })
    notifyPosts(
      [makePost({ severity: 'outage' }), makePost({ severity: 'monitoring' })],
      quiet,
      banner()
    )

    expect(notifications.map((n) => n.options.silent)).toEqual([false, true])
  })

  it('plays it for everything, or for nothing', () => {
    notifyPosts(
      [makePost({ severity: 'update' })],
      makeSettings({ notificationSound: 'all' }),
      banner()
    )
    notifyPosts(
      [makePost({ severity: 'outage' })],
      makeSettings({ notificationSound: 'never' }),
      banner()
    )

    expect(notifications.map((n) => n.options.silent)).toEqual([false, true])
  })

  it('leaves an outage on screen until dismissed, and lets the rest time out', () => {
    notifyPosts(
      [makePost({ severity: 'outage' }), makePost({ severity: 'degraded' })],
      makeSettings({ notifyStickyOutages: true }),
      banner()
    )
    notifyPosts(
      [makePost({ severity: 'outage' })],
      makeSettings({ notifyStickyOutages: false }),
      banner()
    )

    expect(notifications.map((n) => n.options.timeoutType)).toEqual(['never', 'default', 'default'])
  })

  it('keeps the update’s text out of the banner when asked to', () => {
    notifyPosts(
      [
        makePost({
          text: 'The AppView is down',
          authorDisplayName: 'Bluesky Status',
          severity: 'outage'
        })
      ],
      makeSettings({ notificationShowBody: false }),
      banner()
    )

    expect(notifications[0]?.options.title).toBe('Bluesky Status · Outage')
    expect(notifications[0]?.options.body).toBe('Posted a status update.')
  })

  it('sounds a summary if anything in it is an outage', () => {
    notifyDigest(
      [makePost({ severity: 'monitoring' }), makePost({ severity: 'outage' })],
      makeSettings({ notificationSound: 'urgent' }),
      { onOpened: vi.fn() }
    )

    expect(notifications[0]?.options.silent).toBe(false)
  })
})

/** A measured outage, and the recovery that answers it. */
function down(service = 'relay:bsky.network', at = 1767225600): StatusPost {
  return makePost({
    authorDid: PROBE_SOURCE_DID,
    authorDisplayName: 'Network checks',
    uri: `${PROBE_SOURCE_DID}/${service}/${at}`,
    url: '',
    text: `${service} is not responding`,
    severity: 'outage'
  })
}

function up(service = 'relay:bsky.network', at = 1767225900): StatusPost {
  return { ...down(service, at), text: `${service} is responding again`, severity: 'resolved' }
}

describe('when a banner goes up', () => {
  /** 2026-01-01T12:00 local time: the middle of the day, outside default quiet hours. */
  const NOON = new Date(2026, 0, 1, 12, 0).getTime()

  interface Timed {
    notifier: ReturnType<typeof createNotifier>
    settings: { value: Settings }
    away: { value: boolean }
    dealtWith: Set<string>
  }

  function timed(overrides: Partial<Settings> = {}): Timed {
    vi.useFakeTimers({ now: NOON })
    const current = { value: makeSettings(overrides) }
    const away = { value: false }
    const dealtWith = new Set<string>()
    const notifier = createNotifier(() => current.value, {
      away: () => away.value,
      stillWorthSaying: (posts) => posts.filter((post) => !dealtWith.has(post.uri)),
      onCatchUp: vi.fn(),
      ...banner()
    })
    return { notifier, settings: current, away, dealtWith }
  }

  afterEach(() => vi.useRealTimers())

  describe('the grace period on a measured outage', () => {
    it('waits before announcing it', () => {
      const t = timed({ notifyProbeGraceSec: 300 })

      t.notifier.notify([down()])
      expect(notifications).toHaveLength(0)

      vi.advanceTimersByTime(300_000)
      expect(notifications.map((n) => n.options.body)).toEqual([
        'relay:bsky.network is not responding'
      ])
    })

    it('says nothing at all about an outage that ended inside it', () => {
      const t = timed({ notifyProbeGraceSec: 300 })

      t.notifier.notify([down()])
      vi.advanceTimersByTime(60_000)
      t.notifier.notify([up()])
      vi.advanceTimersByTime(600_000)

      expect(notifications).toHaveLength(0)
    })

    it('announces the latest condition when it changed during the wait, on the original clock', () => {
      const t = timed({ notifyProbeGraceSec: 300 })

      t.notifier.notify([down()])
      vi.advanceTimersByTime(200_000)
      t.notifier.notify([
        {
          ...down(),
          uri: `${PROBE_SOURCE_DID}/relay:bsky.network/2`,
          severity: 'degraded',
          text: 'partly'
        }
      ])
      vi.advanceTimersByTime(100_000)

      expect(notifications.map((n) => n.options.body)).toEqual(['partly'])
    })

    it('announces an outage straight away with no grace period', () => {
      const t = timed({ notifyProbeGraceSec: 0 })
      t.notifier.notify([down()])
      expect(notifications).toHaveLength(1)
    })

    it('leaves status posts alone', () => {
      const t = timed({ notifyProbeGraceSec: 300 })
      t.notifier.notify([makePost({ severity: 'outage' })])
      expect(notifications).toHaveLength(1)
    })

    it('says nothing if notifications are switched off before the wait is over', () => {
      const t = timed({ notifyProbeGraceSec: 300 })
      t.notifier.notify([down()])

      t.settings.value = { ...t.settings.value, notificationsEnabled: false }
      vi.advanceTimersByTime(300_000)

      expect(notifications).toHaveLength(0)
    })
  })

  describe('quiet hours', () => {
    const night = { quietHoursEnabled: true, quietHoursStart: '11:00', quietHoursEnd: '13:00' }

    it('holds banners until they end, then summarises them', () => {
      const t = timed({ ...night, quietHoursBreakthrough: false })

      t.notifier.notify([makePost({ severity: 'monitoring' })])
      t.notifier.notify([makePost({ severity: 'outage' })])
      expect(notifications).toHaveLength(0)

      vi.advanceTimersByTime(60 * 60_000 + 2_000)
      expect(notifications).toHaveLength(1)
      expect(notifications[0]?.options.title).toBe('Statusky · During quiet hours')
    })

    it('lets outages through when asked to', () => {
      const t = timed({ ...night, quietHoursBreakthrough: true })

      t.notifier.notify([
        makePost({ severity: 'outage', text: 'down' }),
        makePost({ severity: 'monitoring' })
      ])

      expect(notifications.map((n) => n.options.body)).toEqual(['down'])
    })

    it('stops holding as soon as they are switched off', () => {
      const t = timed({ ...night, quietHoursBreakthrough: false })
      t.notifier.notify([makePost({ severity: 'monitoring', text: 'watching' })])

      t.settings.value = { ...t.settings.value, quietHoursEnabled: false }
      t.notifier.reconsider()

      expect(notifications.map((n) => n.options.body)).toEqual(['watching'])
    })
  })

  describe('a snooze', () => {
    it('holds everything, outages included, until it runs out', () => {
      const t = timed({ notificationsSnoozedUntil: new Date(NOON + 60 * 60_000).toISOString() })

      t.notifier.notify([makePost({ severity: 'outage' }), makePost({ severity: 'monitoring' })])
      expect(notifications).toHaveLength(0)

      vi.advanceTimersByTime(60 * 60_000 + 2_000)
      expect(notifications).toHaveLength(1)
      expect(notifications[0]?.options.title).toBe('Statusky · While notifications were paused')
    })

    it('lets go of what it held when resumed early', () => {
      const t = timed({ notificationsSnoozedUntil: new Date(NOON + 60 * 60_000).toISOString() })
      t.notifier.notify([makePost({ text: 'held' })])

      t.settings.value = { ...t.settings.value, notificationsSnoozedUntil: null }
      t.notifier.reconsider()

      expect(notifications.map((n) => n.options.body)).toEqual(['held'])
    })

    // Its wake-up is booked a second after the end, and an update delivered in that
    // second books a new one. By then there is no snooze left to book it for.
    it('still lets go when an update lands in the second after it ends', () => {
      const t = timed({ notificationsSnoozedUntil: new Date(NOON + 60_000).toISOString() })
      t.notifier.notify([makePost({ text: 'held' })])

      vi.advanceTimersByTime(60_000 + 500)
      t.notifier.notify([makePost({ text: 'fresh' })])
      vi.advanceTimersByTime(2_000)

      expect(notifications.map((n) => n.options.body)).toEqual(['fresh', 'held'])
    })

    it('ignores one that has already run out', () => {
      const t = timed({ notificationsSnoozedUntil: new Date(NOON - 1).toISOString() })
      t.notifier.notify([makePost()])
      expect(notifications).toHaveLength(1)
    })
  })

  describe('while nobody is there', () => {
    it('shows banners as they come when asked to deliver anyway', () => {
      const t = timed({ notifyWhenAway: 'deliver' })
      t.away.value = true

      t.notifier.notify([makePost()])

      expect(notifications).toHaveLength(1)
    })

    it('says nothing, even on the way back, when asked to stay silent', () => {
      const t = timed({ notifyWhenAway: 'drop' })
      t.away.value = true
      t.notifier.notify([makePost(), makePost()])

      t.away.value = false
      t.notifier.release()

      expect(notifications).toHaveLength(0)
    })

    it('does not release an absence on a settings change, only on a return', () => {
      const t = timed({ notifyWhenAway: 'digest' })
      t.away.value = true
      t.notifier.notify([makePost()])

      t.notifier.reconsider()
      expect(notifications).toHaveLength(0)

      t.notifier.release()
      expect(notifications).toHaveLength(1)
    })
  })

  describe('bursts', () => {
    it('folds updates that follow a banner closely into one summary', () => {
      const t = timed({ notifyCombineBursts: true })

      t.notifier.notify([makePost({ text: 'first' })])
      vi.advanceTimersByTime(30_000)
      t.notifier.notify([makePost({ text: 'second' })])
      t.notifier.notify([makePost({ text: 'third' })])
      expect(notifications).toHaveLength(1)

      vi.advanceTimersByTime(BURST_WINDOW_MS)
      expect(notifications).toHaveLength(2)
      expect(notifications[1]?.options.title).toBe('Statusky · More updates')
      expect(notifications[1]?.options.body).toContain('2 updates')
    })

    it('raises a lone follower as an ordinary banner', () => {
      const t = timed({ notifyCombineBursts: true })
      t.notifier.notify([makePost({ text: 'first' })])
      t.notifier.notify([makePost({ text: 'second' })])

      vi.advanceTimersByTime(BURST_WINDOW_MS)

      expect(notifications.map((n) => n.options.body)).toEqual(['first', 'second'])
    })

    it('raises each banner as it comes when switched off', () => {
      const t = timed({ notifyCombineBursts: false })
      t.notifier.notify([makePost({ text: 'first' })])
      t.notifier.notify([makePost({ text: 'second' })])

      expect(notifications.map((n) => n.options.body)).toEqual(['first', 'second'])
    })

    it('leaves out what was read while the summary waited, and opens no window for silence', () => {
      const t = timed({ notifyCombineBursts: true })
      t.notifier.notify([makePost({ text: 'first' })])
      const second = makePost({ text: 'second' })
      t.notifier.notify([second])
      t.dealtWith.add(second.uri)

      vi.advanceTimersByTime(BURST_WINDOW_MS)
      // Nothing was said at the end of that window, so nothing is folded into another.
      t.notifier.notify([makePost({ text: 'later' })])

      expect(notifications.map((n) => n.options.body)).toEqual(['first', 'later'])
    })

    it('treats updates after the window as news in their own right', () => {
      const t = timed({ notifyCombineBursts: true })
      t.notifier.notify([makePost({ text: 'first' })])
      vi.advanceTimersByTime(BURST_WINDOW_MS + 1)
      t.notifier.notify([makePost({ text: 'later' })])

      expect(notifications.map((n) => n.options.body)).toEqual(['first', 'later'])
    })
  })

  it('drops everything it held when notifications are switched off', () => {
    const t = timed({ notificationsSnoozedUntil: new Date(NOON + 60_000).toISOString() })
    t.notifier.notify([makePost()])

    t.settings.value = {
      ...t.settings.value,
      notificationsEnabled: false,
      notificationsSnoozedUntil: null
    }
    t.notifier.reconsider()
    vi.advanceTimersByTime(120_000)
    expect(notifications).toHaveLength(0)

    // Dropped rather than merely not yet said: switching them back on brings none of it back.
    t.settings.value = { ...t.settings.value, notificationsEnabled: true }
    t.notifier.reconsider()
    t.notifier.release()

    expect(notifications).toHaveLength(0)
  })

  it('forgets every wait it was keeping when disposed', () => {
    const t = timed({ notifyProbeGraceSec: 300, notifyCombineBursts: true })
    t.notifier.notify([makePost({ text: 'first' })])
    // A burst waiting to be summarised, and an outage waiting out its grace period…
    t.notifier.notify([makePost({ text: 'second' })])
    t.notifier.notify([down()])
    // …and a banner held by a snooze, with a wake-up booked for when it ends.
    t.settings.value = {
      ...t.settings.value,
      notificationsSnoozedUntil: new Date(NOON + 60_000).toISOString()
    }
    t.notifier.notify([makePost({ text: 'snoozed' })])

    t.notifier.dispose()
    vi.advanceTimersByTime(60 * 60_000)
    t.settings.value = { ...t.settings.value, notificationsSnoozedUntil: null }
    t.notifier.reconsider()
    t.notifier.release()

    expect(notifications.map((n) => n.options.body)).toEqual(['first'])
  })
})
