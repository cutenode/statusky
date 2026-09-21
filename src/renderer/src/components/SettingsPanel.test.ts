import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import { DEFAULT_SETTINGS, NETWORK_INTERVAL_CHOICES, POLL_INTERVAL_CHOICES } from '@shared/defaults'
import { makeSettings, makeWebhookStatus } from '../../../test/factories'
import { chooseOption, openSelect, pushState, renderWith } from '../test/render'
import SettingsPanel from './SettingsPanel.svelte'

describe('the notification settings', () => {
  it('reflects and toggles the master switch', async () => {
    const { bridge, getByLabelText } = await renderWith(SettingsPanel)
    const master = getByLabelText('Enable notifications')

    expect(master.getAttribute('aria-checked')).toBe('true')

    await fireEvent.click(master)

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ notificationsEnabled: false })
  })

  it('disables the dependent switches when notifications are off', async () => {
    const { bridge, getByLabelText } = await renderWith(
      SettingsPanel,
      {},
      {
        settings: { ...POLL_DEFAULTS, notificationsEnabled: false }
      }
    )

    expect(getByLabelText('Play notification sound').hasAttribute('disabled')).toBe(true)

    await pushState(bridge, { settings: { ...POLL_DEFAULTS, notificationsEnabled: true } })

    expect(getByLabelText('Play notification sound').hasAttribute('disabled')).toBe(false)
  })

  it('toggles the sound', async () => {
    const { bridge, getByLabelText } = await renderWith(SettingsPanel)

    await fireEvent.click(getByLabelText('Play notification sound'))

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ notificationSound: false })
  })

  it('sends a test notification', async () => {
    const { bridge, getByText, findByRole } = await renderWith(SettingsPanel)

    await fireEvent.click(getByText('Send test'))

    expect(bridge.api.Host.sendTestNotification).toHaveBeenCalled()
    expect((await findByRole('status')).textContent).toContain('Sent.')
  })

  // A refused banner is invisible by definition, so the panel has to say so itself.
  it('reports the reason when the system refuses the notification', async () => {
    const { bridge, getByText, findByRole } = await renderWith(SettingsPanel)
    vi.mocked(bridge.api.Host.sendTestNotification).mockRejectedValueOnce(
      new Error('Enable notifications for Statusky in System Settings.')
    )

    await fireEvent.click(getByText('Send test'))

    expect((await findByRole('alert')).textContent).toContain('System Settings')
  })
})

describe('the feed settings', () => {
  it('shows the current poll interval by its label', async () => {
    const { getByText } = await renderWith(
      SettingsPanel,
      {},
      {
        settings: { ...POLL_DEFAULTS, pollIntervalSec: 300 }
      }
    )
    expect(getByText('5 minutes')).toBeTruthy()
  })

  it('falls back to raw seconds for an interval that is not on the menu', async () => {
    const { getByText } = await renderWith(
      SettingsPanel,
      {},
      {
        settings: { ...POLL_DEFAULTS, pollIntervalSec: 47 }
      }
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
      {
        settings: { ...POLL_DEFAULTS, theme: 'dark' }
      }
    )
    expect(getByText('Dark')).toBeTruthy()
  })

  it('toggles launch at login', async () => {
    const { bridge, getByLabelText } = await renderWith(SettingsPanel)

    await fireEvent.click(getByLabelText('Launch at login'))

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ launchAtLogin: true })
  })
})

describe('the footer', () => {
  it('names the version and what the app reads', async () => {
    const { container } = await renderWith(SettingsPanel, {}, { version: '9.9.9' })
    expect(container.textContent).toContain('Statusky 9.9.9')
    expect(container.textContent).toContain('app.bsky.feed.post')
  })
})

/** Whole `Settings` objects, so a test only names the field it is exercising. */
const POLL_DEFAULTS = DEFAULT_SETTINGS

describe('the webhook section', () => {
  it('is part of the panel, and ticks its own relative timestamp', async () => {
    const { container } = await renderWith(
      SettingsPanel,
      { now: Date.parse('2026-03-01T12:00:00.000Z') },
      {
        settings: { ...DEFAULT_SETTINGS, webhookEnabled: true },
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
      { settings: { ...DEFAULT_SETTINGS, networkIntervalSec: 420 } }
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
      { settings: { ...DEFAULT_SETTINGS, networkChecks: false } }
    )
    expect(getByLabelText('How often to check the network').hasAttribute('disabled')).toBe(true)
  })

  it('says where confirmed outages go', async () => {
    const { container } = await renderWith(SettingsPanel)
    expect(container.textContent).toContain('filed in the feed as “Network checks”')
  })
})
