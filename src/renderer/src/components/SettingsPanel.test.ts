import { describe, expect, it, vi } from 'vitest'
import { fireEvent, within } from '@testing-library/svelte'
import { NETWORK_INTERVAL_CHOICES, POLL_INTERVAL_CHOICES } from '@shared/defaults'
import { makeSettings, makeWebhookStatus } from '../../../test/factories'
import { chooseOption, openSelect, pushState, renderWith, settle } from '../test/render'
import SettingsPanel from './SettingsPanel.svelte'

/**
 * The section's own tests are in NotificationSettings.test.ts. What is left to say here
 * is that the panel carries it, and hands it the clock a pause is read against.
 */
describe('the notification settings', () => {
  it('are part of the panel, and read a pause against its clock', async () => {
    const { getByLabelText, getByText } = await renderWith(
      SettingsPanel,
      { now: Date.parse('2026-03-01T12:00:00.000Z') },
      { settings: makeSettings({ notificationsSnoozedUntil: '2026-03-01T12:30:00.000Z' }) }
    )

    expect(getByLabelText('Enable notifications')).toBeTruthy()
    // Long over by the wall clock, and half an hour off still by the panel's.
    expect(getByText('Paused')).toBeTruthy()
  })
})

describe('the feed settings', () => {
  it('shows the current poll interval by its label', async () => {
    const { getByText } = await renderWith(
      SettingsPanel,
      {},
      { settings: makeSettings({ pollIntervalSec: 300 }) }
    )
    expect(getByText('5 minutes')).toBeTruthy()
  })

  it('falls back to raw seconds for an interval that is not on the menu', async () => {
    const { getByText } = await renderWith(
      SettingsPanel,
      {},
      { settings: makeSettings({ pollIntervalSec: 47 }) }
    )
    expect(getByText('47s')).toBeTruthy()
  })

  it('offers every documented interval', async () => {
    const { getByText } = await renderWith(SettingsPanel)
    const listbox = await openSelect(getByText('2 minutes'))

    for (const choice of POLL_INTERVAL_CHOICES) {
      expect(listbox.textContent).toContain(choice.label)
    }
  })

  it('applies the chosen interval', async () => {
    const { bridge, getByText } = await renderWith(SettingsPanel)

    await chooseOption(getByText('2 minutes'), '15 minutes')

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ pollIntervalSec: 900 })
  })

  it('offers every way of marking updates read', async () => {
    const { getByText } = await renderWith(SettingsPanel)
    const listbox = await openSelect(getByText('When I open a tab'))

    for (const label of ['When I open a tab', 'Only when I say', 'When it scrolls past']) {
      expect(listbox.textContent).toContain(label)
    }
  })

  it('applies the chosen read trigger', async () => {
    const { bridge, getByText } = await renderWith(SettingsPanel)

    await chooseOption(getByText('When I open a tab'), 'When it scrolls past')

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ markReadOn: 'seen' })
  })
})

describe('the menu bar settings', () => {
  it('offers every way the icon can announce unread updates', async () => {
    const { getByText } = await renderWith(SettingsPanel)
    const listbox = await openSelect(getByText('Beat the icon'))

    for (const label of ['Beat the icon', 'Badge the icon', 'Show a count', 'Leave it alone']) {
      expect(listbox.textContent).toContain(label)
    }
  })

  it('applies the chosen style', async () => {
    const { bridge, getByText } = await renderWith(SettingsPanel)

    await chooseOption(getByText('Beat the icon'), 'Show a count')

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ trayUnreadStyle: 'count' })
  })

  it('describes the style that is currently chosen', async () => {
    const { getByText } = await renderWith(
      SettingsPanel,
      {},
      { settings: makeSettings({ trayUnreadStyle: 'none' }) }
    )

    expect(getByText('The icon reports health and nothing else.')).toBeTruthy()
  })
})

/**
 * The shortcut that summons the popover from anywhere. Off by default, because a global
 * shortcut is taken from every other application on the machine — and reported honestly
 * when the OS hands it to somebody else instead, which is otherwise completely silent.
 */
