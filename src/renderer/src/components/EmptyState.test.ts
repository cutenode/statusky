import { describe, expect, it } from 'vitest'
import { createRawSnippet } from 'svelte'
import Inbox from '@lucide/svelte/icons/inbox'
import { renderWith } from '../test/render'
import EmptyState from './EmptyState.svelte'

describe('EmptyState', () => {
  it('shows the icon, title and description', async () => {
    const { container, getByText } = await renderWith(EmptyState, {
      icon: Inbox,
      title: 'No updates yet',
      description: 'Statusky is fetching posts.'
    })

    expect(getByText('No updates yet')).toBeTruthy()
    expect(getByText('Statusky is fetching posts.')).toBeTruthy()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('renders an action when one is given', async () => {
    const action = createRawSnippet(() => ({
      render: () => '<button type="button">Add an account</button>'
    }))
    const { getByRole } = await renderWith(EmptyState, {
      icon: Inbox,
      title: 'Nothing here',
      description: 'Add an account to get started.',
      action
    })

    expect(getByRole('button', { name: 'Add an account' })).toBeTruthy()
  })

  it('renders nothing extra when no action snippet is given', async () => {
    const { container } = await renderWith(EmptyState, {
      icon: Inbox,
      title: 'Title',
      description: 'Description'
    })

    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
