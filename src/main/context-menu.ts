import { Menu, ShareMenu, clipboard, shell } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { probeServiceId } from '../shared/network'
import { SEVERITY_LABEL } from '../shared/status'
import type { AppState, StatusPost } from '../shared/types'
import type { Model } from './model'
import type { PopoverWindow } from './window'

export interface PostMenuDeps {
  model: Model
  popover: PopoverWindow
  /** Show the dashboard at one service — the same route a notification click takes. */
  onShowNetwork(serviceId: string): void
}

/**
 * Hold the popover open for as long as anything it spawned is on screen.
 *
 * The popover hides on blur, which is what a menu bar popover is supposed to do and is
 * catastrophic here: opening a native menu takes focus, the blur handler fires, and the
 * window the menu belongs to vanishes out from under it. `PopoverWindow.setPinned`
 * exists for exactly this and is what the webhook dialogs already use.
 *
 * Counted rather than a boolean because these nest: *Share…* opens the system share
 * sheet from inside the context menu, so for a moment two menus are up, and Electron
 * does not promise whether an item's `click` runs before or after the `popup` callback
 * that reports the menu closed. A counter is right under either ordering; a boolean
 * would unpin the popover in the gap between the two on one of them. Each release is
 * idempotent, because a menu that closes twice is not a reason to un-hold something
 * somebody else is holding.
 */
function holder(popover: PopoverWindow): () => () => void {
  let held = 0

  return () => {
    held++
    popover.setPinned(true)
    let released = false

    return () => {
      if (released) return
      released = true
      held--
      if (held === 0) popover.setPinned(false)
    }
  }
}

/**
 * Whether anything older than this post is still unread.
 *
 * The same question `AppStore.hasUnreadBelow` asks in the renderer, asked again here
 * because a menu built in main cannot see the renderer's answer — and asked at all
 * because *Mark this and everything older as read* is a lie on the oldest unread post
 * (it does what *Mark as read* does) and does nothing whatsoever below it.
 */
function hasOlderUnread(state: AppState, post: StatusPost): boolean {
  const through = Date.parse(post.createdAt)
  const unread = new Set(state.unread)
  return state.posts.some((other) => unread.has(other.uri) && Date.parse(other.createdAt) < through)
}

/**
 * What the share sheet is handed.
 *
 * Both the sentence and the link, when there is a link: "the relay is down, here" is one
 * message, and a URL on its own makes the recipient click before they know whether they
 * care. The checks' own entries have no link — nobody published them, this machine
 * measured them — so those share as text alone, which is still the thing worth sending.
 */
function sharingItem(post: StatusPost): Electron.SharingItem {
  const text = `${post.authorDisplayName} · ${SEVERITY_LABEL[post.severity]}: ${post.text}`
  return post.url ? { texts: [text], urls: [post.url] } : { texts: [text] }
}

/**
 * Join the sections of a menu with separators, dropping the ones that are empty.
 *
 * Every entry below is conditional on something — a post with no link, a source that is
 * not tracked, a platform with no share sheet — so a template written with separators in
 * it would sooner or later start a menu with one, or run two together. This keeps the
 * grouping in one place and lets each section say only whether it has anything to offer.
 */
function withSeparators(sections: MenuItemConstructorOptions[][]): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  for (const section of sections) {
    if (!section.length) continue
    if (items.length) items.push({ type: 'separator' })
    items.push(...section)
  }
  return items
}

/**
 * Right-click on an update, answered with a menu the OS drew.
 *
 * The popover has never had one, which is the loudest thing about it that says *web
 * page*: every action here already existed as a button, a keystroke or an IPC method,
 * and none of them was where a hand goes to look for them. Built with
 * `Menu.buildFromTemplate` in the main process rather than drawn in HTML, because a
 * context menu is one of the few pieces of an application that people genuinely know by
 * feel — its metrics, its highlight, the way it flips near a screen edge, the way it
 * dismisses — and every one of those is wrong in a div.
 *
 * The page names the post and nothing else. Everything the menu says about it — the
 * source's name, whether it is muted, whether there is a link, whether anything older is
 * unread — is read out of the state main already owns, so an update that is not in the
 * feed cannot produce a menu, and a page cannot put words of its own in front of the
 * user. See `Popover` in schemas/statusky.eipc.
 */
export function showPostMenu(uri: string, deps: PostMenuDeps): void {
  const { model, popover } = deps
  const state = model.getState()

  const post = state.posts.find((candidate) => candidate.uri === uri)
  // Not an error worth dressing up: the feed has moved on since the click, which the
  // popover will already have redrawn. Throwing sends the sentence back to the renderer.
  if (!post) throw new Error('That update is no longer in the feed.')

  /**
   * Always found, and always unmuted. `AppState.posts` is built by `visiblePosts` out of
   * the posts whose source is tracked and not muted, so an update that can be
   * right-clicked has a source that is both. That is also why there is no *Unmute* item
   * here: a muted source has nothing in the feed to right-click, and un-muting one lives
   * in the Accounts panel, which is where you go to look for something you have hidden.
   */
  const account = state.accounts.find((candidate) => candidate.did === post.authorDid)!
  const serviceId = probeServiceId(post)
  const unread = state.unread.includes(post.uri)

  const hold = holder(popover)
  const window = popover.browserWindow ?? undefined

  const template = withSeparators([
    [
      ...(post.url
        ? [
            { label: 'Copy link', click: (): void => void clipboard.writeText(post.url) },
            {
              label: 'Open in browser',
              click: (): void => void shell.openExternal(post.url)
            }
          ]
        : []),
      ...(serviceId
        ? [
            {
              label: 'Show on the network dashboard',
              click: (): void => deps.onShowNetwork(serviceId)
            }
          ]
        : [])
    ],
    [
      ...(unread ? [{ label: 'Mark as read', click: (): void => model.markRead([post.uri]) }] : []),
      ...(hasOlderUnread(state, post)
        ? [
            {
              label: 'Mark this and everything older as read',
              click: (): void => model.markReadThrough(post.uri)
            }
          ]
        : [])
    ],
    [
      {
        label: `Mute ${account.displayName}`,
        click: (): void => {
          model.patchAccount(account.did, { muted: true })
        }
      }
    ],
    // macOS only: `ShareMenu` is the system share sheet, and there is no equivalent to
    // fall back to elsewhere. See `shareIncident`.
    process.platform === 'darwin'
      ? [{ label: 'Share…', click: (): void => shareIncident(post, hold, window) }]
      : []
  ])

  const release = hold()
  const menu = Menu.buildFromTemplate(template)
  menu.popup({ window, callback: release })
}

/**
 * Put an incident into whatever the machine can send things with.
 *
 * `ShareMenu` is one menu item standing in for Messages, Mail, AirDrop, Notes and every
 * share extension the user has installed, which is the entire argument for it: "the
 * relay is down, here" is a thing people say while an incident is live, and the
 * alternative in this app today is copy, switch application, paste, describe what you
 * pasted. macOS only, because the share sheet is a macOS idea — Windows has a Share
 * contract that Electron does not expose, and Linux has nothing of the kind — so
 * elsewhere the menu simply does not carry the item rather than carrying a dead one.
 *
 * It takes its own hold on the popover before the context menu it was opened from
 * releases its one, so the window survives the handover. The sheet is popped up against
 * the same window, which is what puts it under the cursor rather than in the middle of
 * the screen.
 */
function shareIncident(
  post: StatusPost,
  hold: () => () => void,
  window: BrowserWindow | undefined
): void {
  const release = hold()
  new ShareMenu(sharingItem(post)).popup({ window, callback: release })
}
