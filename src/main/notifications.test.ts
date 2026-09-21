import { describe, expect, it, vi } from 'vitest'
import { Notification, notifications, openedExternally } from '../test/electron'
import { makePost, makeSettings } from '../test/factories'
import { explainFailure, notifyPosts, notifySupported, notifyTest } from './notifications'

const settings = makeSettings()

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
      { onOpened: vi.fn() }
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
      { onOpened: vi.fn() }
    )

    expect(notifications[0]?.options.title).toBe('Bluesky Status · Investigating')
    expect(notifications[0]?.options.subtitle).toBe('@status.bsky.app')
  })

  it('collapses whitespace and truncates a long body', () => {
    const text = `Investigating\n\n${'a'.repeat(400)}`
    notifyPosts([makePost({ text })], settings, { onOpened: vi.fn() })

    const body = String(notifications[0]?.options.body)
    expect(body).toHaveLength(220)
    expect(body.endsWith('…')).toBe(true)
    expect(body).not.toContain('\n')
  })

  it('falls back to a placeholder body for an empty post', () => {
    notifyPosts([makePost({ text: '   ' })], settings, { onOpened: vi.fn() })
    expect(notifications[0]?.options.body).toBe('Posted a status update.')
  })

  it('silences the sound when the preference is off', () => {
    notifyPosts([makePost()], makeSettings({ notificationSound: false }), { onOpened: vi.fn() })
    expect(notifications[0]?.options.silent).toBe(true)
  })

  it('opens the post and marks it read when clicked', () => {
    const onOpened = vi.fn()
    const post = makePost({ text: 'Outage' })

    notifyPosts([post], settings, { onOpened })
    notifications[0]?.click()

    expect(onOpened).toHaveBeenCalledWith(post)
    expect(openedExternally).toEqual([post.url])
  })

  it('does nothing when the platform cannot show notifications', () => {
    const onFailed = vi.fn()
    Notification.supported = false
    notifyPosts([makePost()], settings, { onOpened: vi.fn(), onFailed })
    expect(notifications).toHaveLength(0)
    expect(onFailed).toHaveBeenCalledWith('This system does not support notifications.')
  })

  it('does nothing for an empty batch', () => {
    const onFailed = vi.fn()
    notifyPosts([], settings, { onOpened: vi.fn(), onFailed })
    expect(notifications).toHaveLength(0)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('reports the post the OS refused instead of dropping it silently', async () => {
    const onFailed = vi.fn()
    const post = makePost({ text: 'Outage' })
    Notification.failWith = 'Notifications are not allowed for this application'

    notifyPosts([post], settings, { onOpened: vi.fn(), onFailed })
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalled())

    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining('System Settings'), post)
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
    notifyPosts([makePost()], settings, { onOpened: vi.fn(), onFailed })
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
    notifyPosts([post], settings, { onOpened })

    notifications.at(-1)!.emit('click')

    expect(onOpened).toHaveBeenCalledWith(post)
    expect(openedExternally).toEqual([])
  })

  it('names a pushed source without an @ it does not have', () => {
    notifyPosts(
      [makePost({ authorDid: 'webhook:pg', authorHandle: 'status.bsky.app' })],
      settings,
      {
        onOpened: vi.fn()
      }
    )

    expect(notifications.at(-1)!.options.subtitle).toBe('status.bsky.app')
  })

  it('does not require an onFailed handler to be given', () => {
    Notification.supported = false
    expect(() => notifyPosts([makePost()], settings, { onOpened: vi.fn() })).not.toThrow()
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
