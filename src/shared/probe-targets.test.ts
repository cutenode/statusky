import { afterEach, describe, expect, it, vi } from 'vitest'
import raw from './probeTargets.json'
import {
  DEFAULT_PROBE_TARGETS,
  PROBE_TARGET_LIMITS,
  describeProbeTargetIssues,
  effectiveProbeTargets,
  sameProbeTargets,
  sanitizeProbeTargets,
  validateProbeTargets
} from './probe-targets'
import { settingsPatchSchema } from './schemas'
import type { ProbeTargets } from './types'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A fresh, editable copy of the defaults with some part replaced. */
function edited(changes: Partial<ProbeTargets> = {}): ProbeTargets {
  return { ...structuredClone(DEFAULT_PROBE_TARGETS), ...changes }
}

/** The messages a document fails with, keyed by where. */
function problems(input: unknown): Record<string, string> {
  const result = validateProbeTargets(input)
  if (result.ok) return {}
  return Object.fromEntries(
    result.issues.map((issue) => [issue.path.join('.'), issue.message] as const)
  )
}

/** A deep copy with every object's keys in the opposite order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, inner]) => [key, reversed(inner)])
  )
}

describe('the checked-in targets', () => {
  it('validate, exactly as written', () => {
    expect(validateProbeTargets(raw)).toEqual({ ok: true, targets: raw })
    expect(DEFAULT_PROBE_TARGETS).toEqual(raw)
  })

  /**
   * Three lists became one. The defaults are every account those lists named, each with
   * the half it was missing looked up rather than guessed — bar the three bots, which
   * W Social's AppView will not index because `bsky.app` has not verified them. Busy
   * verified news accounts stand in for them.
   */
  it('list the old lists’ accounts once each, with the bots swapped out', () => {
    const kept = [
      'did:plc:ragtjsm2j2vknwkz3zp4oxrd',
      'did:plc:rnpkyqnmsw4ipey6eotbdnnf',
      'did:plc:hdhoaan3xa3jiuq4fg4mefid'
    ]
    const bots = [
      'did:plc:f4z2nftgrn75h7h3wucdyzaf',
      'did:plc:mrozf7u6e7kjpo7itbrudpc6',
      'did:plc:65r3dy2t6xfuwidxmzvctvsh'
    ]
    const standIns = ['reuters.com', 'theguardian.com', 'aljazeera.com']

    const { accounts } = DEFAULT_PROBE_TARGETS
    const dids = accounts.map((a) => a.did)
    for (const did of kept) expect(dids).toContain(did)
    for (const did of bots) expect(dids).not.toContain(did)
    expect(accounts.map((a) => a.handle)).toEqual(expect.arrayContaining(standIns))
    expect(accounts).toHaveLength(kept.length + standIns.length)
  })

  it('keep a feed per host, so every feed row has an id of its own', () => {
    const hosts = DEFAULT_PROBE_TARGETS.feeds.map((feed) => feed.host)
    expect(new Set(hosts).size).toBe(hosts.length)
  })

  it('are frozen, so nothing that falls back to them can change them for everyone', () => {
    expect(Object.isFrozen(DEFAULT_PROBE_TARGETS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_PROBE_TARGETS.accounts[0])).toBe(true)
    expect(() => {
      ;(DEFAULT_PROBE_TARGETS.accounts as unknown[]).push({})
    }).toThrow()
  })
})

