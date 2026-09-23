import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  NETWORK_INTERVAL_CHOICES,
  POLL_INTERVAL_CHOICES
} from '../shared/defaults'
import { GRACE_CHOICES } from '../shared/notify'
import type { Account, Settings, StatusPost } from '../shared/types'
import {
  advanceCursors,
  compactRead,
  EMPTY_READ,
  forgetSource,
  markAllPostsRead,
  markPostsRead,
  markReadThrough,
  mergePosts,
  patchAccount,
  pollableAccounts,
  sanitizeSettings,
  seedReadCursors,
  selectNotifiable,
  unreadUris,
  upsertAccount,
  visiblePosts,
  type Cursors,
  type ReadState
} from './state'

const DID_A = 'did:plc:aaa'
const DID_B = 'did:plc:bbb'

function account(did: string, overrides: Partial<Account> = {}): Account {
  return {
    did,
    handle: `${did}.test`,
    displayName: did,
    avatar: null,
    description: null,
    notify: 'default',
    muted: false,
    addedAt: '2026-01-01T00:00:00Z',
    builtin: false,
    kind: 'atproto',
    ...overrides
  }
}

function post(did: string, createdAt: string, overrides: Partial<StatusPost> = {}): StatusPost {
  return {
    uri: `at://${did}/app.bsky.feed.post/${createdAt}`,
    cid: 'cid',
    rkey: createdAt,
    authorDid: did,
    authorHandle: `${did}.test`,
    authorDisplayName: did,
    authorAvatar: null,
    text: '',
    segments: [],
    embed: null,
    createdAt,
    indexedAt: createdAt,
    // An outage, so that every stage filter lets it through unless a test says otherwise.
    severity: 'outage',
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    url: 'https://bsky.app',
    ...overrides
  }
}

const settings: Settings = { ...DEFAULT_SETTINGS }
const tracked = new Set([DID_A, DID_B])

describe('mergePosts', () => {
  it('deduplicates by uri and keeps the incoming copy', () => {
    const existing = [post(DID_A, '2026-09-01T00:00:00Z', { likeCount: 1 })]
    const incoming = [post(DID_A, '2026-09-01T00:00:00Z', { likeCount: 99 })]
    const merged = mergePosts(existing, incoming, tracked)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.likeCount).toBe(99)
  })

  it('drops posts from accounts that are no longer tracked', () => {
    const merged = mergePosts(
      [post('did:plc:gone', '2026-09-01T00:00:00Z')],
      [post(DID_A, '2026-09-02T00:00:00Z')],
      tracked
    )
    expect(merged.map((p) => p.authorDid)).toEqual([DID_A])
  })

  it('sorts newest first and enforces the cap', () => {
    const incoming = [
      post(DID_A, '2026-09-01T00:00:00Z'),
      post(DID_A, '2026-09-03T00:00:00Z'),
      post(DID_A, '2026-09-02T00:00:00Z')
    ]
    const merged = mergePosts([], incoming, tracked, 2)
    expect(merged.map((p) => p.createdAt)).toEqual(['2026-09-03T00:00:00Z', '2026-09-02T00:00:00Z'])
  })
})

