import { describe, expect, it } from 'vitest'
import {
  BUILTIN_ACCOUNTS,
  DEFAULT_SETTINGS,
  formatAccelerator,
  GLOBAL_SHORTCUT_CHOICES,
  MARK_READ_CHOICES,
  MAX_STORED_POSTS,
  NETWORK_INTERVAL_CHOICES,
  POLL_INTERVAL_CHOICES,
  PUBLIC_APPVIEW,
  TRAY_UNREAD_STYLE_CHOICES
} from './defaults'
import { AWAY_CHOICES, GRACE_CHOICES, PROBE_SCOPE_CHOICES, SOUND_CHOICES } from './notify'

/** The clamps `sanitizeSettings` applies, restated here so `shared` stays standalone. */
const POLL_RANGE = [15, 3600] as const
const POSTS_RANGE = [5, 100] as const

/** Assert that `value` is one of the options a Settings control offers. */
function offered<T>(choices: readonly { value: T }[], value: T): void {
  expect(choices.map((c) => c.value)).toContain(value)
}

describe('BUILTIN_ACCOUNTS', () => {
  it('ships the two documented status accounts', () => {
    expect(BUILTIN_ACCOUNTS.map((a) => a.handle)).toEqual([
      'status.bsky.app',
      'status.blacksky.community'
    ])
  })

  it('identifies each account by a DID, not a handle', () => {
    for (const account of BUILTIN_ACCOUNTS) {
      expect(account.did).toMatch(/^did:plc:[a-z0-9]+$/)
    }
  })

  it('has no duplicate DIDs', () => {
    const dids = BUILTIN_ACCOUNTS.map((a) => a.did)
    expect(new Set(dids).size).toBe(dids.length)
  })

  it('marks every shipped account builtin, visible and notifying', () => {
    for (const account of BUILTIN_ACCOUNTS) {
      expect(account.builtin).toBe(true)
      expect(account.muted).toBe(false)
      expect(account.notify).toBe('default')
    }
  })

  it('carries no addedAt, which the store stamps at install time', () => {
    for (const account of BUILTIN_ACCOUNTS) {
      expect(account).not.toHaveProperty('addedAt')
    }
  })
})

describe('DEFAULT_SETTINGS', () => {
  it('is already within the accepted ranges, so nothing is clamped on first run', () => {
    expect(DEFAULT_SETTINGS.pollIntervalSec).toBeGreaterThanOrEqual(POLL_RANGE[0])
    expect(DEFAULT_SETTINGS.pollIntervalSec).toBeLessThanOrEqual(POLL_RANGE[1])
    expect(DEFAULT_SETTINGS.postsPerAccount).toBeGreaterThanOrEqual(POSTS_RANGE[0])
    expect(DEFAULT_SETTINGS.postsPerAccount).toBeLessThanOrEqual(POSTS_RANGE[1])
  })

  it('polls often enough to be useful and rarely enough to be polite', () => {
    expect(DEFAULT_SETTINGS.pollIntervalSec).toBeGreaterThanOrEqual(60)
    expect(DEFAULT_SETTINGS.pollIntervalSec).toBeLessThanOrEqual(300)
  })

  it('starts with notifications on', () => {
    expect(DEFAULT_SETTINGS.notificationsEnabled).toBe(true)
  })

  it('follows the system theme and does not launch at login uninvited', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(DEFAULT_SETTINGS.launchAtLogin).toBe(false)
  })

  /** A default that is not among a control's own options renders as a blank control. */
  it('starts every choice the Settings panel offers on one of its options', () => {
    offered(POLL_INTERVAL_CHOICES, DEFAULT_SETTINGS.pollIntervalSec)
    offered(NETWORK_INTERVAL_CHOICES, DEFAULT_SETTINGS.networkIntervalSec)
    offered(TRAY_UNREAD_STYLE_CHOICES, DEFAULT_SETTINGS.trayUnreadStyle)
    offered(MARK_READ_CHOICES, DEFAULT_SETTINGS.markReadOn)
    offered(SOUND_CHOICES, DEFAULT_SETTINGS.notificationSound)
    offered(AWAY_CHOICES, DEFAULT_SETTINGS.notifyWhenAway)
    offered(PROBE_SCOPE_CHOICES, DEFAULT_SETTINGS.notifyProbeScope)
    offered(GRACE_CHOICES, DEFAULT_SETTINGS.notifyProbeGraceSec)
  })

  /**
   * A global shortcut is taken from every other application on the machine for as long
   * as this one runs, which is not something an app gets to do to somebody who never
   * asked for it.
   */
  it('claims no key combination from the rest of the machine', () => {
    expect(DEFAULT_SETTINGS.globalShortcut).toBe('')
    expect(GLOBAL_SHORTCUT_CHOICES).toContain(DEFAULT_SETTINGS.globalShortcut)
  })
})

