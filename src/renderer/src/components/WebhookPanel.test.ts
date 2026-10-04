import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { makeSettings, makeWebhookStatus } from '../../../test/factories'
import { pushState, renderWith, settle } from '../test/render'
import WebhookPanel from './WebhookPanel.svelte'

const NOW = Date.parse('2026-03-01T12:00:00.000Z')
const URL = 'http://127.0.0.1:7385/webhook/s3cr3t'

const LISTENING = makeWebhookStatus({ state: 'listening', url: URL, port: 7385 })

/** Rendered copy, with the line breaks the markup happens to contain flattened out. */
function text(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ')
}

function on(webhook = LISTENING) {
  return {
    settings: makeSettings({ webhookEnabled: true }),
    webhook
  }
}

describe('the switch', () => {
  it('is off by default and says nothing more', async () => {
    const { getByLabelText, queryByLabelText, container } = await renderWith(
      WebhookPanel,
      { now: NOW },
      { settings: DEFAULT_SETTINGS }
    )

    expect(getByLabelText('Enable the webhook receiver').getAttribute('aria-checked')).toBe('false')
    expect(queryByLabelText('Webhook endpoint URL')).toBeNull()
    expect(queryByLabelText('Webhook port')).toBeNull()
    expect(text(container)).not.toContain('Listening')
  })

  it('turns the receiver on', async () => {
    const { bridge, getByLabelText } = await renderWith(
      WebhookPanel,
      { now: NOW },
      { settings: DEFAULT_SETTINGS }
    )

    await fireEvent.click(getByLabelText('Enable the webhook receiver'))

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ webhookEnabled: true })
  })

  it('turns it off again', async () => {
    const { bridge, getByLabelText } = await renderWith(WebhookPanel, { now: NOW }, on())

    await fireEvent.click(getByLabelText('Enable the webhook receiver'))

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ webhookEnabled: false })
  })
})

describe('the endpoint', () => {
  it('shows the URL a status page should be given, and the port it is on', async () => {
    const { getByLabelText, container } = await renderWith(WebhookPanel, { now: NOW }, on())

    expect((getByLabelText('Webhook endpoint URL') as HTMLInputElement).value).toBe(URL)
    expect(text(container)).toContain('Listening on port 7385.')
  })

  it('says the endpoint only answers locally, which is the part that surprises people', async () => {
    const { container } = await renderWith(WebhookPanel, { now: NOW }, on())

    expect(text(container)).toContain('only answers on this machine')
    expect(text(container)).toContain('tunnel pointed at port 7385')
  })

  it('copies the URL through main, and says so', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, getByText, container } = await renderWith(WebhookPanel, { now: NOW }, on())

      await fireEvent.click(getByText('Copy'))
      await settle()

      expect(bridge.api.Host.copyText).toHaveBeenCalledWith(URL)
      expect(text(container)).toContain('Copied')
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes back to offering a copy after a moment', async () => {
    vi.useFakeTimers()
    try {
      const { getByText, container } = await renderWith(WebhookPanel, { now: NOW }, on())
      await fireEvent.click(getByText('Copy'))
      await settle()
      expect(text(container)).toContain('Copied')

      await vi.advanceTimersByTimeAsync(2500)

      expect(text(container)).not.toContain('Copied')
    } finally {
      vi.useRealTimers()
    }
  })

  // "Copied" is the only evidence a copy leaves, so it is said only of one that worked.
  it('says why a copy failed, rather than that it was copied', async () => {
    const { bridge, getByText, getByRole, container } = await renderWith(
      WebhookPanel,
      { now: NOW },
      on()
    )
    vi.mocked(bridge.api.Host.copyText).mockRejectedValueOnce(new Error('The clipboard is busy'))

    await fireEvent.click(getByText('Copy'))
    await settle()

    expect(text(container)).not.toContain('Copied')
    expect(getByRole('alert').textContent).toContain('The clipboard is busy')
  })

  it('selects the whole URL on focus, so it can be copied by hand too', async () => {
    const { getByLabelText } = await renderWith(WebhookPanel, { now: NOW }, on())
    const input = getByLabelText('Webhook endpoint URL') as HTMLInputElement

    await fireEvent.focus(input)

    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(URL.length)
  })

  it('mints a new secret on request', async () => {
    const { bridge, getByText } = await renderWith(WebhookPanel, { now: NOW }, on())

    await fireEvent.click(getByText('New secret'))

    expect(bridge.api.Webhook.regenerateSecret).toHaveBeenCalled()
  })

  it('says why a new secret could not be minted', async () => {
    const { bridge, getByText, getByRole } = await renderWith(WebhookPanel, { now: NOW }, on())
    vi.mocked(bridge.api.Webhook.regenerateSecret).mockRejectedValueOnce(
      new Error('The receiver is restarting')
    )

    await fireEvent.click(getByText('New secret'))
    await settle()

    expect(getByRole('alert').textContent).toContain('The receiver is restarting')
  })

  it('links to the page a subscription is set up on', async () => {
    const { bridge, getByText } = await renderWith(WebhookPanel, { now: NOW }, on())

    await fireEvent.click(getByText('status.bsky.app/subscribe/webhook'))

    expect(bridge.api.Host.openExternal).toHaveBeenCalledWith(
      'https://status.bsky.app/subscribe/webhook'
    )
  })
})

