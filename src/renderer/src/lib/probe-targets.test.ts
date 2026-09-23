import { describe, expect, it } from 'vitest'
import { DEFAULT_PROBE_TARGETS, type ProbeTargets } from '@shared/probe-targets'
import {
  compareProbeTargets,
  issuesByPath,
  pathKey,
  readProbeTargets,
  sectionOf,
  SECTIONS
} from './probe-targets'

const copy = (): ProbeTargets => structuredClone(DEFAULT_PROBE_TARGETS)

/** The one line `compareProbeTargets` has to say about a section. */
function changeOf(before: ProbeTargets, after: ProbeTargets, key: string): string | null {
  return compareProbeTargets(before, after).find((section) => section.key === key)!.change
}

describe('paths', () => {
  it('joins keys and indices into one string', () => {
    expect(pathKey(['feeds', 0, 'host'])).toBe('feeds.0.host')
    expect(pathKey([])).toBe('')
  })

  it('finds the section a path is in, with the two apps apart', () => {
    expect(sectionOf(['accounts', 2, 'did'])).toBe('accounts')
    expect(sectionOf(['cdnImages'])).toBe('cdnImages')
    expect(sectionOf(['apps', 'leaflet', 'feed', 'rkey'])).toBe('leaflet')
    expect(sectionOf(['apps', 'offprint', 'publication'])).toBe('offprint')
  })

  it('has no section for the document itself, or for a key it does not know', () => {
    expect(sectionOf([])).toBeNull()
    expect(sectionOf(['apps'])).toBeNull()
    expect(sectionOf(['elsewhere'])).toBeNull()
  })

  it('keeps the first issue at each path', () => {
    const map = issuesByPath([
      { path: ['feeds', 0, 'host'], message: 'first' },
      { path: ['feeds', 0, 'host'], message: 'second' },
      { path: ['accounts'], message: 'list' }
    ])
    expect(map.get('feeds.0.host')).toBe('first')
    expect(map.get('accounts')).toBe('list')
    expect(map.size).toBe(2)
  })

  it('names every section once, in drawing order', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual([
      'accounts',
      'feeds',
      'forYou',
      'cdnImages',
      'tangled',
      'leaflet',
      'offprint'
    ])
  })
})

describe('reading a document', () => {
  it('accepts an exported document, normalised', () => {
    const doc = copy()
    doc.feeds[0]!.host = '  Discover.BSKY.app '
    const result = readProbeTargets(JSON.stringify(doc, null, 2))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.targets.feeds[0]!.host).toBe('discover.bsky.app')
  })

  // Some editors write one, and JSON.parse refuses it.
  it('ignores a byte-order mark', () => {
    expect(readProbeTargets(`\uFEFF${JSON.stringify(copy())}`).ok).toBe(true)
  })

  it('says when there is nothing to read', () => {
    expect(readProbeTargets('  \n ')).toEqual({ ok: false, problems: ['There is nothing in it.'] })
  })

  it('says when it is not JSON at all', () => {
    const result = readProbeTargets('{ accounts: [')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]).toMatch(/^It is not JSON\. /)
  })

  it('lists every problem with a document, field by field', () => {
    const doc = copy() as unknown as Record<string, unknown>
    ;(doc.accounts as { did: string }[])[1]!.did = 'not a did'
    delete doc.tangled
    const result = readProbeTargets(JSON.stringify(doc))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problems).toContainEqual(expect.stringMatching(/^accounts\[1\]\.did: /))
      expect(result.problems).toContainEqual(expect.stringMatching(/^tangled: /))
    }
  })

  it('refuses a document that is JSON but not an object', () => {
    expect(readProbeTargets('[1, 2, 3]').ok).toBe(false)
  })
})

describe('comparing two documents', () => {
  it('reports nothing between a document and itself', () => {
    const changes = compareProbeTargets(DEFAULT_PROBE_TARGETS, copy())
    expect(changes.every((section) => section.change === null)).toBe(true)
    expect(changes.map((section) => section.label)).toEqual(SECTIONS.map((s) => s.label))
  })

  it('counts accounts added and removed, by DID, and the new total', () => {
    const after = copy()
    after.accounts.splice(0, 2)
    after.accounts.push({ did: 'did:plc:new', handle: 'new.example.com' })

    expect(changeOf(DEFAULT_PROBE_TARGETS, after, 'accounts')).toBe('1 added, 2 removed, now 5')
  })

  it('calls an account whose handle changed changed, not removed and added', () => {
    const after = copy()
    after.accounts[0]!.handle = 'renamed.example.com'

    expect(changeOf(DEFAULT_PROBE_TARGETS, after, 'accounts')).toBe('1 changed')
  })

  it('says so when only the order moved', () => {
    const after = copy()
    after.accounts.reverse()

    expect(changeOf(DEFAULT_PROBE_TARGETS, after, 'accounts')).toBe('reordered')
  })

  it('matches feeds by host', () => {
    const after = copy()
    after.feeds[0]!.label = 'Renamed'
    after.feeds.push({
      label: 'Another',
      host: 'feed.example.com',
      uri: 'at://did:plc:abc/app.bsky.feed.generator/x'
    })

    expect(changeOf(DEFAULT_PROBE_TARGETS, after, 'feeds')).toBe('1 added, 1 changed, now 2')
  })

  it('matches images by the whole entry, duplicates included', () => {
    const before = copy()
    const after = copy()
    after.cdnImages.push(structuredClone(after.cdnImages[0]!))

    expect(changeOf(before, after, 'cdnImages')).toBe('1 added, now 4')
    expect(changeOf(after, before, 'cdnImages')).toBe('1 removed, now 3')
  })

  it('says a single target changed without counting', () => {
    const after = copy()
    after.tangled.repoPath = '/someone.example.com/repo'
    after.apps.offprint.publication = 'at://did:plc:abc/site.standard.publication/3mcqqd47cw22k'

    const changes = compareProbeTargets(DEFAULT_PROBE_TARGETS, after)
    expect(changes.filter((section) => section.change).map((s) => [s.key, s.change])).toEqual([
      ['tangled', 'changed'],
      ['offprint', 'changed']
    ])
  })

  // Documents from different places need not list their keys in the same order.
  it('compares by content, not by key order', () => {
    const after = copy()
    after.forYou = { feed: after.forYou.feed, did: after.forYou.did }
    after.apps.leaflet.publication = {
      rkey: after.apps.leaflet.publication.rkey,
      did: after.apps.leaflet.publication.did
    }

    expect(compareProbeTargets(DEFAULT_PROBE_TARGETS, after).every((s) => !s.change)).toBe(true)
  })
})