describe('the summoning shortcut', () => {
  it('starts off, in the platform’s own spelling', async () => {
    const { getByLabelText } = await renderWith(SettingsPanel)

    expect(getByLabelText('Keyboard shortcut to open Statusky').textContent).toContain('Off')
  })

  it('writes the combinations the way macOS writes them', async () => {
    const { getByLabelText } = await renderWith(SettingsPanel)
    const listbox = await openSelect(getByLabelText('Keyboard shortcut to open Statusky'))

    expect(listbox.textContent).toContain('⌘⇧S')
    expect(listbox.textContent).toContain('⌥⇧S')
  })

  it('writes them the way Windows writes them instead', async () => {
    const { getByLabelText } = await renderWith(SettingsPanel, {}, { platform: 'win32' })
    const listbox = await openSelect(getByLabelText('Keyboard shortcut to open Statusky'))

    expect(listbox.textContent).toContain('Ctrl+Shift+S')
  })

  it('asks for the combination the user picked', async () => {
    const { bridge, getByLabelText } = await renderWith(SettingsPanel)

    await chooseOption(getByLabelText('Keyboard shortcut to open Statusky'), '⌘⇧S')

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({
      globalShortcut: 'CommandOrControl+Shift+S'
    })
  })

  /**
   * The select cannot carry the empty string the setting uses for "none" — an empty
   * value reads as nothing being selected — so the panel maps a sentinel back to it.
   * What must never happen is `'off'` reaching the settings as an accelerator.
   */
  it('turns the shortcut off with the empty accelerator, not a sentinel', async () => {
    const { bridge, getByLabelText } = await renderWith(
      SettingsPanel,
      {},
      { settings: makeSettings({ globalShortcut: 'CommandOrControl+Shift+S' }) }
    )

    await chooseOption(getByLabelText('Keyboard shortcut to open Statusky'), 'Off')

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ globalShortcut: '' })
  })

  /**
   * A shortcut belongs to whichever application asked for it first, and losing that race
   * produces no symptom at all except a key that does somebody else's thing. The setting
   * keeps saying what the user asked for; this is the sentence that says the machine
   * disagreed.
   */
  it('says when the OS gave the combination to somebody else', async () => {
    const { getByRole } = await renderWith(
      SettingsPanel,
      {},
      {
        settings: makeSettings({ globalShortcut: 'CommandOrControl+Shift+S' }),
        shortcut: { registered: false, error: 'Another application already owns ⌘⇧S.' }
      }
    )

    expect(getByRole('alert').textContent).toContain('Another application already owns')
  })
})

describe('the application settings', () => {
  it('offers the three theme choices', async () => {
    const { getByText } = await renderWith(SettingsPanel)
    const listbox = await openSelect(getByText('Match system'))

    for (const label of ['Match system', 'Light', 'Dark']) {
      expect(listbox.textContent).toContain(label)
    }
  })

  it('pins the theme the user picks', async () => {
    const { bridge, getByText } = await renderWith(SettingsPanel)

    await chooseOption(getByText('Match system'), 'Dark')

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('labels a pinned theme', async () => {
    const { getByText } = await renderWith(
      SettingsPanel,
      {},
      { settings: makeSettings({ theme: 'dark' }) }
    )
    expect(getByText('Dark')).toBeTruthy()
  })

  it('toggles launch at login', async () => {
    const { bridge, getByLabelText } = await renderWith(SettingsPanel)

    await fireEvent.click(getByLabelText('Launch at login'))

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ launchAtLogin: true })
  })

  it('says nothing extra when the OS did what it was asked', async () => {
    const { queryByRole } = await renderWith(
      SettingsPanel,
      {},
      { loginItem: { registered: true, error: null } }
    )
    expect(queryByRole('alert')).toBeNull()
  })

  /**
   * The refusal is otherwise invisible: macOS registers nothing and says nothing, and
   * the next thing that would have told the user is the app that did not start. So the
   * toggle keeps showing what they asked for and this says what the machine did about it.
   */
  it('says why the OS refused, under the toggle that still says yes', async () => {
    const { getByRole, getByLabelText } = await renderWith(
      SettingsPanel,
      {},
      {
        settings: makeSettings({ launchAtLogin: true }),
        loginItem: { registered: false, error: 'macOS would not open Statusky at login.' }
      }
    )

    expect(getByLabelText('Launch at login').getAttribute('aria-checked')).toBe('true')
    expect(getByRole('alert').textContent).toContain('macOS would not open Statusky at login.')
  })

  it('clears the explanation once a later attempt is accepted', async () => {
    const { bridge, queryByRole } = await renderWith(
      SettingsPanel,
      {},
      { loginItem: { registered: false, error: 'Could not register.' } }
    )
    expect(queryByRole('alert')).not.toBeNull()

    await pushState(bridge, { loginItem: { registered: true, error: null } })

    expect(queryByRole('alert')).toBeNull()
  })
})

