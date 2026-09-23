import { describe, expect, it } from 'vitest'
import {
  BskyError,
  fetchAuthorPosts,
  fetchProfiles,
  normalizePost,
  parseActorInput,
  postPermalink,
  resolveActor,
  rkeyFromUri,
  sortPosts
} from './bsky'
import type { StatusPost } from './types'

const URI = 'at://did:plc:4dtbz2ivhp5app3sbntcccxc/app.bsky.feed.post/3muqb7tg3o72e'

describe('parseActorInput', () => {
  it.each([
    ['status.bsky.app', 'status.bsky.app'],
    ['@status.bsky.app', 'status.bsky.app'],
    ['  Status.Bsky.App  ', 'status.bsky.app'],
    ['https://bsky.app/profile/status.bsky.app', 'status.bsky.app'],
    ['https://bsky.app/profile/status.blacksky.community/', 'status.blacksky.community'],
    ['bsky.app/profile/did:plc:abc123', 'did:plc:abc123'],
    ['did:plc:4dtbz2ivhp5app3sbntcccxc', 'did:plc:4dtbz2ivhp5app3sbntcccxc'],
    ['at://status.bsky.app/app.bsky.feed.post/abc', 'status.bsky.app'],
    ['at://status.bsky.app', 'status.bsky.app'],
    ['at://', '']
  ])('parses %j to %j', (input, expected) => {
    expect(parseActorInput(input)).toBe(expected)
  })

  it('returns an empty string for blank input', () => {
    expect(parseActorInput('   ')).toBe('')
  })
})

describe('rkeyFromUri / postPermalink', () => {
  it('extracts the record key', () => {
    expect(rkeyFromUri(URI)).toBe('3muqb7tg3o72e')
  })

  it('builds a public permalink from the handle', () => {
    expect(postPermalink('status.bsky.app', URI)).toBe(
      'https://bsky.app/profile/status.bsky.app/post/3muqb7tg3o72e'
    )
  })
})

describe('normalizePost', () => {
  const raw = {
    uri: URI,
    cid: 'bafy123',
    author: {
      did: 'did:plc:4dtbz2ivhp5app3sbntcccxc',
      handle: 'status.bsky.app',
      displayName: 'Bluesky Status',
      avatar: 'https://cdn.bsky.app/avatar.jpg'
    },
    record: {
      $type: 'app.bsky.feed.post',
      text: 'This incident has been resolved.',
      createdAt: '2026-09-05T00:52:11Z'
    },
    indexedAt: '2026-09-05T00:52:11.760Z',
    replyCount: 3,
    repostCount: 11,
    likeCount: 67
  }

  it('flattens a post view and derives severity and permalink', () => {
    const post = normalizePost(raw)
    expect(post).toMatchObject({
      uri: URI,
      rkey: '3muqb7tg3o72e',
      authorHandle: 'status.bsky.app',
      severity: 'resolved',
      likeCount: 67,
      url: 'https://bsky.app/profile/status.bsky.app/post/3muqb7tg3o72e'
    })
  })

  it('rejects records that are not app.bsky.feed.post', () => {
    expect(
      normalizePost({ ...raw, record: { ...raw.record, $type: 'app.bsky.feed.like' } })
    ).toBeNull()
  })

  it.each([
    ['no post at all', undefined],
    ['a missing uri', { ...raw, uri: undefined }],
    ['a missing cid', { ...raw, cid: undefined }],
    ['a missing author did', { ...raw, author: { handle: 'x' } }],
    ['a missing record', { ...raw, record: undefined }]
  ])('returns null for %s', (_name, input) => {
    expect(normalizePost(input as never)).toBeNull()
  })

  it('falls back to the DID when the handle is missing', () => {
    const post = normalizePost({ ...raw, author: { did: 'did:plc:x' } })
    expect(post?.authorHandle).toBe('did:plc:x')
    expect(post?.authorDisplayName).toBe('did:plc:x')
  })

  it('normalises an external embed', () => {
    const post = normalizePost({
      ...raw,
      embed: {
        $type: 'app.bsky.embed.external#view',
        external: {
          uri: 'https://status.bsky.app',
          title: 'Bluesky Status',
          description: 'Incident history',
          thumb: 'https://cdn.bsky.app/thumb.jpg'
        }
      }
    })
    expect(post?.embed).toEqual({
      kind: 'external',
      uri: 'https://status.bsky.app',
      title: 'Bluesky Status',
      description: 'Incident history',
      thumb: 'https://cdn.bsky.app/thumb.jpg'
    })
  })

  it('unwraps the media half of a recordWithMedia embed', () => {
    const post = normalizePost({
      ...raw,
      embed: {
        $type: 'app.bsky.embed.recordWithMedia#view',
        media: {
          $type: 'app.bsky.embed.images#view',
          images: [{ thumb: 't.jpg', fullsize: 'f.jpg', alt: 'a graph' }]
        }
      }
    })
    expect(post?.embed).toEqual({
      kind: 'images',
      images: [{ thumb: 't.jpg', fullsize: 'f.jpg', alt: 'a graph' }]
    })
  })

  it('drops embeds it cannot render', () => {
    expect(
      normalizePost({ ...raw, embed: { $type: 'app.bsky.embed.video#view' } })?.embed
    ).toBeNull()
  })
})