describe('selectNotifiable', () => {
  const accounts = [account(DID_A), account(DID_B)]

  it('stays silent on an account’s first sync', () => {
    const incoming = [post(DID_A, '2026-09-05T00:00:00Z')]
    expect(selectNotifiable(incoming, {}, accounts, settings)).toEqual([])
  })

  it('notifies only for posts newer than the cursor', () => {
    const cursors: Cursors = { [DID_A]: '2026-09-05T00:00:00Z' }
    const incoming = [
      post(DID_A, '2026-09-04T00:00:00Z'),
      post(DID_A, '2026-09-05T00:00:00Z'),
      post(DID_A, '2026-09-06T00:00:00Z')
    ]
    expect(selectNotifiable(incoming, cursors, accounts, settings).map((p) => p.createdAt)).toEqual(
      ['2026-09-06T00:00:00Z']
    )
  })

  it('returns posts oldest-first so the newest lands on top of the stack', () => {
    const cursors: Cursors = { [DID_A]: '2026-09-01T00:00:00Z' }
    const incoming = [post(DID_A, '2026-09-06T00:00:00Z'), post(DID_A, '2026-09-05T00:00:00Z')]
    expect(selectNotifiable(incoming, cursors, accounts, settings).map((p) => p.createdAt)).toEqual(
      ['2026-09-05T00:00:00Z', '2026-09-06T00:00:00Z']
    )
  })

  it('respects the per-account notify toggle', () => {
    const cursors: Cursors = { [DID_A]: '2026-09-01T00:00:00Z' }
    const silenced = [account(DID_A, { notify: 'off' })]
    expect(
      selectNotifiable([post(DID_A, '2026-09-06T00:00:00Z')], cursors, silenced, settings)
    ).toEqual([])
  })

  it('respects mute as well as the notify toggle', () => {
    const cursors: Cursors = { [DID_A]: '2026-09-01T00:00:00Z' }
    const muted = [account(DID_A, { muted: true })]
    expect(
      selectNotifiable([post(DID_A, '2026-09-06T00:00:00Z')], cursors, muted, settings)
    ).toEqual([])
  })

  it('respects the master switch', () => {
    const cursors: Cursors = { [DID_A]: '2026-09-01T00:00:00Z' }
    const off = { ...settings, notificationsEnabled: false }
    expect(selectNotifiable([post(DID_A, '2026-09-06T00:00:00Z')], cursors, accounts, off)).toEqual(
      []
    )
  })

  it('ignores posts from untracked accounts', () => {
    const cursors: Cursors = { 'did:plc:gone': '2026-09-01T00:00:00Z' }
    expect(
      selectNotifiable([post('did:plc:gone', '2026-09-06T00:00:00Z')], cursors, accounts, settings)
    ).toEqual([])
  })

  it('ignores posts with an unparseable timestamp', () => {
    const cursors: Cursors = { [DID_A]: '2026-09-01T00:00:00Z' }
    expect(selectNotifiable([post(DID_A, 'not-a-date')], cursors, accounts, settings)).toEqual([])
  })

  it('leaves out the stages the user did not ask to hear about', () => {
    const cursors: Cursors = { [DID_A]: '2026-09-01T00:00:00Z' }
    const routine = post(DID_A, '2026-09-06T00:00:00Z', { severity: 'maintenance' })
    const broken = post(DID_A, '2026-09-07T00:00:00Z')

    expect(selectNotifiable([routine, broken], cursors, accounts, settings)).toEqual([broken])
  })
})

describe('advanceCursors', () => {
  it('records the newest post per account', () => {
    const next = advanceCursors({}, [
      post(DID_A, '2026-09-01T00:00:00Z'),
      post(DID_A, '2026-09-05T00:00:00Z'),
      post(DID_B, '2026-09-03T00:00:00Z')
    ])
    expect(next).toEqual({ [DID_A]: '2026-09-05T00:00:00Z', [DID_B]: '2026-09-03T00:00:00Z' })
  })

  it('never rewinds an existing cursor', () => {
    const next = advanceCursors({ [DID_A]: '2026-09-05T00:00:00Z' }, [
      post(DID_A, '2026-09-01T00:00:00Z')
    ])
    expect(next[DID_A]).toBe('2026-09-05T00:00:00Z')
  })

  it('leaves other accounts untouched', () => {
    const next = advanceCursors({ [DID_B]: '2026-01-01T00:00:00Z' }, [
      post(DID_A, '2026-09-01T00:00:00Z')
    ])
    expect(next[DID_B]).toBe('2026-01-01T00:00:00Z')
  })
})

// ------------------------------------------------------------ read cursors

