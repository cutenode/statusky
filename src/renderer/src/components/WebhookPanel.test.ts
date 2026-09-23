import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { makeSettings, makeWebhookStatus } from '../../../test/factories'
import { pushState, renderWith } from '../test/render'
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

      await vi.advanceTimersByTimeAsync(2500)

      expect(text(container)).not.toContain('Copied')
    } finally {
      vi.useRealTimers()
    }
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

  it('leaves other keys to the input', async () => {
    const { bridge, getByLabelText } = await renderWith(WebhookPanel, { now: NOW }, on())
    const input = getByLabelText('Webhook port') as HTMLInputElement
    input.value = '9000'

    await fireEvent.keyDown(input, { key: '0' })

    expect(bridge.api.Preferences.patch).not.toHaveBeenCalled()
  })
})
