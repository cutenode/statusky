import { describe, expect, it, vi } from 'vitest'
import { fireEvent, within } from '@testing-library/svelte'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { isControl, SERVICES } from '@shared/network'
import { formatClock } from '@shared/notify'
import { DEFAULT_PROBE_TARGETS } from '@shared/probe-targets'
import type { Settings } from '@shared/types'
import { makeSettings } from '../../../test/factories'
import { chooseOption, pushState, renderWith, settle, type Rendered } from '../test/render'
import NotificationSettings from './NotificationSettings.svelte'

/**
 * The Notifications section of Settings: what deserves a banner, from where, and when.
 *
 * Every control is a request to main — nothing here holds a setting of its own — so the
 * tests read what each one asks for, and what each one shows for the settings pushed back.
 */

/** A moment clear of any daylight-saving change, in local time like the quiet hours. */
const CLOCK = new Date(2026, 5, 10, 9, 15)

/** One stage's chip, by the label it shows. */
function stage(view: Rendered, label: string): HTMLElement {
  return within(view.getByRole('group', { name: 'Incident stages' })).getByRole('button', {
    name: label
  })
}

/** The row in the pinned list for one service, by the label it shows. */
function pinRow(view: Rendered, label: string): HTMLLabelElement {
  const rows = view.getByRole('group', { name: 'Pinned services' }).querySelectorAll('label')
  const row = [...rows].find((node) => node.querySelector('span')?.textContent === label)
  if (!row) throw new Error(`No pinned-services row for ${JSON.stringify(label)}`)
  return row
}

const bobbin = SERVICES.find((s) => s.label === 'Bobbin (Tangled API)')!
const hydrant = SERVICES.find((s) => s.label === 'Hydrant (Bobbin upstream)')!

describe('the master switch', () => {
  it('reflects and toggles it', async () => {
    const { bridge, getByLabelText } = await renderWith(NotificationSettings)
    const master = getByLabelText('Enable notifications')

    expect(master.getAttribute('aria-checked')).toBe('true')

    await fireEvent.click(master)

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ notificationsEnabled: false })
  })

  it('holds every control under it still while it is off', async () => {
    // Pinned and quiet hours on, so the controls that only exist then are drawn too.
    const drawn = { notifyProbeScope: 'pinned', quietHoursEnabled: true } as const
    const view = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ ...drawn, notificationsEnabled: false }) }
    )
    const controls = (): HTMLElement[] => [
      ...view.getAllByRole('switch').filter((s) => s.ariaLabel !== 'Enable notifications'),
      // The select triggers: plain buttons that open a listbox.
      ...view.container.querySelectorAll<HTMLElement>('[aria-haspopup="listbox"]'),
      ...within(view.getByRole('group', { name: 'Notification preset' })).getAllByRole('button'),
      ...within(view.getByRole('group', { name: 'Incident stages' })).getAllByRole('button'),
      ...within(view.getByRole('group', { name: 'Pinned services' })).getAllByRole('checkbox'),
      view.getByLabelText('Quiet hours start'),
      view.getByLabelText('Quiet hours end')
    ]

    // Pause, sound, which services, how long, and while away.
    expect(view.container.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(5)
    for (const control of controls()) {
      expect(control.hasAttribute('disabled'), control.ariaLabel ?? control.textContent!).toBe(true)
    }
    expect(view.getByLabelText('Enable notifications').hasAttribute('disabled')).toBe(false)

    await pushState(view.bridge, { settings: makeSettings(drawn) })

    for (const control of controls()) {
      expect(control.hasAttribute('disabled'), control.ariaLabel ?? control.textContent!).toBe(
        false
      )
    }
  })
})

describe('switches', () => {
  /**
   * Each drawn in the opposite of its default, so what it shows is read from the
   * setting rather than from the markup. Quiet hours are on throughout, since the
   * breakthrough switch only exists while they are.
   */
  it.each([
    ['Keep outages on screen', 'notifyStickyOutages'],
    ['Show update text', 'notificationShowBody'],
    ['Only follow-ups for incidents I was told about', 'notifyFollowUpsOnly'],
    ['Notify when a service recovers', 'notifyProbeRecovery'],
    ['Notify when a service is partly failing', 'notifyProbePartial'],
    ['Quiet hours', 'quietHoursEnabled'],
    ['Let outages through quiet hours', 'quietHoursBreakthrough'],
    ['Combine bursts', 'notifyCombineBursts']
  ] as const)('shows and flips %s', async (label, key) => {
    const settings: Settings = makeSettings({
      quietHoursEnabled: true,
      [key]: !DEFAULT_SETTINGS[key]
    })
    const { bridge, getByLabelText } = await renderWith(NotificationSettings, {}, { settings })
    const toggle = getByLabelText(label)

    expect(toggle.getAttribute('aria-checked')).toBe(String(settings[key]))

    await fireEvent.click(toggle)

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ [key]: !settings[key] })
  })
})