describe('validateProbeTargets', () => {
  it('normalises what it accepts: trimmed, lower-cased handles and hosts, no strays', () => {
    const input = {
      ...edited(),
      accounts: [{ did: ' did:plc:someone ', handle: 'Someone.Example.COM' }],
      feeds: [
        {
          label: ' Cats ',
          host: 'Feeds.Example.Test',
          uri: 'at://did:plc:cats/app.bsky.feed.generator/cats'
        }
      ],
      $schema: 'https://example.test/schema.json'
    }
    const result = validateProbeTargets(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.targets.accounts).toEqual([
      { did: 'did:plc:someone', handle: 'someone.example.com' }
    ])
    expect(result.targets.feeds[0]).toMatchObject({ label: 'Cats', host: 'feeds.example.test' })
    expect(result.targets).not.toHaveProperty('$schema')
  })

  it.each([
    [{ accounts: [{ did: 'plc:nope', handle: 'a.test' }] }, 'accounts.0.did', /DID/],
    [{ accounts: [{ did: 'did:plc:a', handle: 'not a handle' }] }, 'accounts.0.handle', /domain/],
    [{ accounts: [] }, 'accounts', /at least one account/],
    [
      {
        feeds: [
          {
            label: 'Posts',
            host: 'feeds.example.test',
            uri: 'at://did:plc:cats/app.bsky.feed.post/3abc'
          }
        ]
      },
      'feeds.0.uri',
      /app\.bsky\.feed\.generator/
    ],
    [
      { feeds: [{ label: '  ', host: 'a.test', uri: 'at://did:plc:a/app.bsky.feed.generator/a' }] },
      'feeds.0.label',
      /label/
    ],
    [{ cdnImages: [] }, 'cdnImages', /at least one image/],
    [{ cdnImages: [{ did: 'did:plc:a', cid: 'not-a-cid' }] }, 'cdnImages.0.cid', /CID/]
  ])('explains what is wrong with %o, at %s', (changes, path, message) => {
    expect(problems(edited(changes as Partial<ProbeTargets>))[path]).toMatch(message)
  })

  it.each([
    ['a DID owner', '/did:plc:wshs7t2adsemcrrd4snkeqli/core'],
    ['an @ owner', '/@tangled.org/core'],
    ['a capitalised owner', '/Tangled.org/core'],
    ['no repository', '/tangled.org'],
    ['a query', '/tangled.org/core?tab=issues']
  ])('refuses a repository path with %s, which the page title would not match', (_n, path) => {
    const tangled = { ...DEFAULT_PROBE_TARGETS.tangled, repoPath: path }
    expect(problems(edited({ tangled }))['tangled.repoPath']).toMatch(/owner handle/)
  })

  it('wants a go-get path to actually ask for go-get', () => {
    const tangled = { ...DEFAULT_PROBE_TARGETS.tangled, goGetPath: '/core' }
    expect(problems(edited({ tangled }))['tangled.goGetPath']).toMatch(/go-get=1/)
    const extra = { ...DEFAULT_PROBE_TARGETS.tangled, goGetPath: '/core?x=1&go-get=1' }
    expect(validateProbeTargets(edited({ tangled: extra })).ok).toBe(true)
  })

  // Each of these resolves, against tangled.org, to a URL on the host it names instead.
  it.each([
    ['another host', '//127.0.0.1:631/x?go-get=1'],
    ['another host behind a backslash', '/\\evil.example/x?go-get=1'],
    ['a backslash anywhere', '/core\\x?go-get=1'],
    ['a backslash in the query', '/core?x=\\y&go-get=1']
  ])('refuses a go-get path that leads to %s', (_name, path) => {
    const tangled = { ...DEFAULT_PROBE_TARGETS.tangled, goGetPath: path }
    expect(problems(edited({ tangled }))['tangled.goGetPath']).toMatch(/go-get=1/)
  })

  it('wants a pckt publication to be a standard.site publication', () => {
    const apps = {
      ...DEFAULT_PROBE_TARGETS.apps,
      pckt: { publication: 'at://did:plc:a/app.bsky.feed.post/3abc' }
    }
    expect(problems(edited({ apps }))['apps.pckt.publication']).toMatch(
      /site\.standard\.publication/
    )
  })

  it('wants an Offprint publication to be a standard.site publication', () => {
    const apps = {
      ...DEFAULT_PROBE_TARGETS.apps,
      offprint: { publication: 'at://did:plc:a/app.bsky.feed.post/3abc' }
    }
    expect(problems(edited({ apps }))['apps.offprint.publication']).toMatch(
      /site\.standard\.publication/
    )
  })

  it('refuses a record key of . or ..', () => {
    const apps = structuredClone(DEFAULT_PROBE_TARGETS.apps)
    apps.leaflet.feed.rkey = '..'
    expect(problems(edited({ apps }))['apps.leaflet.feed.rkey']).toMatch(/record key/)
  })

  it('flags a repeated DID or handle at the entry that repeats it', () => {
    const accounts = [
      { did: 'did:plc:a', handle: 'a.test' },
      { did: 'did:plc:b', handle: 'a.test' },
      { did: 'did:plc:a', handle: 'c.test' }
    ]
    expect(problems(edited({ accounts }))).toEqual({
      'accounts.1.handle': 'Same handle as entry 1',
      'accounts.2.did': 'Same DID as entry 1'
    })
  })

  it('holds each feed to a host of its own, since a row is one host', () => {
    const feeds = [
      { label: 'One', host: 'feeds.test', uri: 'at://did:plc:a/app.bsky.feed.generator/one' },
      { label: 'Two', host: 'feeds.test', uri: 'at://did:plc:a/app.bsky.feed.generator/two' }
    ]
    expect(problems(edited({ feeds }))).toEqual({ 'feeds.1.host': 'Same host as entry 1' })
  })

  it('allows no feeds at all, which is no feed rows', () => {
    expect(validateProbeTargets(edited({ feeds: [] })).ok).toBe(true)
  })

  it('takes PDS hosts, trimmed and lower-cased, and flags a repeat where it repeats', () => {
    const result = validateProbeTargets(edited({ pdses: ['  PDS.Example.com ', 'other.test'] }))
    expect(result.ok && result.targets.pdses).toEqual(['pds.example.com', 'other.test'])
    expect(problems(edited({ pdses: ['pds.test', 'PDS.test'] }))).toEqual({
      'pdses.1': 'Same host as entry 1'
    })
    expect(problems(edited({ pdses: ['https://pds.test'] }))).toEqual({
      'pdses.0': 'Must be a domain name, such as example.com'
    })
  })

  // Saved and exported before the list existed, and still a perfectly good document.
  it('takes a document with no PDS list as one with an empty list', () => {
    const { pdses: _, ...older } = edited()
    const result = validateProbeTargets(older)
    expect(result.ok && result.targets.pdses).toEqual([])
  })

  // Saved and exported before pckt had a target, and so kept rather than dropped.
  it('takes a document with no pckt publication as one with the default', () => {
    const { pckt: _, ...apps } = structuredClone(DEFAULT_PROBE_TARGETS.apps)
    const result = validateProbeTargets({ ...edited(), apps })
    expect(result.ok && result.targets.apps.pckt).toEqual(DEFAULT_PROBE_TARGETS.apps.pckt)
  })

  it.each([
    ['accounts', (n: number) => ({ did: `did:plc:a${n}`, handle: `a${n}.test` })],
    [
      'feeds',
      (n: number) => ({
        label: `Feed ${n}`,
        host: `f${n}.test`,
        uri: `at://did:plc:a/app.bsky.feed.generator/f${n}`
      })
    ],
    ['pdses', (n: number) => `pds${n}.test`],
    ['cdnImages', (n: number) => ({ did: `did:plc:a${n}`, cid: `bafkrei${'a'.repeat(52)}` })]
  ] as const)('caps %s, since every one is traffic to somebody else', (key, make) => {
    const limit = PROBE_TARGET_LIMITS[key]
    const at = Array.from({ length: limit }, (_, n) => make(n))
    expect(validateProbeTargets(edited({ [key]: at })).ok).toBe(true)
    const over = Array.from({ length: limit + 1 }, (_, n) => make(n))
    expect(problems(edited({ [key]: over }))[key]).toMatch(`At most ${limit}`)
  })

  it.each([null, 42, 'targets', [], {}])('refuses %o as a document', (value) => {
    expect(validateProbeTargets(value).ok).toBe(false)
  })
})

