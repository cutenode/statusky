import { describe, expect, it } from 'vitest'
import { fireEvent } from '@testing-library/svelte'
import { makeProfile } from '../../../test/factories'

/** A promise a test can settle by hand, to hold an action in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}
import { renderWith } from '../test/render'
import AddAccountForm from './AddAccountForm.svelte'

describe('AddAccountForm', () => {
  it('explains what it accepts', async () => {
    const { getByPlaceholderText, container } = await renderWith(AddAccountForm)

    expect(getByPlaceholderText('handle, DID, or bsky.app profile link')).toBeTruthy()
    expect(container.textContent).toContain('app.bsky.feed.post')
  })

  it('disables submit until something is typed', async () => {
    const { getByTitle, getByPlaceholderText } = await renderWith(AddAccountForm)
    const submit = getByTitle('Track account') as HTMLButtonElement

    expect(submit.disabled).toBe(true)

    await fireEvent.input(getByPlaceholderText('handle, DID, or bsky.app profile link'), {
      target: { value: 'status.example.test' }
    })

    expect(submit.disabled).toBe(false)
  })

  it('stays disabled for whitespace alone', async () => {
    const { getByTitle, getByPlaceholderText } = await renderWith(AddAccountForm)

    await fireEvent.input(getByPlaceholderText('handle, DID, or bsky.app profile link'), {
      target: { value: '   ' }
    })

    expect((getByTitle('Track account') as HTMLButtonElement).disabled).toBe(true)
  })

  it('submits the trimmed input and clears the field on success', async () => {
    const { bridge, container, getByPlaceholderText } = await renderWith(
      AddAccountForm,
      {},
      {
        resolves: makeProfile({ handle: 'status.example.test' })
      }
    )
    const input = getByPlaceholderText('handle, DID, or bsky.app profile link') as HTMLInputElement

    await fireEvent.input(input, { target: { value: '  status.example.test  ' } })
    await fireEvent.submit(container.querySelector('form')!)

    expect(bridge.api.Accounts.add).toHaveBeenCalledWith('status.example.test')
    expect(input.value).toBe('')
  })

  it('keeps the input and shows the error when the account cannot be resolved', async () => {
    const { container, getByPlaceholderText, findByText } = await renderWith(
      AddAccountForm,
      {},
      { resolveError: 'Profile not found' }
    )
    const input = getByPlaceholderText('handle, DID, or bsky.app profile link') as HTMLInputElement

    await fireEvent.input(input, { target: { value: 'nobody.invalid' } })
    await fireEvent.submit(container.querySelector('form')!)

    expect(await findByText('Profile not found')).toBeTruthy()
    expect(input.value).toBe('nobody.invalid')
  })

  it('clears a stale error as soon as the user types again', async () => {
    const { container, getByPlaceholderText, queryByText, findByText } = await renderWith(
      AddAccountForm,
      {},
      { resolveError: 'Profile not found' }
    )
    const input = getByPlaceholderText('handle, DID, or bsky.app profile link')

    await fireEvent.input(input, { target: { value: 'nobody.invalid' } })
    await fireEvent.submit(container.querySelector('form')!)
    expect(await findByText('Profile not found')).toBeTruthy()

    await fireEvent.input(input, { target: { value: 'nobody.invalid2' } })

    expect(queryByText('Profile not found')).toBeNull()
  })

  it('does nothing when submitted empty', async () => {
    const { bridge, container } = await renderWith(AddAccountForm)

    await fireEvent.submit(container.querySelector('form')!)

    expect(bridge.api.Accounts.add).not.toHaveBeenCalled()
  })

  it('does not reload the page on submit', async () => {
    const { container } = await renderWith(AddAccountForm)
    const event = new Event('submit', { bubbles: true, cancelable: true })

    await fireEvent(container.querySelector('form')!, event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores a second submit while the first is in flight', async () => {
    const { bridge, container, getByPlaceholderText } = await renderWith(AddAccountForm)
    const pending = deferred<{ ok: true; value: never }>()
    bridge.api.Accounts.add = (() => pending.promise) as never

    await fireEvent.input(getByPlaceholderText('handle, DID, or bsky.app profile link'), {
      target: { value: 'status.example.test' }
    })

    const form = container.querySelector('form')!
    void fireEvent.submit(form)
    await fireEvent.submit(form)

    expect(container.querySelector('.animate-spin')).not.toBeNull()
    pending.resolve({ ok: true, value: null as never })
  })
})
