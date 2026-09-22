import { describe, expect, it, vi } from 'vitest'
import { clipboardContents, menus, openedExternally, shareMenus } from '../test/electron'
import { makeAccount, makePost, DID } from '../test/factories'
import { createModel, withPlatform } from '../test/harness'
import { PROBE_SOURCE_DID, probeAccount } from '../shared/network'
import type { Account, StatusPost } from '../shared/types'
import { readStateFromUnread } from './state'
import { showPostMenu } from './context-menu'
import { PopoverWindow } from './window'

/** The last menu built, which is the one `showPostMenu` just popped up. */
function lastMenu(): (typeof menus)[number] {
  const menu = menus.at(-1)
  if (!menu) throw new Error('No menu was built.')
  return menu
}

function labels(): (string | undefined)[] {
  return lastMenu().template.map((entry) => (entry.type === 'separator' ? '—' : entry.label))
}

interface BuildOptions {
  posts: StatusPost[]
  accounts?: Account[]
  unread?: string[]
}

/**
 * A model holding exactly these posts, and a popover to hang a menu off.
 *
 * `createModel` rather than the whole harness: what is under test is the menu built for
 * one update, and that depends on the exact account set and read state — which is the
 * one thing the harness deliberately reconciles for you.
 */
function build({ posts, accounts, unread = [] }: BuildOptions): {
  show(uri: string): void
  popover: PopoverWindow
  onShowNetwork: ReturnType<typeof vi.fn>
  model: ReturnType<typeof createModel>['model']
  pinned(): boolean
} {
  const { model } = createModel({
    accounts: accounts ?? [makeAccount({ did: DID.bsky, displayName: 'Bluesky Status' })],
    posts,
    read: readStateFromUnread(posts, unread)
  })
  const popover = new PopoverWindow()
  popover.create()
  const onShowNetwork = vi.fn()
  let pinned = false
  const setPinned = popover.setPinned.bind(popover)
  vi.spyOn(popover, 'setPinned').mockImplementation((value: boolean) => {
    pinned = value
    setPinned(value)
  })

  return {
    show: (uri) => showPostMenu(uri, { model, popover, onShowNetwork }),
    popover,
    onShowNetwork,
    model,
    pinned: () => pinned
  }
}

/** An entry the network checks filed, which is what `probeServiceId` recognises. */
function probePost(overrides: Partial<StatusPost> = {}): StatusPost {
  return makePost({
    authorDid: PROBE_SOURCE_DID,
    authorHandle: 'checks.statusky.local',
    authorDisplayName: 'Network checks',
    uri: `${PROBE_SOURCE_DID}/relay:bsky.network/1767225600`,
    url: '',
    text: 'bsky.network is unreachable',
    ...overrides
  })
}

