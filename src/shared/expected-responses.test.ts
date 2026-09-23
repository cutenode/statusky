import { describe, expect, it } from 'vitest'
import raw from './expectedResponses.json'
import { EXPECTED_RESPONSES, expectedResponsesSchema } from './expected-responses'

describe('expectedResponses.json', () => {
  it('validates, exactly as written', () => {
    expect(expectedResponsesSchema.safeParse(raw).success).toBe(true)
    expect(EXPECTED_RESPONSES).toEqual(raw)
  })

  /**
   * The literals the checks used to carry in their own source. Written out again here on
   * purpose: the file is the source of truth, and this is what notices it being changed
   * by accident rather than because a service changed what it says.
   */
  it('holds each service to the words it actually uses', () => {
    expect(EXPECTED_RESPONSES).toMatchObject({
      relay: { healthStatus: 'ok' },
      firehose: { eventOp: 1, errorOp: -1, commitType: '#commit' },
      jetstream: { greeting: 'Welcome to Jetstream', commitKind: 'commit' },
      spacedust: { source: 'app.bsky.feed.like:subject.uri', linkKind: 'link', liveOrigin: 'live' },
      appView: { versionlessHealth: ['api.blacksky.community', 'appview.wsocial.eu'] },
      dns: { noError: 0 },
      ufos: { statsCollection: 'app.bsky.feed.post' },
      slingshot: { profileType: 'app.bsky.actor.profile' },
      forYou: {
        siteMarker: '<link rel="canonical" href="https://foryou.club/">',
        busy: 'server busy',
        generatorServiceType: 'BskyFeedGenerator'
      },
      tangled: { goImportMarker: 'go-import', notFoundTitle: '404' },
      hydrant: { name: 'hydrant', mode: 'indexer' },
      knot: { healthCapability: 'repo-did-input' },
      spindle: { healthStatus: 'ok' },
      pckt: { status: 'ok' },
      standardSite: { publicationCollection: 'site.standard.publication' },
      offprint: { upMarker: 'Application up' }
    })
  })

  it.each([
    ['an empty string', { ...raw, relay: { healthStatus: '' } }],
    ['a missing section', { ...raw, hydrant: undefined }],
    ['a string where a number belongs', { ...raw, dns: { noError: '0' } }],
    ['a fractional frame op', { ...raw, firehose: { ...raw.firehose, eventOp: 1.5 } }]
  ])('refuses %s', (_name, value) => {
    expect(expectedResponsesSchema.safeParse(value).success).toBe(false)
  })
})
