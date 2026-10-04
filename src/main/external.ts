import { shell } from 'electron'
import { safeHttpUrl } from '../shared/richtext'

/**
 * Hand a link to the user's own browser, if it is a link to the web; resolves with
 * whether it was handed over.
 *
 * `shell.openExternal` is not a browser: it is the OS's "open this with whatever handles
 * it", and the OS will hand any scheme it has a handler for to that handler. `file:`
 * runs what it names, `smb:` mounts a share, `search-ms:` opens Explorer on a folder
 * somebody else chose, and every installed app's own scheme is one more door. The URLs
 * this app opens come, one way or another, out of posts and pushed updates written by
 * people it does not know — so everything main sends out goes through here, and here
 * holds it to `safeHttpUrl`, the same rule a post's links are held to when they are read
 * in. A link the popover tried to open in a window of its own or navigate to, the
 * context menu and a clicked banner all arrive at the same check, and `Host.openExternal`
 * holds what a page asks for to the same rule — which is what keeps any one of them from
 * becoming the way round the others.
 *
 * Anything refused is logged, not thrown: most callers are a click on something the OS
 * drew, with no page waiting on the answer, and a refusal is a link that was never going
 * to go anywhere. One that does want to tell somebody can read the `false`.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const safe = safeHttpUrl(url)
  if (!safe) {
    console.warn('Refused to open a link that is not an http or https URL:', url)
    return false
  }
  await shell.openExternal(safe)
  return true
}
