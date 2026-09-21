import { describe, expect, it } from 'vitest'
import {
  BUILTIN_ACCOUNTS,
  DEFAULT_SETTINGS,
  MAX_STORED_POSTS,
  POLL_INTERVAL_CHOICES,
  PUBLIC_APPVIEW
} from './defaults'

/** The clamps `sanitizeSettings` applies, restated here so `shared` stays standalone. */
const POLL_RANGE = [15, 3600] as const
const POSTS_RANGE = [5, 100] as const

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
      expect(account.notify).toBe(true)
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

  it('is the default poll interval offered in the UI', () => {
    expect(POLL_INTERVAL_CHOICES.map((c) => c.value)).toContain(DEFAULT_SETTINGS.pollIntervalSec)
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