const make = (createdAt: string, indexedAt = createdAt): StatusPost =>
  ({ uri: createdAt, createdAt, indexedAt }) as StatusPost

describe('sortPosts', () => {
  it('orders newest first', () => {
    const sorted = sortPosts([
      make('2026-09-01T00:00:00Z'),
      make('2026-09-05T00:00:00Z'),
      make('2026-09-03T00:00:00Z')
    ])
    expect(sorted.map((p) => p.createdAt)).toEqual([
      '2026-09-05T00:00:00Z',
      '2026-09-03T00:00:00Z',
      '2026-09-01T00:00:00Z'
    ])
  })

  it('breaks ties on the index timestamp', () => {
    const sorted = sortPosts([
      make('2026-09-05T00:00:00Z', '2026-09-05T00:00:01Z'),
      make('2026-09-05T00:00:00Z', '2026-09-05T00:00:09Z')
    ])
    expect(sorted[0]?.indexedAt).toBe('2026-09-05T00:00:09Z')
  })

  // A record's `createdAt` is whatever its author's client wrote, so it can be garbage.
  it('falls back to the index time when a record timestamp does not parse', () => {
    const sorted = sortPosts([
      make('whenever', '2026-09-05T00:00:01Z'),
      make('whenever', '2026-09-05T00:00:09Z')
    ])
    expect(sorted.map((p) => p.indexedAt)).toEqual(['2026-09-05T00:00:09Z', '2026-09-05T00:00:01Z'])
  })

  it('does not mutate its input', () => {
    const input = [make('2026-09-01T00:00:00Z'), make('2026-09-05T00:00:00Z')]
    sortPosts(input)
    expect(input[0]?.createdAt).toBe('2026-09-01T00:00:00Z')
  })
})

// ---------------------------------------------------------------- network layer
//
// `FetchOptions.fetchImpl` exists so the XRPC calls can be exercised without a
// network: these tests cover the filtering and error handling that decide what
// actually reaches the feed.

interface Call {
  url: URL
}

function stubFetch(
  handler: (
    url: URL
  ) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  // Narrower than the real `fetch` signature; the cast below reconciles them.
  const fetchImpl = (async (input: URL | string) => {
    const url = input instanceof URL ? input : new URL(String(input))
    calls.push({ url })
    const { status = 200, body } = await handler(url)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      json: async () => body
    } as Response
  }) as unknown as typeof fetch

  return { fetchImpl, calls }
}

const feedPost = (rkey: string, text: string, createdAt: string): unknown => ({
  post: {
    uri: `at://did:plc:aaa/app.bsky.feed.post/${rkey}`,
    cid: `cid-${rkey}`,
    author: { did: 'did:plc:aaa', handle: 'status.test', displayName: 'Status' },
    record: { $type: 'app.bsky.feed.post', text, createdAt },
    indexedAt: createdAt
  }
})