/**
 * A refusal used to land on a line under the Accounts tab's add field, nowhere near the
 * control that asked, and the control went on showing the click as if it had worked.
 */
describe('a change main refuses', () => {
  it('is said under the row that asked, and the switch goes back', async () => {
    const { bridge, getByLabelText, getByRole } = await renderWith(SettingsPanel)
    vi.mocked(bridge.api.Preferences.patch).mockRejectedValueOnce(
      new Error("Error invoking remote method 'x': Error: Login items are managed for you")
    )
    const toggle = getByLabelText('Launch at login')

    await fireEvent.click(toggle)
    await settle()

    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(getByRole('alert').textContent).toContain('Login items are managed for you')
  })

  it('stops being said once a change from the same row goes through', async () => {
    const { bridge, getByLabelText, queryByRole } = await renderWith(SettingsPanel)
    vi.mocked(bridge.api.Preferences.patch).mockRejectedValueOnce(new Error('Not now'))
    const toggle = getByLabelText('Launch at login')

    await fireEvent.click(toggle)
    await settle()
    expect(queryByRole('alert')).not.toBeNull()

    await fireEvent.click(toggle)
    await settle()
    expect(queryByRole('alert')).toBeNull()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('puts a select back on what main has, as well as saying why', async () => {
    const { bridge, getByLabelText, getByRole } = await renderWith(SettingsPanel)
    vi.mocked(bridge.api.Preferences.patch).mockRejectedValueOnce(new Error('Not a theme'))
    const trigger = getByLabelText('Appearance')

    await chooseOption(trigger, 'Dark')
    await settle()

    expect(trigger.textContent?.trim()).toBe('Match system')
    expect(getByRole('alert').textContent).toContain('Not a theme')
    const listbox = await openSelect(trigger)
    const selected = listbox.querySelector('[role="option"][aria-selected="true"]')
    expect(selected?.textContent?.trim()).toBe('Match system')
  })
})

describe('the footer', () => {
  it('names the version and what the app reads', async () => {
    const { container } = await renderWith(SettingsPanel, {}, { version: '9.9.9' })
    expect(container.textContent).toContain('Statusky 9.9.9')
    expect(container.textContent).toContain('app.bsky.feed.post')
  })
})

describe('the webhook section', () => {
  it('is part of the panel, and ticks its own relative timestamp', async () => {
    const { container } = await renderWith(
      SettingsPanel,
      { now: Date.parse('2026-03-01T12:00:00.000Z') },
      {
        settings: makeSettings({ webhookEnabled: true }),
        webhook: makeWebhookStatus({
          state: 'listening',
          url: 'http://127.0.0.1:7385/webhook/s3cr3t',
          port: 7385,
          deliveries: 2,
          lastDeliveryAt: '2026-03-01T11:58:00.000Z'
        })
      }
    )

    expect(container.textContent).toContain('Pushed updates')
    expect(container.textContent).toContain('last 2 minutes ago')
  })
})

describe('the network checks', () => {
  it('switches them on and off', async () => {
    const { bridge, getByLabelText } = await renderWith(SettingsPanel)
    const toggle = getByLabelText('Run network checks')
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await fireEvent.click(toggle)

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ networkChecks: false })
  })

  it('shows how often they run, by its label', async () => {
    const { getByLabelText } = await renderWith(SettingsPanel)
    expect(getByLabelText('How often to check the network').textContent?.trim()).toBe('10 minutes')
  })

  it('falls back to minutes for an interval that is not on the menu', async () => {
    const { getByLabelText } = await renderWith(
      SettingsPanel,
      {},
      { settings: makeSettings({ networkIntervalSec: 420 }) }
    )
    expect(getByLabelText('How often to check the network').textContent?.trim()).toBe('7 minutes')
  })

  it('applies the chosen interval', async () => {
    const { bridge, getByLabelText } = await renderWith(SettingsPanel)

    await chooseOption(getByLabelText('How often to check the network'), '5 minutes')

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ networkIntervalSec: 300 })
  })

  it('offers every documented interval', async () => {
    const { getByLabelText } = await renderWith(SettingsPanel)
    const listbox = await openSelect(getByLabelText('How often to check the network'))
    const options = [...listbox.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim()
    )
    expect(options).toEqual(NETWORK_INTERVAL_CHOICES.map((c) => c.label))
  })

  it('cannot change the interval while they are off', async () => {
    const { getByLabelText } = await renderWith(
      SettingsPanel,
      {},
      { settings: makeSettings({ networkChecks: false }) }
    )
    expect(getByLabelText('How often to check the network').hasAttribute('disabled')).toBe(true)
  })

  it('says where confirmed outages go', async () => {
    const { container } = await renderWith(SettingsPanel)
    expect(container.textContent).toContain('filed in the feed as “Network checks”')
  })
})