describe('GLOBAL_SHORTCUT_CHOICES', () => {
  it('offers off, and nothing twice', () => {
    expect(GLOBAL_SHORTCUT_CHOICES[0]).toBe('')
    expect(new Set(GLOBAL_SHORTCUT_CHOICES).size).toBe(GLOBAL_SHORTCUT_CHOICES.length)
  })

  /**
   * `CommandOrControl` is the whole point of offering a fixed list: it is the one
   * modifier that means a different key on each platform, so every combination here is
   * one the OS can honour wherever the app runs.
   */
  it('names a real modifier and a real key in every combination', () => {
    for (const choice of GLOBAL_SHORTCUT_CHOICES.filter(Boolean)) {
      const parts = choice.split('+')
      expect(parts.length).toBeGreaterThanOrEqual(2)
      expect(parts.at(-1)).toMatch(/^[A-Z0-9]$/)
    }
  })
})

describe('formatAccelerator', () => {
  /**
   * The accelerator is the string the OS needs and is not a thing to show anybody: macOS
   * writes that combination `⌘⇧S` with no separators, and Windows and Linux write it
   * `Ctrl+Shift+S`. Showing the raw string would be a small lie on one platform or the
   * other, since `CommandOrControl` is exactly the part that differs.
   */
  it('writes a combination the way each platform writes it', () => {
    expect(formatAccelerator('CommandOrControl+Shift+S', 'darwin')).toBe('⌘⇧S')
    expect(formatAccelerator('CommandOrControl+Shift+S', 'win32')).toBe('Ctrl+Shift+S')
    expect(formatAccelerator('Alt+Shift+S', 'darwin')).toBe('⌥⇧S')
    expect(formatAccelerator('Alt+Shift+S', 'linux')).toBe('Alt+Shift+S')
  })

  it('says "Off" rather than nothing at all for no shortcut', () => {
    expect(formatAccelerator('', 'darwin')).toBe('Off')
  })

  it('spells the rarer modifiers too, and leaves the key itself as it is', () => {
    expect(formatAccelerator('Ctrl+F13', 'darwin')).toBe('⌃F13')
    expect(formatAccelerator('Super+K', 'win32')).toBe('Win+K')
  })
})

describe('POLL_INTERVAL_CHOICES', () => {
  it('is ascending and free of duplicates', () => {
    const values = POLL_INTERVAL_CHOICES.map((c) => c.value)
    expect(values).toEqual([...values].toSorted((a, b) => a - b))
    expect(new Set(values).size).toBe(values.length)
  })

  it('offers only intervals inside the accepted range', () => {
    for (const choice of POLL_INTERVAL_CHOICES) {
      expect(choice.value).toBeGreaterThanOrEqual(POLL_RANGE[0])
      expect(choice.value).toBeLessThanOrEqual(POLL_RANGE[1])
      expect(Number.isInteger(choice.value)).toBe(true)
    }
  })

  it('labels every choice', () => {
    expect(POLL_INTERVAL_CHOICES.every((c) => c.label.length > 0)).toBe(true)
  })
})

describe('constants', () => {
  it('caps stored posts at a number that fits comfortably in a config file', () => {
    expect(MAX_STORED_POSTS).toBeGreaterThan(100)
    expect(MAX_STORED_POSTS).toBeLessThanOrEqual(2000)
  })

  it('reads from the public, unauthenticated AppView over https', () => {
    expect(new URL(PUBLIC_APPVIEW).protocol).toBe('https:')
    expect(PUBLIC_APPVIEW).toBe('https://public.api.bsky.app')
  })
})

describe('DEFAULT_SETTINGS.probeTargets', () => {
  /** None, so a fresh install follows `probeTargets.json` — and whatever later releases ship. */
  it('overrides nothing out of the box', () => {
    expect(DEFAULT_SETTINGS.probeTargets).toBeNull()
  })
})