describe('choices', () => {
  it.each([
    ['When to play the notification sound', 'Never', { notificationSound: 'never' }],
    ['What to do while you are away', 'Deliver anyway', { notifyWhenAway: 'deliver' }],
    ['Which measured services to notify about', 'Pinned only', { notifyProbeScope: 'pinned' }],
    ['How long a service must be down', '5 minutes', { notifyProbeGraceSec: 300 }]
  ])('applies what is picked for “%s”', async (label, option, patch) => {
    const { bridge, getByLabelText } = await renderWith(NotificationSettings)

    await chooseOption(getByLabelText(label), option)

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith(patch)
  })

  it('names each choice in force, and says what it means', async () => {
    const { getByLabelText, container } = await renderWith(
      NotificationSettings,
      {},
      {
        settings: makeSettings({
          notificationSound: 'never',
          notifyWhenAway: 'drop',
          notifyProbeScope: 'all',
          notifyProbeGraceSec: 900
        })
      }
    )
    const shown = (label: string): string => getByLabelText(label).textContent!.trim()

    expect(shown('When to play the notification sound')).toBe('Never')
    expect(container.textContent).toContain('Every banner arrives silently.')
    expect(shown('What to do while you are away')).toBe('Stay silent')
    expect(container.textContent).toContain('Nothing is announced; it waits in the feed.')
    expect(shown('Which measured services to notify about')).toBe('Core + community')
    expect(container.textContent).toContain('Hobby and sandbox services too.')
    expect(shown('How long a service must be down')).toBe('15 minutes')
  })

  // Main clamps it to an hour, not to the menu, so a hand-edited value can land between.
  it('names a wait that is not on the menu in minutes', async () => {
    const { getByLabelText } = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ notifyProbeGraceSec: 600 }) }
    )

    expect(getByLabelText('How long a service must be down').textContent?.trim()).toBe('10 minutes')
  })
})

describe('what deserves a banner', () => {
  it('applies a preset in one go and shows which one is in force', async () => {
    const { bridge, getByText, container } = await renderWith(NotificationSettings)

    expect(getByText('Incidents').getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).toContain('Everything but routine updates and maintenance.')

    await fireEvent.click(getByText('Outages'))

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({
      notifySeverities: ['outage', 'degraded', 'investigating']
    })
  })

  it('calls a hand-picked set of stages custom, pressing no preset', async () => {
    const { getByRole, container } = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ notifySeverities: ['outage', 'maintenance'] }) }
    )

    const presets = getByRole('group', { name: 'Notification preset' })
    expect(presets.querySelector('[aria-pressed="true"]')).toBeNull()
    expect(container.textContent).toContain('A hand-picked set of stages.')
  })

  // Stored in display order, so the list reads the way the chips do, whatever was
  // clicked first.
  it('adds a stage in its place among the rest', async () => {
    const view = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ notifySeverities: ['resolved', 'maintenance'] }) }
    )
    expect(stage(view, 'Outage').getAttribute('aria-pressed')).toBe('false')

    await fireEvent.click(stage(view, 'Outage'))

    expect(view.bridge.api.Preferences.patch).toHaveBeenCalledWith({
      notifySeverities: ['outage', 'resolved', 'maintenance']
    })
  })

  it('takes a stage out, keeping the rest', async () => {
    const view = await renderWith(NotificationSettings)
    expect(stage(view, 'Degraded').getAttribute('aria-pressed')).toBe('true')

    await fireEvent.click(stage(view, 'Degraded'))

    expect(view.bridge.api.Preferences.patch).toHaveBeenCalledWith({
      notifySeverities: ['outage', 'investigating', 'identified', 'monitoring', 'resolved']
    })
  })
})