describe('showPostMenu', () => {
  it('offers the link, the reading and the source, in that order', () => {
    const post = makePost({ text: 'Investigating' })
    const older = makePost({ text: 'Earlier', createdAt: '2025-12-31T00:00:00.000Z' })
    const { show } = build({ posts: [post, older], unread: [post.uri, older.uri] })

    show(post.uri)

    expect(labels()).toEqual([
      'Copy link',
      'Open in browser',
      '—',
      'Mark as read',
      'Mark this and everything older as read',
      '—',
      'Mute Bluesky Status',
      '—',
      'Share…'
    ])
  })

  it('copies the permalink through the main process', () => {
    const post = makePost()
    const { show } = build({ posts: [post] })

    show(post.uri)
    lastMenu().click('Copy link')

    expect(clipboardContents.text).toBe(post.url)
  })

  it('opens the original in the real browser', () => {
    const post = makePost()
    const { show } = build({ posts: [post] })

    show(post.uri)
    lastMenu().click('Open in browser')

    expect(openedExternally).toEqual([post.url])
  })

  it('marks one update read without opening anything', () => {
    const post = makePost()
    const { show, model } = build({ posts: [post], unread: [post.uri] })

    show(post.uri)
    lastMenu().click('Mark as read')

    expect(model.getState().unread).toEqual([])
    expect(openedExternally).toEqual([])
  })

  it('marks everything older read from the update you right-clicked', () => {
    const post = makePost({ createdAt: '2026-01-02T00:00:00.000Z' })
    const older = makePost({ createdAt: '2026-01-01T00:00:00.000Z' })
    const { show, model } = build({ posts: [post, older], unread: [post.uri, older.uri] })

    show(post.uri)
    lastMenu().click('Mark this and everything older as read')

    expect(model.getState().unread).toEqual([])
  })

  it('mutes the source the update came from', () => {
    const post = makePost()
    const { show, model } = build({ posts: [post] })

    show(post.uri)
    lastMenu().click('Mute Bluesky Status')

    expect(model.accounts[0]?.muted).toBe(true)
    // And with the source muted there is nothing of its left in the feed, which is what
    // makes *Unmute* something the Accounts panel offers and this menu never can.
    expect(model.getState().posts).toEqual([])
  })

  /**
   * An entry this app measured rather than one somebody published: no permalink to copy
   * or open, and a row on the dashboard instead.
   */
  it('sends a measured entry to the dashboard rather than to a browser', () => {
    const post = probePost()
    const { show, onShowNetwork } = build({
      posts: [post],
      accounts: [probeAccount('2026-01-01T00:00:00.000Z')]
    })

    show(post.uri)
    expect(labels()).toEqual([
      'Show on the network dashboard',
      '—',
      'Mute Network checks',
      '—',
      'Share…'
    ])

    lastMenu().click('Show on the network dashboard')
    expect(onShowNetwork).toHaveBeenCalledWith('relay:bsky.network')
  })

  /**
   * Both of these would be lies. *Mark as read* on something already read does nothing,
   * and *Mark this and everything older as read* on the oldest unread update does what
   * the item above it does.
   */
  it('leaves out the reading items that would do nothing', () => {
    const post = makePost()
    const { show } = build({ posts: [post] })

    show(post.uri)

    expect(labels()).not.toContain('Mark as read')
    expect(labels()).not.toContain('Mark this and everything older as read')
    // And no separator left stranded where that section used to be.
    expect(labels()).toEqual([
      'Copy link',
      'Open in browser',
      '—',
      'Mute Bluesky Status',
      '—',
      'Share…'
    ])
  })

  it('refuses an update that has left the feed', () => {
    const { show } = build({ posts: [makePost()] })

    expect(() => show('at://did:plc:gone/app.bsky.feed.post/nothing')).toThrow('no longer')
    expect(menus).toHaveLength(0)
  })

  /**
   * The popover hides on blur, so a native menu — which takes focus — would otherwise
   * dismiss the window it was opened from. This is what `setPinned` is for.
   */
  it('holds the popover open while the menu is up, and lets go when it closes', () => {
    const post = makePost()
    const { show, pinned } = build({ posts: [post] })

    show(post.uri)
    expect(pinned()).toBe(true)

    lastMenu().closePopup()
    expect(pinned()).toBe(false)
  })

  it('lets go when the menu closes because something was chosen', () => {
    const post = makePost()
    const { show, pinned } = build({ posts: [post] })

    show(post.uri)
    // `click` on the double dismisses the menu too, which is what selecting an item does.
    lastMenu().click('Copy link')

    expect(pinned()).toBe(false)
  })

  /**
   * Electron does not promise whether an item's `click` or the popup's close callback
   * arrives first, and both of them end the menu, so the release has to be able to
   * happen twice. If it could not, one of the two orderings would un-pin the popover
   * while the share sheet opened from it was still on screen.
   */
  it('does not let go twice when a menu closes twice', () => {
    const post = makePost()
    const { show, popover, pinned } = build({ posts: [post] })

    show(post.uri)
    lastMenu().click('Copy link')
    const releases = vi.mocked(popover.setPinned).mock.calls.filter(([value]) => !value).length

    lastMenu().closePopup()

    expect(pinned()).toBe(false)
    expect(vi.mocked(popover.setPinned).mock.calls.filter(([value]) => !value)).toHaveLength(
      releases
    )
  })

  it('pops the menu up against the popover’s own window', () => {
    const post = makePost()
    const { show, popover } = build({ posts: [post] })

    show(post.uri)

    expect(lastMenu().popups[0]?.window).toBe(popover.browserWindow)
  })

  /**
   * A renderer that dies takes its window with it (see `recover` in src/main/window.ts),
   * which can happen between the right-click and this call. Electron pops an unparented
   * menu up against the focused window instead, which is still the right place.
   */
  it('still builds a menu when the window has gone since the click', () => {
    const post = makePost()
    const { show, popover } = build({ posts: [post] })
    popover.browserWindow?.close()

    show(post.uri)

    expect(lastMenu().popups[0]?.window).toBeUndefined()
  })
})

describe('sharing an incident', () => {
  it('hands the sentence and the link to the system share sheet', () => {
    const post = makePost({ text: 'The relay is unreachable', authorDisplayName: 'Bluesky Status' })
    const { show } = build({ posts: [post] })

    show(post.uri)
    lastMenu().click('Share…')

    expect(shareMenus).toHaveLength(1)
    expect(shareMenus[0]?.sharingItem).toEqual({
      texts: ['Bluesky Status · Update: The relay is unreachable'],
      urls: [post.url]
    })
    expect(shareMenus[0]?.isOpen()).toBe(true)
  })

  /** Nobody published the checks' own findings, so there is no link to send with them. */
  it('shares a measured entry as text alone', () => {
    const post = probePost()
    const { show } = build({ posts: [post], accounts: [probeAccount('2026-01-01T00:00:00.000Z')] })

    show(post.uri)
    lastMenu().click('Share…')

    expect(shareMenus[0]?.sharingItem).toEqual({
      texts: ['Network checks · Update: bsky.network is unreachable']
    })
  })

  /**
   * The handover between two menus, which is the reason the hold is counted rather than
   * a flag: the context menu closes while the share sheet is opening, and if that
   * released the popover it would vanish behind the sheet.
   */
  it('keeps the popover open across the handover to the share sheet', () => {
    const post = makePost()
    const { show, pinned } = build({ posts: [post] })

    show(post.uri)
    lastMenu().click('Share…')
    expect(pinned()).toBe(true)

    shareMenus[0]?.closePopup()
    expect(pinned()).toBe(false)
  })

  /**
   * `ShareMenu` is a macOS API with no equivalent anywhere else — Windows has a Share
   * contract Electron does not expose, and Linux has nothing of the kind — so the item
   * is absent rather than present and dead.
   */
  it('is not offered where there is no share sheet', async () => {
    const post = makePost()
    const { show } = build({ posts: [post] })

    await withPlatform('win32', () => show(post.uri))

    expect(labels()).not.toContain('Share…')
  })
})