/**
 * Item 27, from the popover's side. The tray menu carries the same news, and neither of
 * them is a notification: a banner from this app means the Atmosphere is broken, and
 * spending that channel on a version number is how it stops meaning that.
 */
describe('a newer Statusky', () => {
  it('says nothing while there is nothing to say', async () => {
    const { container } = await renderWith(SettingsPanel)

    expect(container.textContent).not.toContain('is available')
    expect(container.textContent).not.toContain('has been downloaded')
  })

  /**
   * The wording is the load-bearing part. These builds are a dmg, a zip, a .deb and an
   * AppImage from a download page — none of them served from a repository — so there is
   * no `apt upgrade` to point at and nothing on the machine that will do this for you.
   */
  it('says to go and fetch the new build, because nothing else will', async () => {
    const { container } = await renderWith(
      SettingsPanel,
      {},
      { update: { stage: 'available', version: '0.2.0' } }
    )

    expect(container.textContent).toContain('Statusky 0.2.0 is available')
    expect(container.textContent).toContain('Nothing on this machine updates Statusky for you')
    expect(container.textContent).toContain('replace this copy')
  })

  it('opens the download page through main, never in the popover', async () => {
    const { bridge, getByText } = await renderWith(
      SettingsPanel,
      {},
      { update: { stage: 'available', version: '0.2.0' } }
    )

    await fireEvent.click(getByText('Download'))

    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(
      'https://github.com/cutenode/statusky/releases/latest'
    )
  })

  /**
   * macOS and Windows, where Squirrel has already done the work. There is no Download
   * here because there is nothing to download — the verb is a restart, and it lives in
   * the menu bar with the rest of this app's verbs.
   */
  it('asks for a restart instead when one has already been downloaded', async () => {
    const { container, queryByText } = await renderWith(
      SettingsPanel,
      {},
      { update: { stage: 'ready', version: '0.5.0' } }
    )

    expect(container.textContent).toContain('Statusky 0.5.0 has been downloaded')
    expect(container.textContent).toContain('Restart to update')
    expect(queryByText('Download')).toBeNull()
  })

  /** A release not named as a version leaves the update unnamed. */
  it('still asks for the restart when the version is not known', async () => {
    const { container } = await renderWith(
      SettingsPanel,
      {},
      { update: { stage: 'ready', version: null } }
    )

    expect(container.textContent).toContain('A new version of Statusky has been downloaded')
  })

  it('appears without a reload when main finds out', async () => {
    const { bridge, container } = await renderWith(SettingsPanel)

    await pushState(bridge, { update: { stage: 'available', version: '0.3.0' } })

    expect(container.textContent).toContain('Statusky 0.3.0 is available')
  })
})