describe('sources', () => {
  it('switches a kind of source off', async () => {
    const { bridge, getByLabelText } = await renderWith(NotificationSettings)

    await fireEvent.click(getByLabelText('Notifications from webhook sources'))

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({
      notifySources: ['atproto', 'probe']
    })
  })

  it('switches one back on in its place among the rest', async () => {
    const { bridge, getByLabelText } = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ notifySources: ['probe'] }) }
    )

    await fireEvent.click(getByLabelText('Notifications from status accounts'))

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({
      notifySources: ['atproto', 'probe']
    })
  })

  it('hides the network check controls while those banners are off', async () => {
    const { bridge, queryByLabelText } = await renderWith(NotificationSettings)
    expect(queryByLabelText('Which measured services to notify about')).not.toBeNull()

    await pushState(bridge, { settings: makeSettings({ notifySources: ['atproto'] }) })

    expect(queryByLabelText('Which measured services to notify about')).toBeNull()
    expect(queryByLabelText('How long a service must be down')).toBeNull()
    expect(queryByLabelText('Notify when a service recovers')).toBeNull()
  })
})

describe('pinned services', () => {
  it('lists services to pin only when notifying about pinned ones', async () => {
    const view = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ notifyProbeScope: 'core' }) }
    )
    expect(view.queryByRole('group', { name: 'Pinned services' })).toBeNull()

    await pushState(view.bridge, { settings: makeSettings({ notifyProbeScope: 'pinned' }) })
    await fireEvent.click(pinRow(view, bobbin.label).querySelector('input')!)

    expect(view.bridge.api.Preferences.patch).toHaveBeenCalledWith({
      pinnedServices: [bobbin.id]
    })
  })

  it('unpins one, keeping the rest', async () => {
    const view = await renderWith(
      NotificationSettings,
      {},
      {
        settings: makeSettings({
          notifyProbeScope: 'pinned',
          pinnedServices: [bobbin.id, hydrant.id]
        })
      }
    )
    const box = pinRow(view, bobbin.label).querySelector('input')!
    expect(box.checked).toBe(true)

    await fireEvent.click(box)

    expect(view.bridge.api.Preferences.patch).toHaveBeenCalledWith({
      pinnedServices: [hydrant.id]
    })
  })

  // The internet controls only say whether this computer is online; nobody pins those.
  it('offers what the checks measure, but not the controls, and marks community ones', async () => {
    const control = SERVICES.find(isControl)!
    const community = SERVICES.find((s) => s.tier === 'community')!
    const view = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ notifyProbeScope: 'pinned' }) }
    )

    expect(() => pinRow(view, control.label)).toThrow()
    expect(pinRow(view, bobbin.label).textContent).not.toContain('community')
    expect(pinRow(view, community.label).textContent).toContain('community')
  })
  // The dashboard follows the user's own targets, so the list has to as well: a feed they
  // added is measured and can be pinned, and one they took out is measured no longer.
  it("offers the feeds the checks read under the user's targets", async () => {
    const [discover] = DEFAULT_PROBE_TARGETS.feeds
    const garden = {
      label: 'Garden feed',
      host: 'garden.example.test',
      uri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/garden'
    }
    const view = await renderWith(
      NotificationSettings,
      {},
      {
        settings: makeSettings({
          notifyProbeScope: 'pinned',
          probeTargets: { ...structuredClone(DEFAULT_PROBE_TARGETS), feeds: [garden] }
        })
      }
    )

    expect(() => pinRow(view, discover!.label)).toThrow()
    await fireEvent.click(pinRow(view, garden.label).querySelector('input')!)

    expect(view.bridge.api.Preferences.patch).toHaveBeenCalledWith({
      pinnedServices: [`feed:${garden.host}`]
    })

    // And back to the checked-in list when the override goes.
    await pushState(view.bridge, { settings: makeSettings({ notifyProbeScope: 'pinned' }) })
    expect(() => pinRow(view, garden.label)).toThrow()
    expect(pinRow(view, discover!.label).textContent).toContain(discover!.label)
  })
})

describe('quiet hours', () => {
  it('shows the window only once they are on, and stores whole times', async () => {
    const { bridge, getByLabelText, queryByLabelText } = await renderWith(NotificationSettings)
    expect(queryByLabelText('Quiet hours start')).toBeNull()

    await pushState(bridge, { settings: makeSettings({ quietHoursEnabled: true }) })
    const start = getByLabelText('Quiet hours start') as HTMLInputElement
    const end = getByLabelText('Quiet hours end') as HTMLInputElement
    expect([start.value, end.value]).toEqual(['22:00', '08:00'])

    await fireEvent.change(start, { target: { value: '23:30' } })
    await fireEvent.change(end, { target: { value: '06:45' } })

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ quietHoursStart: '23:30' })
    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ quietHoursEnd: '06:45' })
  })

  // A time input reports an empty string while it is half-typed.
  it('sends nothing for a time that is not whole yet', async () => {
    const { bridge, getByLabelText } = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ quietHoursEnabled: true }) }
    )

    await fireEvent.change(getByLabelText('Quiet hours end'), { target: { value: '' } })

    expect(bridge.api.Preferences.patch).not.toHaveBeenCalled()
  })
})