/** A read state with one cursor per named source, and nothing read above them. */
function readAt(cursors: Cursors): ReadState {
  return { cursors, above: [] }
}

describe('seedReadCursors', () => {
  it('adopts the notification cursor for a source it has never seen', () => {
    const seeded = seedReadCursors(EMPTY_READ, { [DID_A]: '2026-09-01T00:00:00Z' })
    expect(seeded.cursors).toEqual({ [DID_A]: '2026-09-01T00:00:00Z' })
  })

  it('never moves a cursor it already has', () => {
    const read = readAt({ [DID_A]: '2026-09-01T00:00:00Z' })
    const seeded = seedReadCursors(read, { [DID_A]: '2026-09-09T00:00:00Z' })
    expect(seeded.cursors[DID_A]).toBe('2026-09-01T00:00:00Z')
  })

  it('returns the same object when there is nothing to seed', () => {
    const read = readAt({ [DID_A]: '2026-09-01T00:00:00Z' })
    expect(seedReadCursors(read, { [DID_A]: '2026-09-09T00:00:00Z' })).toBe(read)
  })
})

describe('unreadUris', () => {
  const posts = [post(DID_A, '2026-09-06T00:00:00Z'), post(DID_A, '2026-09-02T00:00:00Z')]

  it('counts what is newer than the cursor, newest first', () => {
    const read = readAt({ [DID_A]: '2026-09-01T00:00:00Z' })
    expect(unreadUris(posts, read)).toEqual([posts[0]!.uri, posts[1]!.uri])
  })

  it('treats a source with no cursor as fully read', () => {
    expect(unreadUris(posts, EMPTY_READ)).toEqual([])
  })

  it('honours a post read out of order', () => {
    const read: ReadState = { cursors: { [DID_A]: '2026-09-01T00:00:00Z' }, above: [posts[0]!.uri] }
    expect(unreadUris(posts, read)).toEqual([posts[1]!.uri])
  })

  it('ignores a post whose timestamp does not parse', () => {
    const broken = post(DID_A, 'not a date')
    const read = readAt({ [DID_A]: '2026-09-01T00:00:00Z' })
    expect(unreadUris([broken], read)).toEqual([])
  })
})

describe('markPostsRead', () => {
  it('folds a contiguous run back into the cursor', () => {
    const older = post(DID_A, '2026-09-02T00:00:00Z')
    const newer = post(DID_A, '2026-09-06T00:00:00Z')
    const read = markPostsRead(
      readAt({ [DID_A]: '2026-09-01T00:00:00Z' }),
      [older.uri],
      [newer, older]
    )

    expect(read.cursors[DID_A]).toBe(older.createdAt)
    expect(read.above).toEqual([])
    expect(unreadUris([newer, older], read)).toEqual([newer.uri])
  })

  it('remembers a post read out of order rather than reading everything under it', () => {
    const older = post(DID_A, '2026-09-02T00:00:00Z')
    const newer = post(DID_A, '2026-09-06T00:00:00Z')
    const read = markPostsRead(
      readAt({ [DID_A]: '2026-09-01T00:00:00Z' }),
      [newer.uri],
      [newer, older]
    )

    expect(read.cursors[DID_A]).toBe('2026-09-01T00:00:00Z')
    expect(read.above).toEqual([newer.uri])
    expect(unreadUris([newer, older], read)).toEqual([older.uri])
  })

  it('collapses the exception once the gap under it is read too', () => {
    const older = post(DID_A, '2026-09-02T00:00:00Z')
    const newer = post(DID_A, '2026-09-06T00:00:00Z')
    const posts = [newer, older]
    let read = markPostsRead(readAt({ [DID_A]: '2026-09-01T00:00:00Z' }), [newer.uri], posts)
    read = markPostsRead(read, [older.uri], posts)

    expect(read).toEqual({ cursors: { [DID_A]: newer.createdAt }, above: [] })
  })

  it('ignores a URI that is not in the cache', () => {
    const read = markPostsRead(readAt({ [DID_A]: '2026-09-01T00:00:00Z' }), ['at://gone'], [])
    expect(read.above).toEqual([])
  })

  it('keeps sources apart', () => {
    const a = post(DID_A, '2026-09-06T00:00:00Z')
    const b = post(DID_B, '2026-09-06T00:00:00Z')
    const cursors = { [DID_A]: '2026-09-01T00:00:00Z', [DID_B]: '2026-09-01T00:00:00Z' }
    const read = markPostsRead(readAt(cursors), [a.uri], [a, b])

    expect(unreadUris([a, b], read)).toEqual([b.uri])
  })
})

