import { describe, expect, it } from 'vitest'
import {
  accountPatchSchema,
  accountSchema,
  appStateSchema,
  postEmbedSchema,
  resolvedProfileSchema,
  richSegmentSchema,
  settingsPatchSchema,
  statusPostSchema
} from './schemas'
import { makeAccount, makePost, makeProfile, makeState } from '../test/factories'
import { DEFAULT_PROBE_TARGETS } from './probe-targets'

/**
 * These schemas are what the generated IPC wiring runs on every argument and every
 * return value, so "does a real payload pass" and "does a wrong one fail" is the
 * difference between validation and decoration.
 */
describe('round-tripping real payloads', () => {
  it.each([
    ['an account', accountSchema, makeAccount()],
    ['a post', statusPostSchema, makePost()],
    ['a profile', resolvedProfileSchema, makeProfile()],
    ['a whole app state', appStateSchema, makeState({ accounts: [makeAccount()] })]
  ])('accepts %s', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true)
  })

  it('accepts a state carrying posts, segments and embeds', () => {
    const post = makePost({
      segments: [
        { kind: 'text', text: 'See ' },
        { kind: 'link', text: 'the status page', uri: 'https://status.example.test' },
        { kind: 'mention', text: '@bsky', did: 'did:plc:x' },
        { kind: 'tag', text: '#outage', tag: 'outage' }
      ],
      embed: {
        kind: 'images',
        images: [{ thumb: 'https://t', fullsize: 'https://f', alt: 'graph' }]
      }
    })
    expect(appStateSchema.safeParse(makeState({ posts: [post] })).success).toBe(true)
  })
})

describe('rejecting what should never cross', () => {
  it('rejects an account missing a required field', () => {
    const { handle: _handle, ...rest } = makeAccount()
    expect(accountSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects a null where only a string belongs', () => {
    expect(accountSchema.safeParse({ ...makeAccount(), did: null }).success).toBe(false)
  })

  it('rejects an unknown severity', () => {
    expect(statusPostSchema.safeParse({ ...makePost(), severity: 'catastrophe' }).success).toBe(
      false
    )
  })

  it('rejects an unknown theme in a settings patch', () => {
    expect(settingsPatchSchema.safeParse({ theme: 'neon' }).success).toBe(false)
  })

  it('rejects a rich segment whose kind does not match its payload', () => {
    expect(richSegmentSchema.safeParse({ kind: 'link', text: 'x' }).success).toBe(false)
    expect(richSegmentSchema.safeParse({ kind: 'nope', text: 'x' }).success).toBe(false)
  })

  it('rejects an embed variant that is not one of the three', () => {
    expect(postEmbedSchema.safeParse({ kind: 'video', uri: 'https://v' }).success).toBe(false)
  })

  it('rejects a non-boolean in an account patch', () => {
    expect(accountPatchSchema.safeParse({ muted: 'yes' }).success).toBe(false)
  })

  /** Schema 5's on/off switch is a level now; a renderer still sending the old one is stale. */
  it('takes a notification level for an account, not the switch it replaced', () => {
    expect(accountPatchSchema.safeParse({ notify: 'outages' }).success).toBe(true)
    expect(accountPatchSchema.safeParse({ notify: true }).success).toBe(false)
    expect(accountPatchSchema.safeParse({ notify: 'loud' }).success).toBe(false)
  })

  /** A time the main process cannot read would make the quiet-hours window unknowable. */
  it('takes quiet hours only as a 24-hour HH:MM', () => {
    expect(settingsPatchSchema.safeParse({ quietHoursStart: '23:59' }).success).toBe(true)
    for (const time of ['8:00', '24:00', '12:60', '10pm', '']) {
      expect(settingsPatchSchema.safeParse({ quietHoursEnd: time }).success).toBe(false)
    }
  })

  it('accepts an empty patch, which is what an untouched form sends', () => {
    expect(accountPatchSchema.safeParse({}).success).toBe(true)
    expect(settingsPatchSchema.safeParse({}).success).toBe(true)
  })

  /**
   * Main is handed the patch as it arrived rather than the parsed copy, so a key Zod would
   * only strip would still be spread over the stored account or settings.
   */
  it('rejects a patch naming a field the renderer may not change', () => {
    expect(accountPatchSchema.safeParse({ muted: true, builtin: false }).success).toBe(false)
    expect(accountPatchSchema.safeParse({ did: 'did:plc:someone-else' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ theme: 'dark', schemaVersion: 1 }).success).toBe(false)
  })

  /** Spread over what main has stored, a present-but-undefined field erases it. */
  it('rejects a patch that sends a field as undefined rather than leaving it out', () => {
    expect(accountPatchSchema.safeParse({ muted: undefined }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ theme: undefined }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ probeTargets: undefined }).success).toBe(false)
  })

  it('still takes every setting on its own', () => {
    const settings = makeState().settings
    for (const [key, value] of Object.entries(settings)) {
      expect(settingsPatchSchema.safeParse({ [key]: value }).success, key).toBe(true)
    }
  })

  it.each([null, undefined, 42, 'a string', []])('rejects %s as an app state', (value) => {
    expect(appStateSchema.safeParse(value).success).toBe(false)
  })
})

describe('the probe targets override in the settings', () => {
  const override = {
    ...structuredClone(DEFAULT_PROBE_TARGETS),
    accounts: [{ did: 'did:plc:someone', handle: 'someone.test' }]
  }

  it('crosses with the rest of the state, whether it is set or not', () => {
    expect(appStateSchema.safeParse(makeState()).success).toBe(true)
    const settings = { ...makeState().settings, probeTargets: override }
    expect(appStateSchema.safeParse(makeState({ settings })).success).toBe(true)
  })

  it('stops the whole state crossing when it is broken, which is why main never stores one', () => {
    const settings = { ...makeState().settings, probeTargets: { ...override, accounts: [] } }
    expect(appStateSchema.safeParse(makeState({ settings })).success).toBe(false)
  })
})