/** One panel's switch, found among the panel switches rather than the whole page. */
const chip = (view: { getByRole: (role: string, options: object) => HTMLElement }, name: string) =>
  within(view.getByRole('group', { name: 'Count in the menu bar' })).getByRole('button', {
    name: new RegExp(`^${name}$`)
  })

describe('which panels count in the menu bar', () => {
  it('offers every panel but the control group, pressed when it counts', async () => {
    const view = await renderWith(SettingsPanel)
    const group = view.getByRole('group', { name: 'Count in the menu bar' })
    expect([...group.querySelectorAll('button')].map((b) => b.textContent!.trim())).toEqual([
      'Relays',
      'Streams',
      'AppViews',
      'PDSes',
      'Tangled',
      'Apps',
      'Other infrastructure'
    ])
    expect(chip(view, 'Relays').getAttribute('aria-pressed')).toBe('true')
    expect(chip(view, 'Tangled').getAttribute('aria-pressed')).toBe('false')
  })

  it('adds a panel in the dashboard’s own order, and takes one out', async () => {
    const view = await renderWith(SettingsPanel)
    await fireEvent.click(chip(view, 'Tangled'))
    expect(view.bridge.api.Preferences.patch).toHaveBeenLastCalledWith({
      countedProbeGroups: ['relays', 'streams', 'appviews', 'pdses', 'tangled', 'infrastructure']
    })

    await fireEvent.click(chip(view, 'Relays'))
    expect(view.bridge.api.Preferences.patch).toHaveBeenLastCalledWith({
      countedProbeGroups: ['streams', 'appviews', 'pdses', 'tangled', 'infrastructure']
    })
  })

  // Built on the push, a second click before main answered the first sent a list
  // without the first one's change in it, and quietly undid it.
  it('keeps both of two quick clicks, though main has answered neither', async () => {
    const view = await renderWith(SettingsPanel)
    const patch = vi.mocked(view.bridge.api.Preferences.patch)
    const answers: (() => void)[] = []
    patch.mockImplementation(
      (next) =>
        new Promise((resolve) => {
          answers.push(() => resolve({ ...view.bridge.state.settings, ...next }))
        })
    )

    await fireEvent.click(chip(view, 'Tangled'))
    await fireEvent.click(chip(view, 'Apps'))

    expect(patch).toHaveBeenLastCalledWith({
      countedProbeGroups: [
        'relays',
        'streams',
        'appviews',
        'pdses',
        'tangled',
        'apps',
        'infrastructure'
      ]
    })
    for (const answer of answers) answer()
    await new Promise((resolve) => setTimeout(resolve))

    // Answered, it builds on what main has again.
    patch.mockRestore()
    await fireEvent.click(chip(view, 'Relays'))
    expect(patch).toHaveBeenLastCalledWith({
      countedProbeGroups: ['streams', 'appviews', 'pdses', 'infrastructure']
    })
  })

  it('says under the chips when main refuses', async () => {
    const view = await renderWith(SettingsPanel)
    vi.mocked(view.bridge.api.Preferences.patch).mockRejectedValueOnce(new Error('No such panel'))

    await fireEvent.click(chip(view, 'Tangled'))
    await settle()

    expect(view.getByRole('alert').textContent).toContain('No such panel')
    expect(chip(view, 'Tangled').getAttribute('aria-pressed')).toBe('false')
  })

  it('holds still while the checks are off', async () => {
    const view = await renderWith(
      SettingsPanel,
      {},
      { settings: makeSettings({ networkChecks: false }) }
    )
    expect((chip(view, 'Relays') as HTMLButtonElement).disabled).toBe(true)
  })
})