describe('compactRead', () => {
  it('forgets an exception whose post has aged out of the cache', () => {
    const gone = post(DID_A, '2026-09-06T00:00:00Z')
    const read: ReadState = { cursors: { [DID_A]: '2026-09-01T00:00:00Z' }, above: [gone.uri] }
    expect(compactRead(read, []).above).toEqual([])
  })

  it('forgets an exception belonging to a source with no cursor', () => {
    const orphan = post(DID_A, '2026-09-06T00:00:00Z')
    expect(compactRead({ cursors: {}, above: [orphan.uri] }, [orphan]).above).toEqual([])
  })

  it('leaves a post whose timestamp does not parse alone', () => {
    const broken = post(DID_A, 'not a date')
    const read: ReadState = { cursors: { [DID_A]: '2026-09-01T00:00:00Z' }, above: [broken.uri] }
    const next = compactRead(read, [broken])

    expect(next.cursors[DID_A]).toBe('2026-09-01T00:00:00Z')
    expect(next.above).toEqual([])
  })
})

describe('markAllPostsRead', () => {
  it("moves every cursor to that source's newest post and drops the exceptions", () => {
    const a = post(DID_A, '2026-09-06T00:00:00Z')
    const b = post(DID_B, '2026-09-04T00:00:00Z')
    const cursors = { [DID_A]: '2026-09-01T00:00:00Z', [DID_B]: '2026-09-01T00:00:00Z' }
    const read = markAllPostsRead({ cursors, above: [a.uri] }, [a, b])

    expect(read).toEqual({ cursors: { [DID_A]: a.createdAt, [DID_B]: b.createdAt }, above: [] })
  })

  it('never rewinds a cursor that is already ahead', () => {
    const old = post(DID_A, '2026-09-01T00:00:00Z')
    const read = markAllPostsRead(readAt({ [DID_A]: '2026-09-09T00:00:00Z' }), [old])
    expect(read.cursors[DID_A]).toBe('2026-09-09T00:00:00Z')
  })

  it('gives no cursor to a source that has never been seen', () => {
    const unseen = post(DID_A, '2026-09-06T00:00:00Z')
    expect(markAllPostsRead(EMPTY_READ, [unseen]).cursors).toEqual({})
  })

  it('ignores a post whose timestamp does not parse', () => {
    const broken = post(DID_A, 'not a date')
    const read = markAllPostsRead(readAt({ [DID_A]: '2026-09-01T00:00:00Z' }), [broken])
    expect(read.cursors[DID_A]).toBe('2026-09-01T00:00:00Z')
  })
})