describe('fetchAuthorPosts', () => {
  it('requests only top-level posts for the given actor', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: { feed: [] } }))
    await fetchAuthorPosts('did:plc:aaa', 30, { fetchImpl })

    const url = calls[0]!.url
    expect(url.pathname).toBe('/xrpc/app.bsky.feed.getAuthorFeed')
    expect(url.searchParams.get('actor')).toBe('did:plc:aaa')
    expect(url.searchParams.get('limit')).toBe('30')
    expect(url.searchParams.get('filter')).toBe('posts_no_replies')
  })

  it('clamps the limit to what the AppView accepts', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: { feed: [] } }))
    await fetchAuthorPosts('did:plc:aaa', 5000, { fetchImpl })
    expect(calls[0]!.url.searchParams.get('limit')).toBe('100')

    await fetchAuthorPosts('did:plc:aaa', 0, { fetchImpl })
    expect(calls[1]!.url.searchParams.get('limit')).toBe('1')
  })

  it('returns normalised posts, newest first', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: {
        feed: [
          feedPost('a', 'We are investigating an issue.', '2026-09-01T00:00:00Z'),
          feedPost('b', 'This incident has been resolved.', '2026-09-02T00:00:00Z')
        ]
      }
    }))

    const posts = await fetchAuthorPosts('did:plc:aaa', 30, { fetchImpl })
    expect(posts.map((p) => p.rkey)).toEqual(['b', 'a'])
    expect(posts.map((p) => p.severity)).toEqual(['resolved', 'investigating'])
  })

  it('drops reposts, replies and non-post records', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: {
        feed: [
          { ...(feedPost('own', 'Ours.', '2026-09-03T00:00:00Z') as object) },
          // A repost of somebody else's post carries a `reason`.
          {
            ...(feedPost('rp', 'Someone else.', '2026-09-02T00:00:00Z') as object),
            reason: { $type: 'app.bsky.feed.defs#reasonRepost' }
          },
          // A reply slipped past the server-side filter.
          {
            post: {
              uri: 'at://did:plc:aaa/app.bsky.feed.post/reply',
              cid: 'c',
              author: { did: 'did:plc:aaa', handle: 'status.test' },
              record: {
                $type: 'app.bsky.feed.post',
                text: 'A reply.',
                createdAt: '2026-09-01T00:00:00Z',
                reply: { root: {} }
              },
              indexedAt: '2026-09-01T00:00:00Z'
            }
          },
          // Something that is not a post record at all.
          {
            post: {
              uri: 'at://did:plc:aaa/app.bsky.feed.generator/x',
              cid: 'c',
              author: { did: 'did:plc:aaa', handle: 'status.test' },
              record: { $type: 'app.bsky.feed.generator' },
              indexedAt: '2026-09-01T00:00:00Z'
            }
          }
        ]
      }
    }))

    const posts = await fetchAuthorPosts('did:plc:aaa', 30, { fetchImpl })
    expect(posts.map((p) => p.rkey)).toEqual(['own'])
  })

  it('tolerates a response with no feed key', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: {} }))
    await expect(fetchAuthorPosts('did:plc:aaa', 30, { fetchImpl })).resolves.toEqual([])
  })

  it('surfaces the server error message', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 400,
      body: { error: 'InvalidRequest', message: 'Profile not found' }
    }))

    await expect(fetchAuthorPosts('nope.test', 30, { fetchImpl })).rejects.toThrow(
      'Profile not found'
    )
  })

  it('wraps a transport failure as a BskyError', async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof fetch
    await expect(fetchAuthorPosts('did:plc:aaa', 30, { fetchImpl })).rejects.toBeInstanceOf(
      BskyError
    )
  })

  it('lets an abort propagate rather than masking it as a network error', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const fetchImpl = (() => Promise.reject(abort)) as unknown as typeof fetch
    // The very same error: a wrapped one would still mention "aborted" in its message.
    await expect(fetchAuthorPosts('did:plc:aaa', 30, { fetchImpl })).rejects.toBe(abort)
  })

  // The caller's timeout is the only thing that ends a request the AppView never answers.
  it('hands the caller’s abort signal to fetch', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | null | undefined
    const fetchImpl = (async (_input: URL, init?: RequestInit) => {
      seen = init?.signal
      return { ok: true, status: 200, json: async () => ({ feed: [] }) } as Response
    }) as unknown as typeof fetch

    await fetchAuthorPosts('did:plc:aaa', 30, { fetchImpl, signal: controller.signal })

    expect(seen).toBe(controller.signal)
  })
})

describe('resolveActor', () => {
  it('normalises the input before querying', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      body: { did: 'did:plc:aaa', handle: 'status.bsky.app', displayName: 'Bluesky Status' }
    }))

    const profile = await resolveActor('https://bsky.app/profile/Status.Bsky.App', { fetchImpl })
    expect(calls[0]!.url.searchParams.get('actor')).toBe('status.bsky.app')
    expect(profile).toMatchObject({ did: 'did:plc:aaa', handle: 'status.bsky.app' })
  })

  it('rejects blank input without hitting the network', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: {} }))
    await expect(resolveActor('   ', { fetchImpl })).rejects.toThrow(/Enter a handle/)
    expect(calls).toHaveLength(0)
  })

  it('rejects a response missing a did or handle', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: { displayName: 'Nobody' } }))
    await expect(resolveActor('nobody.test', { fetchImpl })).rejects.toThrow(/Could not resolve/)
  })
})