describe('describeProbeTargetIssues', () => {
  it('writes each issue as a line a person can follow', () => {
    expect(
      describeProbeTargetIssues([
        { path: ['accounts', 2, 'did'], message: 'Must be a DID' },
        { path: ['feeds'], message: 'At most 10 feeds' },
        { path: [], message: 'Expected an object' }
      ])
    ).toEqual(['accounts[2].did: Must be a DID', 'feeds: At most 10 feeds', 'Expected an object'])
  })
})

describe('sameProbeTargets', () => {
  it('compares content, whatever order the keys were written in', () => {
    const reordered = reversed(DEFAULT_PROBE_TARGETS) as ProbeTargets
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(DEFAULT_PROBE_TARGETS))
    expect(sameProbeTargets(reordered, DEFAULT_PROBE_TARGETS)).toBe(true)
  })

  it('tells documents apart', () => {
    expect(sameProbeTargets(edited({ feeds: [] }), DEFAULT_PROBE_TARGETS)).toBe(false)
  })

  it('counts null as the same only as null', () => {
    expect(sameProbeTargets(null, null)).toBe(true)
    expect(sameProbeTargets(null, undefined)).toBe(true)
    expect(sameProbeTargets(null, DEFAULT_PROBE_TARGETS)).toBe(false)
    expect(sameProbeTargets(DEFAULT_PROBE_TARGETS, null)).toBe(false)
  })
})