describe('what has actually arrived', () => {
  it('says so plainly when nothing has', async () => {
    const { container } = await renderWith(WebhookPanel, { now: NOW }, on())

    expect(text(container)).toContain('No deliveries yet.')
  })

  it('counts one delivery in the singular', async () => {
    const { container } = await renderWith(
      WebhookPanel,
      { now: NOW },
      on(makeWebhookStatus({ ...LISTENING, deliveries: 1 }))
    )

    expect(text(container)).toContain('1 delivery since launch.')
  })

  it('counts several, and says when the last one came in', async () => {
    const { container } = await renderWith(
      WebhookPanel,
      { now: NOW },
      on(
        makeWebhookStatus({
          ...LISTENING,
          deliveries: 12,
          lastDeliveryAt: '2026-03-01T11:55:00.000Z'
        })
      )
    )

    expect(text(container)).toContain('12 deliveries since launch, last 5 minutes ago.')
  })
})

describe('when it cannot listen', () => {
  it('shows the reason instead of pretending to be on', async () => {
    const { container, queryByLabelText } = await renderWith(
      WebhookPanel,
      { now: NOW },
      on(makeWebhookStatus({ state: 'error', error: 'Port 7385 is already in use.' }))
    )

    expect(text(container)).toContain('Port 7385 is already in use.')
    expect(queryByLabelText('Webhook endpoint URL')).toBeNull()
  })

  it('falls back to a sentence when the receiver failed without one', async () => {
    const { container } = await renderWith(
      WebhookPanel,
      { now: NOW },
      on(makeWebhookStatus({ state: 'error' }))
    )

    expect(text(container)).toContain('The receiver could not start.')
  })

  it('says it is starting while the socket is still being bound', async () => {
    const { container } = await renderWith(
      WebhookPanel,
      { now: NOW },
      on(makeWebhookStatus({ state: 'off' }))
    )

    expect(text(container)).toContain('Starting…')
  })

  it('tracks the receiver as main pushes new state', async () => {
    const { bridge, container } = await renderWith(WebhookPanel, { now: NOW }, on())

    await pushState(bridge, {
      webhook: makeWebhookStatus({ state: 'error', error: 'Port 7385 is already in use.' })
    })

    expect(text(container)).toContain('Port 7385 is already in use.')
  })
})