describe('fetchProfiles', () => {
  it('makes no request for an empty list', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: {} }))
    await expect(fetchProfiles([], { fetchImpl })).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('chunks into batches of 25, which is the AppView limit', async () => {
    const dids = Array.from({ length: 60 }, (_, i) => `did:plc:${i}`)
    const { fetchImpl, calls } = stubFetch((url) => ({
      body: {
        profiles: url.searchParams.getAll('actors').map((did) => ({ did, handle: `${did}.test` }))
      }
    }))

    const profiles = await fetchProfiles(dids, { fetchImpl })
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.url.searchParams.getAll('actors').length)).toEqual([25, 25, 10])
    expect(profiles).toHaveLength(60)
  })

  it('skips profiles the AppView could not return', async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: { profiles: [{ did: 'did:plc:aaa', handle: 'a.test' }, { displayName: 'broken' }] }
    }))
    const profiles = await fetchProfiles(['did:plc:aaa', 'did:plc:bbb'], { fetchImpl })
    expect(profiles.map((p) => p.handle)).toEqual(['a.test'])
  })
})

// ------------------------------------------------------------------- embeds
//
// The remaining embed shapes and their rejection paths: a bad embed must never
// cost us the post body.

describe('embed normalisation', () => {
  const base = {
    uri: URI,
    cid: 'bafy123',
    author: { did: 'did:plc:aaa', handle: 'status.test' },
    record: { $type: 'app.bsky.feed.post', text: 'Update', createdAt: '2026-09-05T00:00:00Z' },
    indexedAt: '2026-09-05T00:00:00Z'
  }

  const embedOf = (embed: unknown): unknown =>
    normalizePost({ ...base, embed: embed as Record<string, unknown> })?.embed

  it('normalises a quoted record', () => {
    expect(
      embedOf({
        $type: 'app.bsky.embed.record#view',
        record: {
          uri: 'at://did:plc:quoted/app.bsky.feed.post/abc',
          author: { did: 'did:plc:quoted', handle: 'someone.bsky.social' },
          value: { $type: 'app.bsky.feed.post', text: 'The upstream report' }
        }
      })
    ).toEqual({
      kind: 'record',
      uri: 'at://did:plc:quoted/app.bsky.feed.post/abc',
      author: 'someone.bsky.social',
      text: 'The upstream report'
    })
  })

  it('labels a quoted record with an unknown author', () => {
    expect(
      embedOf({
        $type: 'app.bsky.embed.record#view',
        record: { uri: 'at://x/app.bsky.feed.post/y' }
      })
    ).toMatchObject({ author: 'unknown', text: '' })
  })

  it('drops a quoted record with no uri, such as a blocked or deleted post', () => {
    expect(embedOf({ $type: 'app.bsky.embed.record#view', record: {} })).toBeNull()
    expect(embedOf({ $type: 'app.bsky.embed.record#view' })).toBeNull()
  })

  it('drops an external embed with no uri', () => {
    expect(embedOf({ $type: 'app.bsky.embed.external#view', external: {} })).toBeNull()
    expect(embedOf({ $type: 'app.bsky.embed.external#view' })).toBeNull()
  })

  it('falls back to the uri as the title, and an empty description', () => {
    expect(
      embedOf({
        $type: 'app.bsky.embed.external#view',
        external: { uri: 'https://status.bsky.app' }
      })
    ).toEqual({
      kind: 'external',
      uri: 'https://status.bsky.app',
      title: 'https://status.bsky.app',
      description: '',
      thumb: null
    })
  })

  it('keeps only images that have both a thumb and a fullsize', () => {
    expect(
      embedOf({
        $type: 'app.bsky.embed.images#view',
        images: [
          { thumb: 't.jpg', fullsize: 'f.jpg' },
          { thumb: 'only-thumb.jpg' },
          { fullsize: 'only-full.jpg' }
        ]
      })
    ).toEqual({ kind: 'images', images: [{ thumb: 't.jpg', fullsize: 'f.jpg', alt: '' }] })
  })

  it('drops an images embed with nothing renderable in it', () => {
    expect(embedOf({ $type: 'app.bsky.embed.images#view', images: [] })).toBeNull()
    expect(embedOf({ $type: 'app.bsky.embed.images#view' })).toBeNull()
  })

  it('drops a recordWithMedia whose media half is unrenderable', () => {
    expect(embedOf({ $type: 'app.bsky.embed.recordWithMedia#view' })).toBeNull()
  })

  it('ignores an embed with no $type', () => {
    expect(embedOf({ external: { uri: 'https://x.test' } })).toBeNull()
    expect(embedOf(undefined)).toBeNull()
  })
})

