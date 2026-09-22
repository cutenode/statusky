import { describe, expect, it, vi } from 'vitest'
import { Notification, notifications, openedExternally } from '../test/electron'
import { makePost, makeSettings } from '../test/factories'
import { PROBE_SOURCE_DID } from '../shared/network'
import type { StatusPost } from '../shared/types'
import {
  createNotifier,
  explainFailure,
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

  it('silences the sound when the preference is off', () => {
    notifyPosts([makePost()], makeSettings({ notificationSound: false }), banner())
    expect(notifications[0]?.options.silent).toBe(true)
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
 * On macOS these need a properly signed build, exactly as notifications themselves do —
 * an unsigned development build is never granted notification authorisation, so there is
 * no banner for the buttons to be missing from. That makes this the only place any of it
 * can be exercised on a development machine.
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
    notifyDigest(away, makeSettings({ notificationSound: false }), { onOpened: vi.fn() })
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
    expect(message).toContain('unsigned development builds')
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
