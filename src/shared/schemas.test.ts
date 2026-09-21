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

  it('accepts an empty patch, which is what an untouched form sends', () => {
    expect(accountPatchSchema.safeParse({}).success).toBe(true)
    expect(settingsPatchSchema.safeParse({}).success).toBe(true)
  })

  it.each([null, undefined, 42, 'a string', []])('rejects %s as an app state', (value) => {
    expect(appStateSchema.safeParse(value).success).toBe(false)
  })
})