describe('pausing', () => {
  /** "Until tomorrow" is until the user's day starts, which their quiet hours already say. */
  it.each([
    ['For 1 hour', new Date(2026, 5, 10, 10, 15)],
    ['Until tomorrow', new Date(2026, 5, 11, 7, 30)]
  ])('pauses %s', async (choice, until) => {
    vi.useFakeTimers({ toFake: ['Date'], now: CLOCK })
    const { bridge, getByLabelText } = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ quietHoursEnabled: true, quietHoursEnd: '07:30' }) }
    )

    await chooseOption(getByLabelText('Pause notifications'), choice)

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({
      notificationsSnoozedUntil: until.toISOString()
    })
  })

  it('says until when against the clock it is handed, and resumes', async () => {
    // Long past by the wall clock, and still half an hour off by the one handed over.
    const now = Date.parse('2026-03-01T12:00:00.000Z')
    const until = '2026-03-01T12:30:00.000Z'
    const { bridge, getByText } = await renderWith(
      NotificationSettings,
      { now },
      { settings: makeSettings({ notificationsSnoozedUntil: until }) }
    )

    expect(getByText('Paused')).toBeTruthy()
    expect(
      getByText(`Held until ${formatClock(new Date(until), new Date(now))}, then summarized.`)
    ).toBeTruthy()

    await fireEvent.click(getByText('Resume'))

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ notificationsSnoozedUntil: null })
  })

  it('reads its own clock when not handed one, and lets a pause that is over lapse', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: CLOCK })
    const at = (minutes: number): string =>
      new Date(CLOCK.getTime() + minutes * 60_000).toISOString()
    const { bridge, getByText, queryByText } = await renderWith(
      NotificationSettings,
      {},
      { settings: makeSettings({ notificationsSnoozedUntil: at(30) }) }
    )
    expect(getByText('Paused')).toBeTruthy()

    await pushState(bridge, { settings: makeSettings({ notificationsSnoozedUntil: at(-1) }) })

    expect(queryByText('Paused')).toBeNull()
    expect(getByText('Pause notifications')).toBeTruthy()
  })
})

describe('the test notification', () => {
  it('sends one, and says where to look if nothing appeared', async () => {
    const { bridge, getByRole, findByRole } = await renderWith(NotificationSettings)

    await fireEvent.click(getByRole('button', { name: 'Send test' }))

    expect(bridge.api.Host.sendTestNotification).toHaveBeenCalledTimes(1)
    expect((await findByRole('status')).textContent).toContain('Sent.')
  })

  it('holds the button while one is on its way', async () => {
    const { bridge, getByRole, findByRole } = await renderWith(NotificationSettings)
    let deliver!: () => void
    vi.mocked(bridge.api.Host.sendTestNotification).mockImplementationOnce(
      () => new Promise<void>((resolve) => (deliver = resolve))
    )

    await fireEvent.click(getByRole('button', { name: 'Send test' }))

    expect(getByRole('button', { name: 'Sending…' }).hasAttribute('disabled')).toBe(true)

    deliver()
    await settle()

    expect((await findByRole('status')).textContent).toContain('Sent.')
    expect(getByRole('button', { name: 'Send test' }).hasAttribute('disabled')).toBe(false)
  })

  // A refused banner is invisible by definition, so the panel has to say so itself.
  it('reports the reason when the system refuses the notification', async () => {
    const { bridge, getByRole, findByRole, queryByRole } = await renderWith(NotificationSettings)
    vi.mocked(bridge.api.Host.sendTestNotification).mockRejectedValueOnce(
      new Error('Enable notifications for Statusky in System Settings.')
    )

    await fireEvent.click(getByRole('button', { name: 'Send test' }))

    expect((await findByRole('alert')).textContent?.trim()).toBe(
      'Enable notifications for Statusky in System Settings.'
    )
    expect(queryByRole('status')).toBeNull()
  })
})
