import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import { HEALTH_LABEL } from '@shared/status'
import { nav } from '$lib/nav.svelte'
import { probeAccount } from '@shared/network'
import { makeAccount, makeNetworkSummary, makePost } from '../../../test/factories'
import { NOTIFY_LEVEL_CHOICES } from '@shared/notify'
import { chooseOption, openSelect, renderWith, settle } from '../test/render'
import AccountRow from './AccountRow.svelte'

const account = makeAccount({
  did: 'did:plc:a',
  handle: 'status.bsky.app',
  displayName: 'Bluesky Status'
})

describe('the account summary', () => {
  it('shows the display name and handle', async () => {
    const { getByText } = await renderWith(AccountRow, { account }, { accounts: [account] })

    expect(getByText('Bluesky Status')).toBeTruthy()
    expect(getByText('@status.bsky.app')).toBeTruthy()
  })

  it('shows the account health', async () => {
    const { getByText } = await renderWith(
      AccountRow,
      { account },
      {
        accounts: [account],
        posts: [makePost({ authorDid: account.did, severity: 'outage' })]
      }
    )

    expect(getByText(HEALTH_LABEL.incident)).toBeTruthy()
  })

  it('reports unknown health for an account with no posts', async () => {
    const { getByText } = await renderWith(AccountRow, { account }, { accounts: [account] })
    expect(getByText(HEALTH_LABEL.unknown)).toBeTruthy()
  })

  it('badges its unread count', async () => {
    const post = makePost({ authorDid: account.did })
    const { getByText } = await renderWith(
      AccountRow,
      { account },
      { accounts: [account], posts: [post], unread: [post.uri] }
    )

    expect(getByText('1')).toBeTruthy()
  })

  it('falls back to initials when there is no avatar', async () => {
    const { getByText } = await renderWith(AccountRow, { account }, { accounts: [account] })
    expect(getByText('BS')).toBeTruthy()
  })

  it('uses the handle for initials when the display name is empty', async () => {
    const nameless = { ...account, displayName: '' }
    const { getByText } = await renderWith(
      AccountRow,
      { account: nameless },
      { accounts: [nameless] }
    )
    expect(getByText('ST')).toBeTruthy()
  })

  it('renders the avatar image when the account has one', async () => {
    const withAvatar = { ...account, avatar: 'https://cdn.bsky.app/avatar.jpg' }
    const { container } = await renderWith(
      AccountRow,
      { account: withAvatar },
      { accounts: [withAvatar] }
    )

    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://cdn.bsky.app/avatar.jpg')
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('opens the profile on Bluesky', async () => {
    const { bridge, getByTitle } = await renderWith(
      AccountRow,
      { account },
      { accounts: [account] }
    )

    await fireEvent.click(getByTitle('Open profile on Bluesky'))

    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(
      'https://bsky.app/profile/status.bsky.app'
    )
  })
})

describe('a muted account', () => {
  const muted = { ...account, muted: true }

  it('dims the row and hides its health and unread badge', async () => {
    const post = makePost({ authorDid: muted.did })
    const { container, queryByText } = await renderWith(
      AccountRow,
      { account: muted },
      { accounts: [muted], posts: [post], unread: [post.uri] }
    )

    expect(container.firstElementChild?.className).toContain('opacity-55')
    expect(queryByText(HEALTH_LABEL.unknown)).toBeNull()
    expect(queryByText('1')).toBeNull()
  })

  it('offers to show it again', async () => {
    const { bridge, getByLabelText } = await renderWith(
      AccountRow,
      { account: muted },
      { accounts: [muted] }
    )

    await fireEvent.click(getByLabelText('Show in feed'))

    expect(bridge.api.Accounts.patch).toHaveBeenCalledWith(muted.did, { muted: false })
  })
})

describe('the controls', () => {
  it('hides the account from the feed', async () => {
    const { bridge, getByLabelText } = await renderWith(
      AccountRow,
      { account },
      { accounts: [account] }
    )

    await fireEvent.click(getByLabelText('Hide from feed'))

    expect(bridge.api.Accounts.patch).toHaveBeenCalledWith(account.did, { muted: true })
  })

  it('sets how much of the account is worth a banner', async () => {
    const { bridge, getByLabelText } = await renderWith(
      AccountRow,
      { account },
      { accounts: [account] }
    )

    await chooseOption(getByLabelText('Notifications for @status.bsky.app'), 'Outages only')

    expect(bridge.api.Accounts.patch).toHaveBeenCalledWith(account.did, { notify: 'outages' })
  })

  it('offers every level', async () => {
    const { getByLabelText } = await renderWith(AccountRow, { account }, { accounts: [account] })

    const listbox = await openSelect(getByLabelText('Notifications for @status.bsky.app'))
    const options = [...listbox.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim()
    )

    expect(options).toEqual(NOTIFY_LEVEL_CHOICES.map((choice) => choice.label))
  })

  it.each([
    ['default', 'Default'],
    ['all', 'All'],
    ['outages', 'Outages'],
    ['off', 'Off']
  ] as const)(
    'names the %s level on the control, and explains it on hover',
    async (notify, label) => {
      const subject = { ...account, notify }
      const { getByLabelText } = await renderWith(
        AccountRow,
        { account: subject },
        { accounts: [subject] }
      )

      const control = getByLabelText('Notifications for @status.bsky.app')
      expect(control.textContent).toContain(label)
      expect(control.getAttribute('title')).toBe(
        NOTIFY_LEVEL_CHOICES.find((choice) => choice.value === notify)!.hint
      )
    }
  )

  it('crosses the bell out only when banners are off', async () => {
    const silent = { ...account, notify: 'off' as const }
    const off = await renderWith(AccountRow, { account: silent }, { accounts: [silent] })
    const control = off.getByLabelText('Notifications for @status.bsky.app')
    expect(control.querySelector('svg.lucide-bell-off')).not.toBeNull()
    off.unmount()

    const outages = { ...account, notify: 'outages' as const }
    const { getByLabelText } = await renderWith(
      AccountRow,
      { account: outages },
      { accounts: [outages] }
    )
    const lit = getByLabelText('Notifications for @status.bsky.app')
    expect(lit.querySelector('svg.lucide-bell-off')).toBeNull()
    expect(lit.querySelector('svg.lucide-bell')).not.toBeNull()
  })

  it('offers to stop tracking a user-added account', async () => {
    const { bridge, getByLabelText } = await renderWith(
      AccountRow,
      { account },
      { accounts: [account] }
    )

    await fireEvent.click(getByLabelText('Stop tracking'))

    expect(bridge.api.Accounts.remove).toHaveBeenCalledWith(account.did)
  })

  it('offers no delete control for a builtin account', async () => {
    const builtin = { ...account, builtin: true }
    const { queryByLabelText } = await renderWith(
      AccountRow,
      { account: builtin },
      { accounts: [builtin] }
    )

    expect(queryByLabelText('Stop tracking')).toBeNull()
    // ...but it can still be hidden.
    expect(queryByLabelText('Hide from feed')).not.toBeNull()
  })
})

/**
 * What used to land under the add field at the top of the tab, a long way from the row
 * that asked — and stay there until something else ran.
 */
describe('a request main refuses', () => {
  it('is said under the row that asked', async () => {
    const { bridge, getByLabelText, getByRole } = await renderWith(
      AccountRow,
      { account },
      { accounts: [account] }
    )
    vi.mocked(bridge.api.Accounts.remove).mockRejectedValueOnce(
      new Error('That account is not being tracked.')
    )

    await fireEvent.click(getByLabelText('Stop tracking'))
    await settle()

    expect(getByRole('alert').textContent).toContain('That account is not being tracked.')
  })

  it('leaves the level as it was, and stops being said once a request goes through', async () => {
    const { bridge, getByLabelText, getByRole, queryByRole } = await renderWith(
      AccountRow,
      { account },
      { accounts: [account] }
    )
    vi.mocked(bridge.api.Accounts.patch).mockRejectedValueOnce(new Error('Not now'))
    const trigger = getByLabelText('Notifications for @status.bsky.app')
    const before = trigger.textContent

    await chooseOption(trigger, 'Outages only')
    await settle()

    expect(getByRole('alert').textContent).toContain('Not now')
    expect(trigger.textContent).toBe(before)

    await fireEvent.click(getByLabelText('Hide from feed'))
    await settle()
    expect(queryByRole('alert')).toBeNull()
  })
})

describe('a pushed source', () => {
  const pushed = makeAccount({
    did: 'webhook:pg_bsky',
    handle: 'status.bsky.app',
    displayName: 'status.bsky.app',
    kind: 'webhook'
  })

  it('is named after its status page, without an @ it does not have', async () => {
    const { getByText, queryByText } = await renderWith(
      AccountRow,
      { account: pushed },
      { accounts: [pushed] }
    )

    expect(getByText('status.bsky.app', { selector: 'span' })).toBeTruthy()
    expect(queryByText('@status.bsky.app')).toBeNull()
  })

  it('opens the status page rather than a Bluesky profile', async () => {
    const { bridge, getByTitle } = await renderWith(
      AccountRow,
      { account: pushed },
      { accounts: [pushed] }
    )

    await fireEvent.click(getByTitle('Open the status page'))

    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith('https://status.bsky.app')
  })

  it('can be muted and forgotten like any other source', async () => {
    const { bridge, getByLabelText } = await renderWith(
      AccountRow,
      { account: pushed },
      { accounts: [pushed] }
    )

    await fireEvent.click(getByLabelText('Hide from feed'))
    await fireEvent.click(getByLabelText('Stop tracking'))

    expect(bridge.api.Accounts.patch).toHaveBeenCalledWith(pushed.did, { muted: true })
    expect(bridge.api.Accounts.remove).toHaveBeenCalledWith(pushed.did)
  })

  it('labels its notification control without an @ either', async () => {
    const { getByLabelText } = await renderWith(
      AccountRow,
      { account: pushed },
      { accounts: [pushed] }
    )

    expect(getByLabelText('Notifications for status.bsky.app')).toBeTruthy()
  })
})

describe('the mute tooltip', () => {
  it.each([
    [false, 'Hide from feed', 'Showing in feed'],
    [true, 'Show in feed', 'Hidden from feed']
  ])('says which way the toggle currently sits (muted: %s)', async (muted, control, tooltip) => {
    const subject = { ...account, muted }
    const { getByLabelText, findByText } = await renderWith(
      AccountRow,
      { account: subject },
      { accounts: [subject] }
    )

    await fireEvent.focus(getByLabelText(control))

    expect(await findByText(tooltip)).toBeTruthy()
  })
})

describe('the network checks’ source', () => {
  const source = probeAccount('2026-01-01T00:00:00Z')

  it('wears the checks’ icon, not initials', async () => {
    const { container, queryByText } = await renderWith(
      AccountRow,
      { account: source },
      { accounts: [source] }
    )
    expect(container.querySelector('span.grid.rounded-full svg')).not.toBeNull()
    expect(queryByText('NC')).toBeNull()
  })

  it('opens the dashboard instead of a web page', async () => {
    const { bridge, getByTitle } = await renderWith(
      AccountRow,
      { account: source },
      { accounts: [source] }
    )
    await fireEvent.click(getByTitle('Open the network dashboard'))
    expect(nav.view).toBe('network')
    expect(nav.pending).toEqual({ serviceId: null })
    expect(bridge.api.Host.openExternal).not.toHaveBeenCalled()
  })

  it.each([
    [
      makeNetworkSummary({ health: 'operational', total: 26, reachable: 25 }),
      '25 of 26 services answering'
    ],
    [
      makeNetworkSummary({ health: 'down', total: 26, reachable: 24 }),
      '24 of 26 services answering'
    ],
    [makeNetworkSummary({ health: 'off' }), 'Checks are off'],
    [makeNetworkSummary({ health: 'offline' }), HEALTH_LABEL.offline],
    [makeNetworkSummary({ health: 'unknown' }), 'Not measured yet']
  ])('reports the live measurement as its health: %o', async (network, label) => {
    const { getByText } = await renderWith(
      AccountRow,
      { account: source },
      { accounts: [source], network }
    )
    expect(getByText(label)).toBeTruthy()
  })

  it('can be silenced and hidden, but not removed', async () => {
    const { queryByLabelText, getByLabelText } = await renderWith(
      AccountRow,
      { account: source },
      { accounts: [source] }
    )
    expect(queryByLabelText('Stop tracking')).toBeNull()
    expect(getByLabelText('Notifications for Network checks')).toBeTruthy()
    expect(getByLabelText('Hide from feed')).toBeTruthy()
  })
})