describe('sanitizeProbeTargets', () => {
  it('keeps no override as none', () => {
    expect(sanitizeProbeTargets(null)).toBeNull()
    expect(sanitizeProbeTargets(undefined)).toBeNull()
  })

  it('keeps a real override, normalised', () => {
    const accounts = [{ did: 'did:plc:someone', handle: 'Someone.Test' }]
    expect(sanitizeProbeTargets(edited({ accounts }))?.accounts).toEqual([
      { did: 'did:plc:someone', handle: 'someone.test' }
    ])
  })

  /**
   * Somebody opened the editor, changed nothing and saved. They should go on following
   * the defaults when a release changes them, not be pinned to these ones.
   */
  it('stores an override identical to the defaults as none at all', () => {
    expect(sanitizeProbeTargets(edited())).toBeNull()
  })

  it('drops an invalid override with a warning that says what was wrong', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(sanitizeProbeTargets({ accounts: 'nope' })).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toMatch(/checked-in defaults[\s\S]*accounts/)
  })
})

describe('effectiveProbeTargets', () => {
  it('is the defaults when there is no override', () => {
    expect(effectiveProbeTargets(null)).toBe(DEFAULT_PROBE_TARGETS)
    expect(effectiveProbeTargets(undefined)).toBe(DEFAULT_PROBE_TARGETS)
  })

  it('is the override when there is one', () => {
    const override = edited({ feeds: [] })
    expect(effectiveProbeTargets(override)).toEqual(override)
  })

  it('falls back to the defaults, with a warning, for an override that is not valid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { ...edited(), accounts: [{ did: 'nope', handle: 'nope' }] }
    expect(effectiveProbeTargets(broken)).toBe(DEFAULT_PROBE_TARGETS)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toMatch(/accounts\[0\]\.did: Must be a DID/)
  })
})

describe('the IPC boundary', () => {
  it('lets an override, and a reset to none, through a settings patch', () => {
    expect(settingsPatchSchema.safeParse({ probeTargets: edited({ feeds: [] }) }).success).toBe(
      true
    )
    expect(settingsPatchSchema.safeParse({ probeTargets: null }).success).toBe(true)
  })

  it('stops an invalid one before it reaches main', () => {
    expect(settingsPatchSchema.safeParse({ probeTargets: edited({ accounts: [] }) }).success).toBe(
      false
    )
    expect(settingsPatchSchema.safeParse({ probeTargets: {} }).success).toBe(false)
  })
})