describe('markReadThrough', () => {
  const a = post(DID_A, '2026-09-06T00:00:00Z')
  const b = post(DID_B, '2026-09-04T00:00:00Z')
  const c = post(DID_A, '2026-09-02T00:00:00Z')
  const posts = [a, b, c]
  const cursors = { [DID_A]: '2026-09-01T00:00:00Z', [DID_B]: '2026-09-01T00:00:00Z' }

  it('reads one post and everything older, across every source', () => {
    const read = markReadThrough(readAt(cursors), b.uri, posts)
    expect(unreadUris(posts, read)).toEqual([a.uri])
  })

  it('leaves a source already read past that moment alone', () => {
    const ahead = { ...cursors, [DID_B]: '2026-09-09T00:00:00Z' }
    const read = markReadThrough(readAt(ahead), b.uri, posts)
    expect(read.cursors[DID_B]).toBe('2026-09-09T00:00:00Z')
  })

  it('does nothing for a post that is not in the cache', () => {
    const read = readAt(cursors)
    expect(markReadThrough(read, 'at://gone', posts)).toBe(read)
  })

  it('does nothing for a post whose timestamp does not parse', () => {
    const broken = post(DID_A, 'not a date')
    const read = readAt(cursors)
    expect(markReadThrough(read, broken.uri, [...posts, broken])).toBe(read)
  })
})

describe('forgetSource', () => {
  it('drops the cursor and any exception pointing at that source', () => {
    const a = post(DID_A, '2026-09-06T00:00:00Z')
    const b = post(DID_B, '2026-09-06T00:00:00Z')
    const read: ReadState = {
      cursors: { [DID_A]: '2026-09-01T00:00:00Z', [DID_B]: '2026-09-01T00:00:00Z' },
      above: [a.uri, b.uri]
    }

    expect(forgetSource(read, DID_A, [a, b])).toEqual({
      cursors: { [DID_B]: '2026-09-01T00:00:00Z' },
      above: [b.uri]
    })
  })
})

describe('upsertAccount / patchAccount', () => {
  it('appends an account that is not present', () => {
    expect(upsertAccount([], account(DID_A))).toHaveLength(1)
  })

  it('replaces an existing account in place', () => {
    const accounts = [account(DID_A, { displayName: 'old' })]
    const next = upsertAccount(accounts, account(DID_A, { displayName: 'new' }))
    expect(next).toHaveLength(1)
    expect(next[0]?.displayName).toBe('new')
  })

  it('never downgrades a builtin account to removable', () => {
    const accounts = [account(DID_A, { builtin: true })]
    expect(upsertAccount(accounts, account(DID_A, { builtin: false }))[0]?.builtin).toBe(true)
  })

  it('patches only the addressed account', () => {
    const accounts = [account(DID_A), account(DID_B)]
    const next = patchAccount(accounts, DID_A, { notify: 'off' })
    expect(next[0]?.notify).toBe('off')
    expect(next[1]?.notify).toBe('default')
  })
})

describe('visiblePosts', () => {
  it('hides posts from muted accounts', () => {
    const accounts = [account(DID_A, { muted: true }), account(DID_B)]
    const posts = [post(DID_A, '2026-09-01T00:00:00Z'), post(DID_B, '2026-09-02T00:00:00Z')]
    expect(visiblePosts(posts, accounts).map((p) => p.authorDid)).toEqual([DID_B])
  })
})

describe('pollableAccounts', () => {
  it('polls AT Protocol accounts, and nothing whose entries arrive on their own', () => {
    const polled = account(DID_A)
    const pushed = account('webhook:pg', { kind: 'webhook' })
    const measured = account('probe:network', { kind: 'probe' })
    expect(pollableAccounts([polled, pushed, measured])).toEqual([polled])
  })
})