describe('timestamp fallbacks', () => {
  const base = {
    uri: URI,
    cid: 'bafy123',
    author: { did: 'did:plc:aaa', handle: 'status.test' },
    indexedAt: '2026-09-05T00:00:00.000Z'
  }

  it('falls back to the index time when the record has no createdAt', () => {
    const post = normalizePost({
      ...base,
      record: { $type: 'app.bsky.feed.post', text: 'Update' }
    })
    expect(post?.createdAt).toBe('2026-09-05T00:00:00.000Z')
  })

  it('falls back to the epoch when there is no timestamp at all', () => {
    const post = normalizePost({
      uri: URI,
      cid: 'bafy123',
      author: { did: 'did:plc:aaa', handle: 'status.test' },
      record: { $type: 'app.bsky.feed.post', text: 'Update' }
    })
    expect(post?.createdAt).toBe(new Date(0).toISOString())
    expect(post?.indexedAt).toBe(new Date(0).toISOString())
  })

  it('defaults engagement counters to zero', () => {
    const post = normalizePost({ ...base, record: { $type: 'app.bsky.feed.post', text: 'x' } })
    expect(post).toMatchObject({ replyCount: 0, repostCount: 0, likeCount: 0 })
  })

  it('treats an empty display name as absent', () => {
    const post = normalizePost({
      ...base,
      author: { did: 'did:plc:aaa', handle: 'status.test', displayName: '' },
      record: { $type: 'app.bsky.feed.post', text: 'x' }
    })
    expect(post?.authorDisplayName).toBe('status.test')
  })
})

describe('the XRPC layer', () => {
  it('targets a custom service when one is given', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: { feed: [] } }))
    await fetchAuthorPosts('did:plc:aaa', 10, {
      fetchImpl,
      service: 'https://appview.example.test'
    })
    expect(calls[0]!.url.origin).toBe('https://appview.example.test')
  })

  it('falls back to the status text when the error body is not JSON', async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        }
      }) as unknown as Response) as unknown as typeof fetch

    await expect(fetchAuthorPosts('did:plc:aaa', 10, { fetchImpl })).rejects.toThrow('Bad Gateway')
  })

  it('falls back to the status code when there is no message at all', async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 503,
        statusText: '',
        json: async () => ({})
      }) as unknown as Response) as unknown as typeof fetch

    await expect(fetchAuthorPosts('did:plc:aaa', 10, { fetchImpl })).rejects.toThrow(
      'Request failed with 503'
    )
  })

  it('carries the HTTP status on the error', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 429, body: { message: 'Rate limited' } }))
    await expect(fetchAuthorPosts('did:plc:aaa', 10, { fetchImpl })).rejects.toMatchObject({
      name: 'BskyError',
      status: 429
    })
  })

  it('describes a transport rejection that is not an Error', async () => {
    const fetchImpl = (() => Promise.reject('socket hang up')) as unknown as typeof fetch
    await expect(fetchAuthorPosts('did:plc:aaa', 10, { fetchImpl })).rejects.toThrow(
      'Network request failed: socket hang up'
    )
  })

  it('keeps the original rejection as the cause', async () => {
    const cause = { code: 'ECONNRESET' }
    const fetchImpl = (() => Promise.reject(cause)) as unknown as typeof fetch
    await expect(fetchAuthorPosts('did:plc:aaa', 10, { fetchImpl })).rejects.toMatchObject({
      name: 'BskyError',
      cause
    })
  })

  it('reads the message off a transport rejection that is an Error', async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch
    await expect(fetchAuthorPosts('did:plc:aaa', 10, { fetchImpl })).rejects.toThrow(
      'Network request failed: fetch failed'
    )
  })

  it('repeats an array parameter rather than joining it', async () => {
    const { fetchImpl, calls } = stubFetch((url) => ({
      body: { profiles: url.searchParams.getAll('actors').map((did) => ({ did, handle: 'h' })) }
    }))
    await fetchProfiles(['did:plc:a', 'did:plc:b'], { fetchImpl })
    expect(calls[0]!.url.searchParams.getAll('actors')).toEqual(['did:plc:a', 'did:plc:b'])
  })
})

describe('sparse records', () => {
  it('treats a record with no text as an empty update', () => {
    const post = normalizePost({
      uri: URI,
      cid: 'bafy123',
      author: { did: 'did:plc:aaa', handle: 'status.test' },
      record: { $type: 'app.bsky.feed.post', createdAt: '2026-09-05T00:00:00Z' },
      indexedAt: '2026-09-05T00:00:00Z'
    })

    expect(post?.text).toBe('')
    expect(post?.segments).toEqual([])
    expect(post?.severity).toBe('update')
  })

  it('tolerates a getProfiles response with no profiles key', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: {} }))
    await expect(fetchProfiles(['did:plc:aaa'], { fetchImpl })).resolves.toEqual([])
  })
})
