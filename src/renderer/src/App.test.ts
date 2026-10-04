import { describe, expect, it, vi } from 'vitest'
import { fireEvent, within } from '@testing-library/svelte'
import {
  makeAccount,
  makeNetworkSummary,
  makePost,
  makeService,
  makeSettings,
  makeSnapshot
} from '../../test/factories'
import { app } from '$lib/app-state.svelte'
import { mediaListenerCount, setMediaQuery } from './test/setup'
import { openSelect, pushState, renderApp, settle } from './test/render'
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
    // Hold the store's first answer back, the way a main process still starting up would.
    let answer!: () => void
    const held = new Promise<void>((resolve) => (answer = resolve))
    const init = app.init.bind(app)
    const spy = vi.spyOn(app, 'init').mockImplementationOnce(async () => {
      await held
      return init()
    })
    try {
      const { container, queryByText } = await renderApp(App, populated)
      expect(container.querySelector('.animate-pulse')).not.toBeNull()
      expect(queryByText('We are investigating elevated error rates.')).toBeNull()

      answer()
      await settle()
      await settle()

      expect(container.querySelector('.animate-pulse')).toBeNull()
      expect(queryByText('We are investigating elevated error rates.')).not.toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  // The loading light used to stay on for good when the first state never came.
  it('says the first state could not be loaded, and tries again on request', async () => {
    const spy = vi
      .spyOn(app, 'init')
      .mockRejectedValueOnce(
        new Error("Error invoking remote method 'State.get': Error: The store is locked")
      )
    try {
      const { bridge, getByText, findByRole, queryByText } = await renderApp(App, {
        ...populated,
        unread: []
      })
      expect((await findByRole('alert')).textContent).toContain('The store is locked')
      expect(getByText('Statusky could not load')).toBeTruthy()

      await fireEvent.click(getByText('Try again'))
      await settle()
      await settle()
      await settle()

      expect(queryByText('Statusky could not load')).toBeNull()
      expect(getByText('We are investigating elevated error rates.')).toBeTruthy()
      expect(bridge.listenerCount()).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  // A popover closed while it was still loading left its subscriptions behind.
  it('lets go of a first state that lands after it has gone', async () => {
    let answer!: () => void
    const held = new Promise<void>((resolve) => (answer = resolve))
    const init = app.init.bind(app)
    const spy = vi.spyOn(app, 'init').mockImplementationOnce(async () => {
      await held
      return init()
    })
    try {
      const { bridge, unmount } = await renderApp(App, populated)
      unmount()

      answer()
      await settle()
      await settle()

      expect(bridge.listenerCount()).toBe(0)
      expect(bridge.pushListenerCount()).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('mirrors the system colour scheme onto the document', async () => {
    setMediaQuery('(prefers-color-scheme: dark)', true)
    await renderApp(App, populated)

    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('unsubscribes everything when the popover unmounts', async () => {
    const { bridge, unmount } = await renderApp(App, populated)
    const subscriptions = (): number[] => [
      bridge.listenerCount(),
      bridge.pushListenerCount(),
      mediaListenerCount('(prefers-color-scheme: dark)'),
      mediaListenerCount('(prefers-reduced-motion: reduce)')
    ]
    // State; the dashboard, reveals and catch-ups; the theme; reduced motion.
    expect(subscriptions()).toEqual([1, 3, 1, 1])

    unmount()
    await settle()

    expect(subscriptions()).toEqual([0, 0, 0, 0])
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

  // Esc in an open select closes the select. Taken as "close the popover" as well, it
  // took the window — and whatever was being edited in it — along with the select.
  it('leaves Escape to an open select, which answered it first', async () => {
    const { bridge, getByLabelText, findByText } = await renderApp(App, populated)
    await fireEvent.click(getByLabelText('Settings'))
    expect(await findByText('Push notifications')).toBeTruthy()
    const listbox = await openSelect(getByLabelText('Appearance'))

    await fireEvent.keyDown(listbox, { key: 'Escape' })

    expect(bridge.api.Host.hideWindow).not.toHaveBeenCalled()
  })

  it('leaves Escape to an input method that is still composing', async () => {
    const { bridge } = await renderApp(App, populated)

    await fireEvent.keyDown(window, { key: 'Escape', isComposing: true })

    expect(bridge.api.Host.hideWindow).not.toHaveBeenCalled()
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

describe('telling main what only Chromium knows', () => {
  // The checks would otherwise sit out their offline retry before noticing.
  it('passes the connection coming back and going away straight on', async () => {
    const { bridge } = await renderApp(App, populated)

    await fireEvent(window, new Event('online'))
    await fireEvent(window, new Event('offline'))

    expect(vi.mocked(bridge.api.Popover.online).mock.calls).toEqual([[true], [false]])
  })

  it('stops reporting once unmounted', async () => {
    const { bridge, unmount } = await renderApp(App, populated)
    unmount()
    await settle()
    vi.mocked(bridge.api.Popover.online).mockClear()

    await fireEvent(window, new Event('online'))

    expect(bridge.api.Popover.online).not.toHaveBeenCalled()
  })

  // The tray icon is in the main process, where this cannot be read; see `Popover` in
  // schemas/statusky.eipc.
  it('reports the reduced-motion preference on mount', async () => {
    setMediaQuery('(prefers-reduced-motion: reduce)', true)

    const { bridge } = await renderApp(App, populated)

    expect(bridge.api.Popover.reduceMotion).toHaveBeenCalledWith(true)
  })

  it('reports the preference changing while the popover is open', async () => {
    setMediaQuery('(prefers-reduced-motion: reduce)', false)
    const { bridge } = await renderApp(App, populated)
    vi.mocked(bridge.api.Popover.reduceMotion).mockClear()

    setMediaQuery('(prefers-reduced-motion: reduce)', true)
    await settle()

    expect(bridge.api.Popover.reduceMotion).toHaveBeenCalledWith(true)
  })

  it('stops reporting the preference once unmounted', async () => {
    const { bridge, unmount } = await renderApp(App, populated)
    unmount()
    await settle()
    vi.mocked(bridge.api.Popover.reduceMotion).mockClear()

    setMediaQuery('(prefers-reduced-motion: reduce)', true)
    await settle()

    expect(bridge.api.Popover.reduceMotion).not.toHaveBeenCalled()
  })

  it('shows the Timeline when main asks to catch the user up', async () => {
    const { bridge, getByRole } = await renderApp(App, populated)
    await fireEvent.keyDown(window, { key: '3', metaKey: true })
    expect(getByRole('tab', { name: 'Network' }).getAttribute('aria-selected')).toBe('true')

    bridge.catchUp()
    await settle()

    expect(getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true')
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
  ])('selects each tab on %s+1 through +3', async (_name, modifier) => {
    const { getByRole } = await renderApp(App, { ...populated, snapshot })

    const select = async (key: string, name: string): Promise<void> => {
      await fireEvent.keyDown(window, { key, ...modifier })
      expect(getByRole('tab', { name }).getAttribute('aria-selected')).toBe('true')
    }

    await select('3', 'Network')
    await select('2', 'Feed')
    await select('1', 'Timeline')
  })

  it('ignores a digit past the last tab', async () => {
    const { getByRole } = await renderApp(App, { ...populated, snapshot })
    const event = new KeyboardEvent('keydown', { key: '4', metaKey: true, cancelable: true })

    await fireEvent(window, event)

    expect(getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true')
    expect(event.defaultPrevented).toBe(false)
  })

  it('calls the open tab’s panel by its name, and a detour nothing of the sort', async () => {
    const { getByRole, getByLabelText, queryByRole } = await renderApp(App, {
      ...populated,
      snapshot
    })
    await fireEvent.click(getByRole('tab', { name: 'Network' }))
    expect(getByRole('tabpanel', { name: 'Network' }).id).toBe('view')

    await fireEvent.click(getByLabelText('Settings'))
    expect(queryByRole('tabpanel')).toBeNull()
  })

  it('ignores a bare digit', async () => {
    const { getByRole } = await renderApp(App, { ...populated, snapshot })
    await fireEvent.keyDown(window, { key: '2' })
    expect(getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true')
  })

  it('re-measures on Cmd+R rather than polling', async () => {
    const { bridge } = await renderApp(App, { ...populated, snapshot })
    await fireEvent.keyDown(window, { key: '3', metaKey: true })
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

    // Stamped now rather than when the file loaded, so a slow run cannot age it.
    const recent = makeSnapshot({ finishedAt: new Date().toISOString() })
    const fresh = await renderApp(App, { ...populated, snapshot: recent })
    await fireEvent.focus(window)
    expect(fresh.bridge.api.Network.run).not.toHaveBeenCalled()
  })
})

/**
 * The editor in Settings is rebuilt with the rest of the panel on every switch, and its
 * working copy used to go with it: half an edit, lost to a banner being clicked.
 */
describe('the check targets editor across a switch', () => {
  it('keeps an unsaved edit through a reveal, and back', async () => {
    const { bridge, getByLabelText, getByRole, findByText } = await renderApp(App, populated)
    await fireEvent.click(getByLabelText('Settings'))
    await findByText('Check targets')
    await fireEvent.click(document.getElementById('probe-section-toggle-tangled')!)
    const page = (): HTMLInputElement =>
      within(getByRole('group', { name: 'Tangled' })).getByLabelText('Page') as HTMLInputElement
    await fireEvent.input(page(), { target: { value: '/someone.example.com/elsewhere' } })

    // A notification asks for the dashboard, and the editor is torn down with Settings.
    bridge.reveal(null)
    await settle()
    expect(getByRole('tab', { name: 'Network' }).getAttribute('aria-selected')).toBe('true')

    await fireEvent.click(getByLabelText('Settings'))
    await findByText('Check targets')

    expect(page().value).toBe('/someone.example.com/elsewhere')
    expect(getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('lands on the accounts from the dashboard’s "Replace in Settings"', async () => {
    const { getByRole, findByText } = await renderApp(App, {
      ...populated,
      network: makeNetworkSummary({ vanished: [{ did: 'did:plc:gone', part: 'account' }] })
    })
    await fireEvent.click(getByRole('tab', { name: 'Network' }))

    await fireEvent.click(getByRole('button', { name: 'Replace in Settings' }))
    await findByText('Check targets')
    await settle()

    const heading = document.getElementById('probe-section-toggle-accounts')!
    expect(heading.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(heading)
  })
})
