/**
 * The preview's fixtures, held to the same schemas the IPC boundary runs.
 *
 * `preview.html` hands them straight to the renderer, with none of the store's
 * migrations in between, so a field the schema has since added or changed shows up in
 * the preview as a value the real app can never hold — and nothing else would say so.
 * `npm run fixture` writes fresh ones; hand edits have to keep up with the schema.
 */
import { describe, expect, it } from 'vitest'
import { appStateSchema, networkSnapshotSchema } from '../shared/schemas'
import state from '../renderer/fixtures/state.json'
import network from '../renderer/fixtures/network.json'

/** Every issue as `path: message`, so a failure names the fields to fix. */
function issues(result: {
  success: boolean
  error?: { issues: { path: PropertyKey[]; message: string }[] }
}): string[] {
  return (result.error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`)
}

describe('the preview fixtures', () => {
  it('are a state the app could actually be in', () => {
    expect(issues(appStateSchema.safeParse(state))).toEqual([])
  })

  it('are a dashboard the checks could actually have produced', () => {
    expect(issues(networkSnapshotSchema.safeParse(network))).toEqual([])
  })
})