describe('the port', () => {
  it('shows the one in settings', async () => {
    const { getByLabelText } = await renderWith(WebhookPanel, { now: NOW }, on())

    expect((getByLabelText('Webhook port') as HTMLInputElement).value).toBe('7385')
  })

  it('commits a new one on change', async () => {
    const { bridge, getByLabelText } = await renderWith(WebhookPanel, { now: NOW }, on())
    const input = getByLabelText('Webhook port') as HTMLInputElement

    input.value = '8080'
    await fireEvent.change(input)

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ webhookPort: 8080 })
  })

  it('does not rebind the socket when the value has not actually changed', async () => {
    const { bridge, getByLabelText } = await renderWith(WebhookPanel, { now: NOW }, on())
    const input = getByLabelText('Webhook port') as HTMLInputElement

    input.value = '7385'
    await fireEvent.change(input)

    expect(bridge.api.Preferences.patch).not.toHaveBeenCalled()
  })

  // A number input reads back as '' for anything that is not a number, which is
  // also what it holds halfway through an edit.
  it.each(['', '0', '-80'])('ignores %j, which is no port at all', async (value) => {
    const { bridge, getByLabelText } = await renderWith(WebhookPanel, { now: NOW }, on())
    const input = getByLabelText('Webhook port') as HTMLInputElement

    input.value = value
    await fireEvent.change(input)

    expect(bridge.api.Preferences.patch).not.toHaveBeenCalled()
  })

  it('commits on Enter rather than making the user click away', async () => {
    const { bridge, getByLabelText } = await renderWith(WebhookPanel, { now: NOW }, on())
    const input = getByLabelText('Webhook port') as HTMLInputElement
    input.value = '9000'

    await fireEvent.keyDown(input, { key: 'Enter' })

    expect(bridge.api.Preferences.patch).toHaveBeenCalledWith({ webhookPort: 9000 })
  })

  // Main keeps the port where it can bind one. The setting not moving left the typed
  // number in the box, saying a port nothing was listening on.
  it('shows the port main settled on, not the one typed', async () => {
    const { bridge, getByLabelText } = await renderWith(
      WebhookPanel,
      { now: NOW },
      { ...on(), settings: makeSettings({ webhookEnabled: true, webhookPort: 1024 }) }
    )
    // What main does with a port below the range it binds: it raises it to the floor,
    // which here is the port already in force, so the setting does not move.
    vi.mocked(bridge.api.Preferences.patch).mockImplementationOnce(async () => {
      bridge.push({ settings: bridge.state.settings })
      return bridge.state.settings
    })
    const input = getByLabelText('Webhook port') as HTMLInputElement

    input.value = '80'
    await fireEvent.change(input)
    await settle()

    expect(input.value).toBe('1024')
  })

  it('puts the port back, and says why, when main refuses it', async () => {
    const { bridge, getByLabelText, getByRole } = await renderWith(WebhookPanel, { now: NOW }, on())
    vi.mocked(bridge.api.Preferences.patch).mockRejectedValueOnce(new Error('Port 8080 is taken'))
    const input = getByLabelText('Webhook port') as HTMLInputElement

    input.value = '8080'
    await fireEvent.change(input)
    await settle()

    expect(input.value).toBe('7385')
    expect(getByRole('alert').textContent).toContain('Port 8080 is taken')
  })

  it('says why the receiver could not be switched on', async () => {
    const { bridge, getByLabelText, getByRole } = await renderWith(WebhookPanel, { now: NOW })
    vi.mocked(bridge.api.Preferences.patch).mockRejectedValueOnce(new Error('Not on this network'))

    await fireEvent.click(getByLabelText('Enable the webhook receiver'))
    await settle()

    expect(getByRole('alert').textContent).toContain('Not on this network')
    expect(getByLabelText('Enable the webhook receiver').getAttribute('aria-checked')).toBe('false')
  })

  it('leaves other keys to the input', async () => {
    const { bridge, getByLabelText } = await renderWith(WebhookPanel, { now: NOW }, on())
    const input = getByLabelText('Webhook port') as HTMLInputElement
    input.value = '9000'

    await fireEvent.keyDown(input, { key: '0' })

    expect(bridge.api.Preferences.patch).not.toHaveBeenCalled()
  })
})
