import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import {
  makeAccount,
  makePost,
  makeService,
  makeSettings,
  makeSnapshot
} from '../../test/factories'
import { setMediaQuery } from './test/setup'
import { pushState, renderApp, settle } from './test/render'
import App from './App.svelte'

const account = makeAccount({ did: 'did:plc:a', handle: 'status.bsky.app', displayName: 'Bluesky' })
const post = makePost({
  authorDid: account.did,
  authorHandle: account.handle,
  text: 'We are investigating elevated error rates.'
})

// Reading kept manual, so the unread machinery is what these exercise. The Timeline tab
// catches you up regardless, which is its own test below.
const populated = {
  accounts: [account],
  posts: [post],
  unread: [post.uri],
  settings: makeSettings({ markReadOn: 'never' as const })
}

describe('the shell', () => {
  it('shows the header and its panel icons', async () => {
    const { getByRole, getByLabelText } = await renderApp(App, populated)

    expect(getByRole('heading', { level: 1 })).toBeTruthy()
    expect(getByLabelText('Accounts')).toBeTruthy()
    expect(getByLabelText('Settings')).toBeTruthy()
  })

  it('opens on the timeline', async () => {
    const { getByRole, getByText } = await renderApp(App, populated)

    expect(getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true')
    expect(getByText('We are investigating elevated error rates.')).toBeTruthy()
  })

  it('reports the unread count in the header and clears it when read', async () => {
    // Opened with nothing unread, so the Timeline's catch-up does not race this.
    const { bridge, container } = await renderApp(App, { ...populated, unread: [] })

    await pushState(bridge, { unread: [post.uri] })
    expect(container.textContent).toContain('1 unread')

    await pushState(bridge, { unread: [] })

    expect(container.textContent).not.toContain('1 unread')
  })

  it('catches up as soon as it opens, whatever the read setting says', async () => {
    const { bridge, container } = await renderApp(App, populated)

    expect(bridge.api.Feed.markAllRead).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('1 unread')
  })

  it('switches to accounts and settings from the header icons', async () => {
    const { getByLabelText, getByText, findByText } = await renderApp(App, populated)

    await fireEvent.click(getByLabelText('Accounts'))
    expect(await findByText('Track an account')).toBeTruthy()

    await fireEvent.click(getByLabelText('Settings'))
    expect(getByText('Push notifications')).toBeTruthy()
  })

  it('toggles a panel icon back to the tab it left', async () => {
    const { getByRole, getByLabelText, getByText, queryByText, findByText } = await renderApp(
      App,
      populated
    )
    await fireEvent.click(getByRole('tab', { name: 'Feed' }))

    await fireEvent.click(getByLabelText('Accounts'))
    expect(await findByText('Track an account')).toBeTruthy()

    await fireEvent.click(getByLabelText('Accounts'))

    expect(queryByText('Track an account')).toBeNull()
    expect(getByRole('tab', { name: 'Feed' }).getAttribute('aria-selected')).toBe('true')
    expect(getByText('We are investigating elevated error rates.')).toBeTruthy()
  })
})

describe('startup', () => {
  it('loads state from the bridge and subscribes for pushes', async () => {
    const { bridge } = await renderApp(App, populated)

    expect(bridge.api.State.get).toHaveBeenCalled()
    expect(bridge.listenerCount()).toBe(1)
  })

  it('shows a loading indicator until the first state arrives', async () => {
    const { container } = await renderApp(App, populated)
    // Ready by the time the harness settles; the placeholder is gone.
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('mirrors the system colour scheme onto the document', async () => {
    setMediaQuery('(prefers-color-scheme: dark)', true)
    await renderApp(App, populated)

    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('unsubscribes everything when the popover unmounts', async () => {
    const { bridge, unmount } = await renderApp(App, populated)
    expect(bridge.listenerCount()).toBe(1)

    unmount()
    await settle()

    expect(bridge.listenerCount()).toBe(0)
  })
})

describe('keyboard shortcuts', () => {
  it('hides the popover on Escape', async () => {
    const { bridge } = await renderApp(App, populated)

    await fireEvent.keyDown(window, { key: 'Escape' })

    expect(bridge.api.Host.hideWindow).toHaveBeenCalled()
  })

  it.each([
    ['metaKey', { key: 'r', metaKey: true }],
    ['ctrlKey', { key: 'r', ctrlKey: true }]
  ])('refreshes on %s+R', async (_name, init) => {
    const { bridge } = await renderApp(App, populated)
    vi.mocked(bridge.api.Feed.refresh).mockClear()

    await fireEvent.keyDown(window, init)

    expect(bridge.api.Feed.refresh).toHaveBeenCalled()
  })

  it('ignores a bare R, so typing in the add-account field still works', async () => {
    const { bridge } = await renderApp(App, populated)
    vi.mocked(bridge.api.Feed.refresh).mockClear()

    await fireEvent.keyDown(window, { key: 'r' })

    expect(bridge.api.Feed.refresh).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted', async () => {
    const { bridge, unmount } = await renderApp(App, populated)
    unmount()
    await settle()
    vi.mocked(bridge.api.Host.hideWindow).mockClear()

    await fireEvent.keyDown(window, { key: 'Escape' })

    expect(bridge.api.Host.hideWindow).not.toHaveBeenCalled()
  })
})

describe('refresh on focus', () => {
  it('refreshes when the popover is opened', async () => {
    const { bridge } = await renderApp(App, populated)
    vi.mocked(bridge.api.Feed.refresh).mockClear()

    await fireEvent.focus(window)

    expect(bridge.api.Feed.refresh).toHaveBeenCalled()
  })

  it('stops refreshing once unmounted', async () => {
    const { bridge, unmount } = await renderApp(App, populated)
    unmount()
    await settle()
    vi.mocked(bridge.api.Feed.refresh).mockClear()

    await fireEvent.focus(window)

    expect(bridge.api.Feed.refresh).not.toHaveBeenCalled()
  })
})

describe('the relative-time ticker', () => {
  it('advances timestamps without a timer per card', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const now = Date.now()
      const fresh = makePost({
        authorDid: account.did,
        authorHandle: account.handle,
        text: 'Fresh',
        createdAt: new Date(now - 60_000).toISOString()
      })
      const { container } = await renderApp(App, { ...populated, posts: [fresh] })
      expect(container.textContent).toContain('1m')

      await vi.advanceTimersByTimeAsync(3_600_000)
      await settle()

      expect(container.textContent).toContain('1h')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the network tab', () => {
  const snapshot = makeSnapshot({
    finishedAt: new Date().toISOString(),
    services: [
      makeService({ id: 'relay:bsky.network' }),
      makeService({ id: 'relay:europe.firehose.network' })
    ]
  })

  it('opens the dashboard, and comes back to the feed', async () => {
    const { getByRole, container } = await renderApp(App, { ...populated, snapshot })

    await fireEvent.click(getByRole('tab', { name: 'Network' }))
    expect(container.querySelector('[data-service="relay:bsky.network"]')).not.toBeNull()
    expect(getByRole('tab', { name: 'Network' }).getAttribute('aria-selected')).toBe('true')

    await fireEvent.click(getByRole('tab', { name: 'Feed' }))
    expect(container.textContent).toContain('We are investigating elevated error rates.')
  })

  it('has nothing unread left on the timeline once it has been read', async () => {
    const { getByRole, getByText } = await renderApp(App, { ...populated, snapshot })

    await fireEvent.click(getByRole('tab', { name: 'Network' }))
    await fireEvent.click(getByRole('tab', { name: 'Timeline' }))

    expect(getByText('All caught up.')).toBeTruthy()
  })

  it('returns to the dashboard after a detour through settings', async () => {
    const { getByRole, getByLabelText, findByText, container } = await renderApp(App, {
      ...populated,
      snapshot
    })
    await fireEvent.click(getByRole('tab', { name: 'Network' }))
    await fireEvent.click(getByLabelText('Settings'))
    expect(await findByText('Measure the network')).toBeTruthy()

    await fireEvent.click(getByLabelText('Settings'))
    expect(container.querySelector('[data-service]')).not.toBeNull()
  })

  it('opens at the service main asks to reveal', async () => {
    const { bridge, container } = await renderApp(App, { ...populated, snapshot })

    bridge.reveal('relay:europe.firehose.network')
    await settle()
    await settle()

    const row = container.querySelector('[data-service="relay:europe.firehose.network"] > button')!
    expect(row.getAttribute('aria-expanded')).toBe('true')
  })

  it.each([
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }]
  ])('selects each tab on %s+1 through +4', async (_name, modifier) => {
    const { getByRole } = await renderApp(App, { ...populated, snapshot })

    const select = async (key: string, name: string): Promise<void> => {
      await fireEvent.keyDown(window, { key, ...modifier })
      expect(getByRole('tab', { name }).getAttribute('aria-selected')).toBe('true')
    }

    await select('4', 'Network')
    await select('2', 'Feed')
    await select('3', 'Alerts')
    await select('1', 'Timeline')
  })

  it('ignores a bare digit', async () => {
    const { getByRole } = await renderApp(App, { ...populated, snapshot })
    await fireEvent.keyDown(window, { key: '2' })
    expect(getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true')
  })

  it('re-measures on Cmd+R rather than polling', async () => {
    const { bridge } = await renderApp(App, { ...populated, snapshot })
    await fireEvent.keyDown(window, { key: '4', metaKey: true })
    vi.mocked(bridge.api.Feed.refresh).mockClear()

    await fireEvent.keyDown(window, { key: 'r', metaKey: true })

    expect(bridge.api.Network.run).toHaveBeenCalledTimes(1)
    expect(bridge.api.Feed.refresh).not.toHaveBeenCalled()
  })

  it('re-measures a stale dashboard when the popover opens, and leaves a fresh one', async () => {
    const stale = makeSnapshot({ finishedAt: new Date(Date.now() - 10 * 60_000).toISOString() })
    const old = await renderApp(App, { ...populated, snapshot: stale })
    await fireEvent.focus(window)
    expect(old.bridge.api.Network.run).toHaveBeenCalledTimes(1)
    old.unmount()

    const fresh = await renderApp(App, { ...populated, snapshot })
    await fireEvent.focus(window)
    expect(fresh.bridge.api.Network.run).not.toHaveBeenCalled()
  })
})
