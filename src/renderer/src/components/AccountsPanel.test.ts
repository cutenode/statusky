import { describe, expect, it } from 'vitest'
import { makeAccount } from '../../../test/factories'
import { pushState, renderWith } from '../test/render'
import AccountsPanel from './AccountsPanel.svelte'

const a = makeAccount({ did: 'did:plc:a', handle: 'a.test', displayName: 'Alpha' })
const b = makeAccount({ did: 'did:plc:b', handle: 'b.test', displayName: 'Beta' })

describe('AccountsPanel', () => {
  it('offers the add form and lists every tracked account', async () => {
    const { getByPlaceholderText, getByText } = await renderWith(
      AccountsPanel,
      {},
      { accounts: [a, b] }
    )

    expect(getByPlaceholderText('handle, DID, or bsky.app profile link')).toBeTruthy()
    expect(getByText('Alpha')).toBeTruthy()
    expect(getByText('Beta')).toBeTruthy()
  })

  it('counts the accounts it is tracking', async () => {
    const { getByText } = await renderWith(AccountsPanel, {}, { accounts: [a, b] })
    expect(getByText('Tracking 2')).toBeTruthy()
  })

  it('counts how many are actually notifying', async () => {
    // Any level short of off still puts banners up; muting takes an account out entirely.
    const outagesOnly = makeAccount({ did: 'did:plc:d', notify: 'outages' })
    const silent = { ...b, notify: 'off' as const }
    const muted = makeAccount({ did: 'did:plc:c', muted: true })
    const { getByText } = await renderWith(
      AccountsPanel,
      {},
      { accounts: [a, outagesOnly, silent, muted] }
    )

    expect(getByText('2 notifying')).toBeTruthy()
  })

  it('lists muted accounts too, so they can be un-muted', async () => {
    const { getByText } = await renderWith(AccountsPanel, {}, { accounts: [{ ...a, muted: true }] })
    expect(getByText('Alpha')).toBeTruthy()
  })

  it('updates when an account is added', async () => {
    const { bridge, queryByText, getByText } = await renderWith(
      AccountsPanel,
      {},
      { accounts: [a] }
    )
    expect(queryByText('Beta')).toBeNull()

    await pushState(bridge, { accounts: [a, b] })

    expect(getByText('Beta')).toBeTruthy()
    expect(getByText('Tracking 2')).toBeTruthy()
  })

  it('copes with tracking nothing at all', async () => {
    const { getByText } = await renderWith(AccountsPanel, {}, { accounts: [] })
    expect(getByText('Tracking 0')).toBeTruthy()
    expect(getByText('0 notifying')).toBeTruthy()
  })
})
