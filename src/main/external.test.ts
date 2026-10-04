import { describe, expect, it, vi } from 'vitest'
import { openedExternally, shell } from '../test/electron'
import { openInBrowser } from './external'

describe('openInBrowser', () => {
  it.each([
    ['https://status.bsky.app/incidents/1', 'https://status.bsky.app/incidents/1'],
    ['http://status.example.test', 'http://status.example.test/'],
    // Handed over as the parser reads it, so what was checked is what the OS is given.
    ['HTTPS://Status.Bsky.App/x', 'https://status.bsky.app/x']
  ])('hands %s to the browser', async (url, opened) => {
    await expect(openInBrowser(url)).resolves.toBe(true)
    expect(openedExternally).toEqual([opened])
  })

  /**
   * What `shell.openExternal` would otherwise do with each: run a file, mount a share,
   * open Explorer on somebody else's folder, launch another app, or nothing useful at all.
   */
  it.each([
    ['a file', 'file:///Applications/Calculator.app'],
    ['a network share', 'smb://attacker.test/share'],
    ['a Windows search', 'search-ms:query=x&crumb=location:\\\\attacker.test\\share'],
    ['another app', 'zoommtg://zoom.us/join?confno=1'],
    ['a script', 'javascript:alert(1)'],
    ['the popover’s own origin', 'app://statusky/index.html'],
    ['something that is not a URL', 'status.bsky.app'],
    ['nothing', '']
  ])('refuses %s, and says so', async (_name, url) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(openInBrowser(url)).resolves.toBe(false)

    expect(shell.openExternal).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'Refused to open a link that is not an http or https URL:',
      url
    )
    warn.mockRestore()
  })

  it('passes on a failure from the OS rather than claiming the link opened', async () => {
    shell.openExternal.mockRejectedValueOnce(new Error('No application knows how to open it.'))

    await expect(openInBrowser('https://status.bsky.app')).rejects.toThrow(
      'No application knows how to open it.'
    )
  })
})