describe('sanitizeSettings', () => {
  it('clamps the poll interval into a sane range', () => {
    expect(sanitizeSettings({ ...settings, pollIntervalSec: 1 }).pollIntervalSec).toBe(15)
    expect(sanitizeSettings({ ...settings, pollIntervalSec: 99_999 }).pollIntervalSec).toBe(3600)
  })

  it('clamps posts per account to what the AppView allows', () => {
    expect(sanitizeSettings({ ...settings, postsPerAccount: 0 }).postsPerAccount).toBe(5)
    expect(sanitizeSettings({ ...settings, postsPerAccount: 5000 }).postsPerAccount).toBe(100)
  })

  it('rounds fractional values', () => {
    expect(sanitizeSettings({ ...settings, pollIntervalSec: 61.7 }).pollIntervalSec).toBe(62)
  })

  it('never lets the network checks sweep more than once a minute, or less than hourly', () => {
    expect(sanitizeSettings({ ...settings, networkIntervalSec: 10 }).networkIntervalSec).toBe(60)
    expect(sanitizeSettings({ ...settings, networkIntervalSec: 86_400 }).networkIntervalSec).toBe(
      3600
    )
  })

  it('holds the grace period on a measured outage between none and an hour', () => {
    const grace = (value: number): number =>
      sanitizeSettings({ ...settings, notifyProbeGraceSec: value }).notifyProbeGraceSec
    expect(grace(-30)).toBe(0)
    expect(grace(Number.NaN)).toBe(0)
    expect(grace(119.6)).toBe(120)
    expect(grace(86_400)).toBe(3600)
  })

  it('keeps the receiver in the unprivileged ports, and zero as "any free one"', () => {
    const port = (value: number): number =>
      sanitizeSettings({ ...settings, webhookPort: value }).webhookPort
    expect(port(0)).toBe(0)
    expect(port(-1)).toBe(0)
    expect(port(Number.NaN)).toBe(0)
    expect(port(80)).toBe(1024)
    expect(port(8080.4)).toBe(8080)
    expect(port(70_000)).toBe(65535)
  })

  /** A repeated stage would stop the stages matching the preset they amount to. */
  it('lists each stage, source and pinned service once', () => {
    const next = sanitizeSettings({
      ...settings,
      notifySeverities: ['outage', 'degraded', 'outage'],
      notifySources: ['probe', 'probe'],
      pinnedServices: ['relay:bsky.network', 'relay:bsky.network']
    })

    expect(next.notifySeverities).toEqual(['outage', 'degraded'])
    expect(next.notifySources).toEqual(['probe'])
    expect(next.pinnedServices).toEqual(['relay:bsky.network'])
  })
})

describe('edge cases', () => {
  it('drops incoming posts from accounts that are no longer tracked', () => {
    const merged = mergePosts(
      [],
      [post(DID_A, '2026-01-01T00:00:00Z'), post('did:plc:gone', '2026-01-02T00:00:00Z')],
      new Set([DID_A])
    )
    expect(merged.map((p) => p.authorDid)).toEqual([DID_A])
  })

  it('ignores a post whose timestamp cannot be parsed when advancing cursors', () => {
    const cursors: Cursors = { [DID_A]: '2026-01-01T00:00:00Z' }
    const next = advanceCursors(cursors, [post(DID_A, 'not-a-date')])
    expect(next[DID_A]).toBe('2026-01-01T00:00:00Z')
  })

  it('seeds nothing from a post whose timestamp cannot be parsed', () => {
    expect(advanceCursors({}, [post(DID_A, 'not-a-date')])).toEqual({})
  })
})

describe('sanitizeSettings against the shipped choices', () => {
  it('keeps every network interval the UI offers', () => {
    for (const choice of NETWORK_INTERVAL_CHOICES) {
      expect(
        sanitizeSettings({ ...DEFAULT_SETTINGS, networkIntervalSec: choice.value })
          .networkIntervalSec
      ).toBe(choice.value)
    }
  })

  it('keeps every poll interval the UI offers', () => {
    for (const choice of POLL_INTERVAL_CHOICES) {
      expect(
        sanitizeSettings({ ...DEFAULT_SETTINGS, pollIntervalSec: choice.value }).pollIntervalSec
      ).toBe(choice.value)
    }
  })

  it('keeps every grace period the UI offers', () => {
    for (const choice of GRACE_CHOICES) {
      expect(
        sanitizeSettings({ ...DEFAULT_SETTINGS, notifyProbeGraceSec: choice.value })
          .notifyProbeGraceSec
      ).toBe(choice.value)
    }
  })

  it('leaves the defaults untouched', () => {
    expect(sanitizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })
})
