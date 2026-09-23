import { describe, expect, it, vi } from 'vitest'
import { fireEvent, within } from '@testing-library/svelte'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import {
  DEFAULT_PROBE_TARGETS,
  PROBE_TARGET_LIMITS,
  validateProbeTargets,
  type ProbeTargets
} from '@shared/probe-targets'
import type { Settings } from '@shared/types'
import type { BridgeOptions } from '../../../test/bridge'
import { makeProfile } from '../../../test/factories'
import { app } from '$lib/app-state.svelte'
import { pushState, renderWith, settle, type Rendered } from '../test/render'
import ProbeTargetsPanel from './ProbeTargetsPanel.svelte'
import SettingsPanel from './SettingsPanel.svelte'

const copy = (): ProbeTargets => structuredClone(DEFAULT_PROBE_TARGETS)

/** A document that is not the defaults: one account fewer. */
function customTargets(): ProbeTargets {
  const targets = copy()
  targets.accounts.pop()
  return targets
}

function settings(probeTargets: ProbeTargets | null): Settings {
  return { ...DEFAULT_SETTINGS, probeTargets }
}

async function renderPanel(probeTargets: ProbeTargets | null = null, options: BridgeOptions = {}) {
  return renderWith(ProbeTargetsPanel, {}, { settings: settings(probeTargets), ...options })
}

/** Open a section by its header, and return what it shows. */
async function expand(view: Rendered, label: string): Promise<HTMLElement> {
  await fireEvent.click(view.getByRole('button', { name: new RegExp(`^${label}`) }))
  return view.getByRole('group', { name: label })
}

async function type(input: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(input, { target: { value } })
}

/** Let a bridge call and the UI it updates settle. */
async function flush(): Promise<void> {
  await settle()
  await settle()
}

/** The last document sent to main, or undefined for none. */
function lastSent(view: { bridge: { api: { Preferences: { patch: unknown } } } }) {
  const calls = vi.mocked(
    view.bridge.api.Preferences.patch as (patch: Partial<Settings>) => Promise<Settings>
  ).mock.calls
  return calls.at(-1)?.[0]
}

/** The confirmation's list of changes, as `[section, change]` pairs. */
function changesIn(confirm: HTMLElement): [string, string][] {
  const terms = [...confirm.querySelectorAll('dt')]
  return terms.map((term) => [
    term.textContent!.trim(),
    term.nextElementSibling!.textContent!.trim()
  ])
}

function saveButton(view: Rendered): HTMLElement {
  return view.getByRole('button', { name: 'Save' })
}

describe('where the targets come from', () => {
  it('says the defaults are in force, and cannot reset to them', async () => {
    const view = await renderPanel()

    expect(view.getByText('Defaults')).toBeTruthy()
    expect(view.queryByText('Custom')).toBeNull()
    expect(
      (view.getByRole('button', { name: /Reset to defaults/ }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('says a custom set is in force', async () => {
    const view = await renderPanel(customTargets())

    expect(view.getByText('Custom')).toBeTruthy()
    expect(
      (view.getByRole('button', { name: /Reset to defaults/ }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  // The preview's fixture predates the setting, and so may an old store.
  it('reads a missing setting as the defaults', async () => {
    const view = await renderWith(
      ProbeTargetsPanel,
      {},
      { settings: { ...DEFAULT_SETTINGS, probeTargets: undefined as never } }
    )

    expect(view.getByText('Defaults')).toBeTruthy()
    expect(view.getByRole('button', { name: /^Accounts/ }).textContent).toContain('6 of 10')
  })

  it('explains what the targets are', async () => {
    const view = await renderPanel()
    expect(view.container.textContent).toContain(
      'The accounts and records the network checks ask about.'
    )
  })

  it('is part of the Settings panel', async () => {
    const view = await renderWith(SettingsPanel)
    expect(view.getByText('Check targets')).toBeTruthy()
  })

  it('opens and closes a section, counting each list against its limit', async () => {
    const view = await renderPanel()
    const header = view.getByRole('button', { name: /^CDN images/ })

    expect(header.textContent).toContain(`3 of ${PROBE_TARGET_LIMITS.cdnImages}`)
    expect(header.getAttribute('aria-expanded')).toBe('false')

    await fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByRole('group', { name: 'CDN images' })).toBeTruthy()

    await fireEvent.click(header)
    expect(view.queryByRole('group', { name: 'CDN images' })).toBeNull()
  })
})

describe('accounts', () => {
  it('adds one by handle, looking up its DID, and saves it', async () => {
    const view = await renderPanel(null, {
      resolves: makeProfile({ did: 'did:plc:added', handle: 'added.example.com' })
    })
    const accounts = await expand(view, 'Accounts')

    await type(within(accounts).getByLabelText('Account to add'), 'added.example.com')
    await fireEvent.click(within(accounts).getByRole('button', { name: 'Add account' }))
    await flush()

    expect(view.bridge.api.Actors.resolve).toHaveBeenCalledWith('added.example.com')
    expect(within(accounts).getByText('@added.example.com')).toBeTruthy()
    expect(within(accounts).getByText('did:plc:added')).toBeTruthy()
    expect(view.getByRole('button', { name: /^Accounts/ }).textContent).toContain('edited')
    expect((within(accounts).getByLabelText('Account to add') as HTMLInputElement).value).toBe('')
    // Nothing is sent until it is saved.
    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()

    await fireEvent.click(saveButton(view))
    await flush()

    expect(lastSent(view)?.probeTargets?.accounts.at(-1)).toEqual({
      did: 'did:plc:added',
      handle: 'added.example.com'
    })
    expect(view.getByText('Custom')).toBeTruthy()
    expect(view.getByRole('status').textContent).toContain('Saved.')
    expect(view.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('adds one by DID, looking up its handle', async () => {
    const view = await renderPanel(null, {
      resolves: makeProfile({ did: 'did:plc:bydid', handle: 'Mixed.Example.com' })
    })
    const accounts = await expand(view, 'Accounts')

    await type(within(accounts).getByLabelText('Account to add'), ' did:plc:bydid ')
    await fireEvent.submit(within(accounts).getByLabelText('Account to add').closest('form')!)
    await flush()

    expect(view.bridge.api.Actors.resolve).toHaveBeenCalledWith('did:plc:bydid')
    expect(within(accounts).getByText('@mixed.example.com')).toBeTruthy()
  })

  it('refuses an account that is already listed', async () => {
    const [first] = DEFAULT_PROBE_TARGETS.accounts
    const view = await renderPanel(null, { resolves: makeProfile(first) })
    const accounts = await expand(view, 'Accounts')

    await type(within(accounts).getByLabelText('Account to add'), first!.handle)
    await fireEvent.click(within(accounts).getByRole('button', { name: 'Add account' }))
    await flush()

    expect(within(accounts).getByRole('alert').textContent).toContain('already in the list')
    expect(view.getByRole('button', { name: /^Accounts/ }).textContent).toContain('6 of 10')
  })

  // `handle.invalid` passes as a domain name, and would fail the handle check forever.
  it('refuses an account whose handle does not verify', async () => {
    const view = await renderPanel(null, {
      resolves: makeProfile({ did: 'did:plc:broken', handle: 'handle.invalid' })
    })
    const accounts = await expand(view, 'Accounts')

    await type(within(accounts).getByLabelText('Account to add'), 'did:plc:broken')
    await fireEvent.click(within(accounts).getByRole('button', { name: 'Add account' }))
    await flush()

    expect(within(accounts).getByRole('alert').textContent).toContain('no handle that verifies')
  })

  it('shows a failed lookup beside the field, and nowhere else', async () => {
    const view = await renderPanel(null, { resolveError: 'Profile not found' })
    const accounts = await expand(view, 'Accounts')
    const input = within(accounts).getByLabelText('Account to add')

    await type(input, 'nobody.invalid')
    await fireEvent.click(within(accounts).getByRole('button', { name: 'Add account' }))
    await flush()

    expect(within(accounts).getByRole('alert').textContent).toBe('Profile not found')
    // The Accounts tab shows `actionError` under its own add field.
    expect(app.actionError).toBeNull()

    await type(input, 'nobody.invalid2')
    expect(within(accounts).queryByRole('alert')).toBeNull()
  })

  it('stops at the limit', async () => {
    const targets = copy()
    for (let n = targets.accounts.length; n < PROBE_TARGET_LIMITS.accounts; n++) {
      targets.accounts.push({ did: `did:plc:extra${n}`, handle: `extra${n}.example.com` })
    }
    const view = await renderPanel(targets)
    const accounts = await expand(view, 'Accounts')

    expect((within(accounts).getByLabelText('Account to add') as HTMLInputElement).disabled).toBe(
      true
    )
    expect(accounts.textContent).toContain('That is the most there can be.')
  })

  it('removes one', async () => {
    const view = await renderPanel()
    const accounts = await expand(view, 'Accounts')

    await fireEvent.click(within(accounts).getByRole('button', { name: 'Remove @pfrazee.com' }))
    expect(within(accounts).queryByText('@pfrazee.com')).toBeNull()

    await fireEvent.click(saveButton(view))
    await flush()
    expect(lastSent(view)?.probeTargets?.accounts).toHaveLength(5)
  })

  // The AppViews' freshness check compares newest posts, and needs somebody's.
  it('never removes the last one', async () => {
    const single = copy()
    single.accounts = single.accounts.slice(0, 1)
    const view = await renderPanel(single)
    const accounts = await expand(view, 'Accounts')

    expect(
      (within(accounts).getByRole('button', { name: /^Remove @/ }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('replaces one in place with another account', async () => {
    const view = await renderPanel(null, {
      resolves: makeProfile({ did: 'did:plc:replacement', handle: 'replacement.example.com' })
    })
    const accounts = await expand(view, 'Accounts')

    await fireEvent.click(within(accounts).getByRole('button', { name: 'Change @pfrazee.com' }))
    const input = within(accounts).getByLabelText('Replace @pfrazee.com with') as HTMLInputElement
    expect(input.value).toBe('pfrazee.com')

    await type(input, 'replacement.example.com')
    await fireEvent.click(within(accounts).getByRole('button', { name: 'Look it up and replace' }))
    await flush()

    await fireEvent.click(saveButton(view))
    await flush()
    expect(lastSent(view)?.probeTargets?.accounts[0]).toEqual({
      did: 'did:plc:replacement',
      handle: 'replacement.example.com'
    })
  })

  // Changing a row to the account it already is refreshes a renamed handle.
  it('lets a row resolve to itself, but not to another row', async () => {
    const [first, second] = DEFAULT_PROBE_TARGETS.accounts
    const view = await renderPanel(null, { resolves: makeProfile(second) })
    const accounts = await expand(view, 'Accounts')

    await fireEvent.click(
      within(accounts).getByRole('button', { name: `Change @${first!.handle}` })
    )
    await fireEvent.submit(
      within(accounts).getByLabelText(`Replace @${first!.handle} with`).closest('form')!
    )
    await flush()

    expect(within(accounts).getByRole('alert').textContent).toContain('already in the list')

    vi.mocked(view.bridge.api.Actors.resolve).mockResolvedValueOnce(
      makeProfile({ did: first!.did, handle: 'renamed.example.com' })
    )
    await fireEvent.submit(
      within(accounts).getByLabelText(`Replace @${first!.handle} with`).closest('form')!
    )
    await flush()

    expect(within(accounts).getByText('@renamed.example.com')).toBeTruthy()
  })

  it('keeps the account when a change is abandoned', async () => {
    const view = await renderPanel()
    const accounts = await expand(view, 'Accounts')

    await fireEvent.click(within(accounts).getByRole('button', { name: 'Change @pfrazee.com' }))
    await fireEvent.click(within(accounts).getByRole('button', { name: 'Keep this account' }))
    expect(within(accounts).getByText('@pfrazee.com')).toBeTruthy()

    await fireEvent.click(within(accounts).getByRole('button', { name: 'Change @pfrazee.com' }))
    await fireEvent.keyDown(within(accounts).getByLabelText('Replace @pfrazee.com with'), {
      key: 'Escape'
    })
    expect(within(accounts).queryByLabelText('Replace @pfrazee.com with')).toBeNull()
    expect(view.queryByRole('button', { name: 'Save' })).toBeNull()
  })
})

describe('accounts, at the edges', () => {
  it('looks nothing up for an empty field', async () => {
    const view = await renderPanel()
    const accounts = await expand(view, 'Accounts')

    await type(within(accounts).getByLabelText('Account to add'), '   ')
    await fireEvent.submit(within(accounts).getByLabelText('Account to add').closest('form')!)
    await fireEvent.click(within(accounts).getByRole('button', { name: 'Change @pfrazee.com' }))
    const replace = within(accounts).getByLabelText('Replace @pfrazee.com with')
    await type(replace, '')
    await fireEvent.submit(replace.closest('form')!)
    await flush()

    expect(view.bridge.api.Actors.resolve).not.toHaveBeenCalled()
  })

  // The lookup is somebody else's AppView. Whatever it says still has to pass the schema,
  // and whichever half does not, the row says so.
  it.each([
    ['handle', { did: 'did:plc:odd', handle: 'not a handle' }, /Must be a domain name/],
    ['DID', { did: 'not a did', handle: 'odd.example.com' }, /Must be a DID/]
  ])('says so beside the row when a looked-up %s would not pass', async (_half, profile, why) => {
    const view = await renderPanel(null, { resolves: makeProfile(profile) })
    const accounts = await expand(view, 'Accounts')

    await type(within(accounts).getByLabelText('Account to add'), 'odd')
    await fireEvent.click(within(accounts).getByRole('button', { name: 'Add account' }))
    await flush()
    await fireEvent.click(saveButton(view))
    await flush()

    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()
    expect(within(accounts).getByText(why)).toBeTruthy()
  })
})

describe('feeds and images', () => {
  it('adds a feed, holds its errors until it is saved, and sends it normalised', async () => {
    const view = await renderPanel()
    const feeds = await expand(view, 'Custom feeds')

    await fireEvent.click(within(feeds).getByRole('button', { name: /Add feed/ }))
    await settle()
    const added = within(feeds).getByRole('group', { name: 'Feed 2' })
    // Ready to type into, and blank, but not yet scolded for it.
    expect(document.activeElement).toBe(within(added).getByLabelText('Label'))
    expect(within(added).queryByText('Needs a label')).toBeNull()

    await fireEvent.click(saveButton(view))
    await flush()

    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()
    expect(within(added).getByText('Needs a label')).toBeTruthy()
    expect(within(added).getByText(/Must be a domain name/)).toBeTruthy()
    expect(within(added).getByText(/Must be the at:\/\/ URI/)).toBeTruthy()
    expect(within(added).getByLabelText('Host').getAttribute('aria-invalid')).toBe('true')
    expect(view.getByRole('alert').textContent).toContain('Fix 3 fields before saving.')
    expect(view.getByRole('button', { name: /^Custom feeds/ }).textContent).toContain('3 to fix')

    await type(within(added).getByLabelText('Label'), 'Example feed')
    await type(within(added).getByLabelText('Host'), 'Feed.Example.COM')
    await type(
      within(added).getByLabelText('Feed'),
      'at://did:plc:abc/app.bsky.feed.generator/example'
    )
    expect(within(added).queryByText('Needs a label')).toBeNull()

    await fireEvent.click(saveButton(view))
    await flush()

    expect(lastSent(view)?.probeTargets?.feeds[1]).toEqual({
      label: 'Example feed',
      host: 'feed.example.com',
      uri: 'at://did:plc:abc/app.bsky.feed.generator/example'
    })
  })

  it('shows a field’s error once it has been left', async () => {
    const view = await renderPanel()
    const feeds = await expand(view, 'Custom feeds')
    const host = within(within(feeds).getByRole('group', { name: 'Feed 1' })).getByLabelText('Host')

    await type(host, 'not a host')
    expect(within(feeds).queryByText(/Must be a domain name/)).toBeNull()

    await fireEvent.blur(host)
    expect(within(feeds).getByText(/Must be a domain name/)).toBeTruthy()
    expect(host.getAttribute('aria-describedby')).toBe('probe-target-feeds.0.host-error')
  })

  // One feed per host: a feed is a dashboard row, and a row is its generator's host.
  it('refuses a second feed on the same host, beside its host', async () => {
    const view = await renderPanel()
    const feeds = await expand(view, 'Custom feeds')

    await fireEvent.click(within(feeds).getByRole('button', { name: /Add feed/ }))
    const added = within(feeds).getByRole('group', { name: 'Feed 2' })
    await type(within(added).getByLabelText('Label'), 'Twin')
    await type(within(added).getByLabelText('Host'), DEFAULT_PROBE_TARGETS.feeds[0]!.host)
    await type(within(added).getByLabelText('Feed'), 'at://did:plc:abc/app.bsky.feed.generator/t')
    await fireEvent.click(saveButton(view))
    await flush()

    expect(within(added).getByText('Same host as entry 1')).toBeTruthy()
    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()
  })

  it('removes every feed, since none is required', async () => {
    const view = await renderPanel()
    const feeds = await expand(view, 'Custom feeds')

    await fireEvent.click(within(feeds).getByRole('button', { name: 'Remove Discover feed' }))
    expect(feeds.textContent).toContain('No custom feeds are checked.')

    await fireEvent.click(saveButton(view))
    await flush()
    expect(lastSent(view)?.probeTargets?.feeds).toEqual([])
  })

  it('stops adding feeds at the limit', async () => {
    const targets = copy()
    targets.feeds = Array.from({ length: PROBE_TARGET_LIMITS.feeds }, (_, n) => ({
      label: `Feed ${n}`,
      host: `feed${n}.example.com`,
      uri: `at://did:plc:abc/app.bsky.feed.generator/f${n}`
    }))
    const view = await renderPanel(targets)
    const feeds = await expand(view, 'Custom feeds')

    expect(
      (within(feeds).getByRole('button', { name: /Add feed/ }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('adds, edits and removes images', async () => {
    const view = await renderPanel()
    const images = await expand(view, 'CDN images')

    await fireEvent.click(within(images).getByRole('button', { name: /Add image/ }))
    await settle()
    const added = within(images).getByRole('group', { name: 'Image 4' })
    expect(document.activeElement).toBe(within(added).getByLabelText('DID'))
    await type(within(added).getByLabelText('DID'), 'did:plc:images')
    await type(within(added).getByLabelText('CID'), `bafkrei${'a'.repeat(30)}`)
    await fireEvent.click(within(images).getByRole('button', { name: 'Remove image 1' }))

    await fireEvent.click(saveButton(view))
    await flush()
    const sent = lastSent(view)?.probeTargets?.cdnImages
    expect(sent).toHaveLength(3)
    expect(sent?.at(-1)).toEqual({ did: 'did:plc:images', cid: `bafkrei${'a'.repeat(30)}` })
  })

  // A CDN row with nothing to fetch would never finish being checked.
  it('never removes the last image', async () => {
    const single = copy()
    single.cdnImages = single.cdnImages.slice(0, 1)
    const view = await renderPanel(single)
    const images = await expand(view, 'CDN images')

    expect(
      (within(images).getByRole('button', { name: 'Remove image 1' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('stops adding images at the limit', async () => {
    const targets = copy()
    while (targets.cdnImages.length < PROBE_TARGET_LIMITS.cdnImages) {
      targets.cdnImages.push({ ...targets.cdnImages[0]! })
    }
    const view = await renderPanel(targets)
    const images = await expand(view, 'CDN images')

    expect(
      (within(images).getByRole('button', { name: /Add image/ }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})

describe('single targets', () => {
  it('changes the For You feed, but not to something invalid', async () => {
    const view = await renderPanel()
    const forYou = await expand(view, 'For You')
    const feed = within(forYou).getByLabelText('Feed')

    await type(feed, 'https://bsky.app/profile/x/feed/for-you')
    await fireEvent.click(saveButton(view))
    await flush()

    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()
    expect(within(forYou).getByText(/Must be the at:\/\/ URI/)).toBeTruthy()
    expect(view.getByRole('alert').textContent).toContain('Fix one field before saving.')

    await type(feed, 'at://did:plc:abc/app.bsky.feed.generator/for-you-2')
    await type(within(forYou).getByLabelText('Service'), 'did:web:example.com')
    await fireEvent.click(saveButton(view))
    await flush()

    expect(lastSent(view)?.probeTargets?.forYou).toEqual({
      did: 'did:web:example.com',
      feed: 'at://did:plc:abc/app.bsky.feed.generator/for-you-2'
    })
  })

  it('changes Tangled’s repository', async () => {
    const view = await renderPanel()
    const tangled = await expand(view, 'Tangled')

    await type(within(tangled).getByLabelText('Page'), '/someone.example.com/project')
    await type(within(tangled).getByLabelText('Go path'), '/project?go-get=1')
    await type(within(tangled).getByLabelText('Repo DID'), 'did:plc:repo')
    await type(within(tangled).getByLabelText('Owner DID'), 'did:plc:owner')
    await fireEvent.click(saveButton(view))
    await flush()

    expect(lastSent(view)?.probeTargets?.tangled).toEqual({
      goGetPath: '/project?go-get=1',
      repoPath: '/someone.example.com/project',
      repoDid: 'did:plc:repo',
      ownerDid: 'did:plc:owner'
    })
  })

  it('changes Leaflet’s two records and Offprint’s publication', async () => {
    const view = await renderPanel()
    const leaflet = await expand(view, 'Leaflet')
    const document = within(leaflet).getByRole('group', { name: 'Document' })
    const feed = within(leaflet).getByRole('group', { name: 'Feed' })

    await type(within(document).getByLabelText('Record'), 'newdocument')
    await type(within(feed).getByLabelText('DID'), 'did:plc:busy')
    const offprint = await expand(view, 'Offprint')
    await type(
      within(offprint).getByLabelText('Publication'),
      'at://did:plc:abc/site.standard.publication/3mnew'
    )
    await fireEvent.click(saveButton(view))
    await flush()

    const apps = lastSent(view)?.probeTargets?.apps
    expect(apps?.leaflet.publication.rkey).toBe('newdocument')
    expect(apps?.leaflet.feed.did).toBe('did:plc:busy')
    expect(apps?.offprint.publication).toBe('at://did:plc:abc/site.standard.publication/3mnew')
  })

  it('opens every section with something to fix when a save is refused', async () => {
    const view = await renderPanel()
    const tangled = await expand(view, 'Tangled')
    await type(within(tangled).getByLabelText('Repo DID'), 'nope')
    await fireEvent.click(view.getByRole('button', { name: /^Tangled/ }))
    expect(view.queryByRole('group', { name: 'Tangled' })).toBeNull()

    await fireEvent.click(saveButton(view))
    await flush()

    expect(view.getByRole('group', { name: 'Tangled' })).toBeTruthy()
    expect(view.getByText('Must be a DID, such as did:plc:…')).toBeTruthy()
  })
})

describe('the working copy', () => {
  it('discards edits', async () => {
    const view = await renderPanel()
    const tangled = await expand(view, 'Tangled')
    const page = within(tangled).getByLabelText('Page') as HTMLInputElement

    await type(page, '/someone.example.com/elsewhere')
    expect(view.getByText('Unsaved changes to the check targets.')).toBeTruthy()

    await fireEvent.click(view.getByRole('button', { name: 'Discard' }))

    expect(page.value).toBe(DEFAULT_PROBE_TARGETS.tangled.repoPath)
    expect(view.queryByText('Unsaved changes to the check targets.')).toBeNull()
  })

  it('follows a change made elsewhere while nothing is being edited', async () => {
    const view = await renderPanel()
    await pushState(view.bridge, { settings: settings(customTargets()) })

    expect(view.getByText('Custom')).toBeTruthy()
    expect(view.getByRole('button', { name: /^Accounts/ }).textContent).toContain('5 of 10')
    expect(view.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('keeps edits in progress when the saved targets change underneath', async () => {
    const view = await renderPanel()
    const tangled = await expand(view, 'Tangled')
    await type(within(tangled).getByLabelText('Page'), '/someone.example.com/elsewhere')

    await pushState(view.bridge, { settings: settings(customTargets()) })

    expect((within(tangled).getByLabelText('Page') as HTMLInputElement).value).toBe(
      '/someone.example.com/elsewhere'
    )
    expect(view.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('says why main refused a save', async () => {
    const view = await renderPanel()
    vi.mocked(view.bridge.api.Preferences.patch).mockRejectedValueOnce(new Error('Disk full'))
    const tangled = await expand(view, 'Tangled')
    await type(within(tangled).getByLabelText('Page'), '/someone.example.com/elsewhere')

    await fireEvent.click(saveButton(view))
    await flush()

    expect(view.getByRole('alert').textContent).toContain('Disk full')
    expect(view.getByRole('button', { name: 'Save' })).toBeTruthy()
  })
})

describe('resetting', () => {
  it('says what going back to the defaults changes, and does it once confirmed', async () => {
    const view = await renderPanel(customTargets())

    await fireEvent.click(view.getByRole('button', { name: /Reset to defaults/ }))
    const confirm = view.getByRole('group', { name: 'Reset to defaults' })
    expect(confirm.textContent).toContain('Going back to the defaults changes:')
    expect(changesIn(confirm)).toEqual([['Accounts', '1 added, now 6']])
    expect(confirm.textContent).toContain('Unchanged: Custom feeds, For You')
    expect(confirm.textContent).toContain('Export it first')

    await fireEvent.click(within(confirm).getByRole('button', { name: 'Reset' }))
    await flush()

    expect(lastSent(view)).toEqual({ probeTargets: null })
    expect(view.getByText('Defaults')).toBeTruthy()
    expect(view.getByRole('status').textContent).toContain('Back on the defaults.')
  })

  it('does nothing when cancelled', async () => {
    const view = await renderPanel(customTargets())

    await fireEvent.click(view.getByRole('button', { name: /Reset to defaults/ }))
    await fireEvent.click(view.getByRole('button', { name: 'Cancel' }))

    expect(view.queryByRole('group', { name: 'Reset to defaults' })).toBeNull()
    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()
  })

  it('warns that unsaved edits go with it', async () => {
    const view = await renderPanel(customTargets())
    const tangled = await expand(view, 'Tangled')
    await type(within(tangled).getByLabelText('Page'), '/someone.example.com/elsewhere')

    await fireEvent.click(view.getByRole('button', { name: /Reset to defaults/ }))

    expect(view.getByRole('group', { name: 'Reset to defaults' }).textContent).toContain(
      'Your unsaved edits below are dropped.'
    )
  })

  it('says why main refused it', async () => {
    const view = await renderPanel(customTargets())
    vi.mocked(view.bridge.api.Preferences.patch).mockRejectedValueOnce(new Error('Disk full'))

    await fireEvent.click(view.getByRole('button', { name: /Reset to defaults/ }))
    await fireEvent.click(view.getByRole('button', { name: 'Reset' }))
    await flush()

    expect(view.getByRole('alert').textContent).toContain('Disk full')
    expect(view.getByText('Custom')).toBeTruthy()
  })
})

describe('importing', () => {
  it('rejects pasted text that is not JSON, and changes nothing', async () => {
    const view = await renderPanel()

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await type(view.getByLabelText('Targets to import'), '{ nope')
    await fireEvent.click(view.getByRole('button', { name: 'Check' }))

    const alert = view.getByRole('alert')
    expect(alert.textContent).toContain('The pasted text can’t be used, so nothing was changed.')
    expect(alert.textContent).toContain('It is not JSON.')
    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()

    // Typing again clears it.
    await type(view.getByLabelText('Targets to import'), '{ nope }')
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('lists what is wrong with a document from a file, field by field', async () => {
    const doc = copy() as unknown as { accounts: { did: string }[]; tangled?: unknown }
    doc.accounts[2]!.did = 'nonsense'
    delete doc.tangled
    const view = await renderPanel(null, {
      openedFile: { name: 'broken.json', text: JSON.stringify(doc) }
    })

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await fireEvent.click(view.getByRole('button', { name: 'Choose file…' }))
    await flush()

    const alert = view.getByRole('alert')
    expect(alert.textContent).toContain('broken.json can’t be used, so nothing was changed.')
    expect(alert.textContent).toContain('accounts[2].did: Must be a DID')
    expect(alert.textContent).toContain('tangled:')
    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()
  })

  it('sums up a long list of problems', async () => {
    const doc = copy()
    for (const account of doc.accounts) account.did = 'nonsense'
    for (const image of doc.cdnImages) image.cid = 'nonsense'
    const validation = validateProbeTargets(doc)
    const total = validation.ok ? 0 : validation.issues.length
    expect(total).toBeGreaterThan(6)
    const view = await renderPanel(null, {
      openedFile: { name: 'broken.json', text: JSON.stringify(doc) }
    })

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await fireEvent.click(view.getByRole('button', { name: 'Choose file…' }))
    await flush()

    const alert = view.getByRole('alert')
    expect(alert.querySelectorAll('li')).toHaveLength(6)
    expect(alert.textContent).toContain(`And ${total - 6} more.`)
  })

  it('shows what a valid file changes, and applies it once confirmed', async () => {
    const doc = copy()
    doc.accounts.push({ did: 'did:plc:imported', handle: 'imported.example.com' })
    doc.tangled.repoPath = '/someone.example.com/project'
    const view = await renderPanel(null, {
      openedFile: { name: 'mine.json', text: JSON.stringify(doc, null, 2) }
    })

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await fireEvent.click(view.getByRole('button', { name: 'Choose file…' }))
    await flush()

    const confirm = view.getByRole('group', { name: 'Import' })
    expect(confirm.textContent).toContain('Importing mine.json changes:')
    expect(changesIn(confirm)).toEqual([
      ['Accounts', '1 added, now 7'],
      ['Tangled', 'changed']
    ])
    expect(confirm.textContent).toContain(
      'Unchanged: Custom feeds, For You, CDN images, Leaflet, Offprint.'
    )
    // Nothing is sent before it is confirmed.
    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()

    await fireEvent.click(within(confirm).getByRole('button', { name: 'Replace targets' }))
    await flush()

    expect(lastSent(view)).toEqual({ probeTargets: doc })
    expect(view.getByText('Custom')).toBeTruthy()
    expect(view.getByRole('status').textContent).toContain('Imported mine.json.')
    expect(view.queryByRole('group', { name: 'Import' })).toBeNull()
  })

  it('lists nothing as unchanged when everything changes', async () => {
    const doc = customTargets()
    doc.feeds = []
    doc.forYou.did = 'did:web:elsewhere.example.com'
    doc.cdnImages = doc.cdnImages.slice(1)
    doc.tangled.ownerDid = 'did:plc:owner'
    doc.apps.leaflet.feed.rkey = 'elsewhere'
    doc.apps.offprint.publication = 'at://did:plc:abc/site.standard.publication/3mnew'
    const view = await renderPanel(null, {
      openedFile: { name: 'all.json', text: JSON.stringify(doc) }
    })

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await fireEvent.click(view.getByRole('button', { name: 'Choose file…' }))
    await flush()

    const confirm = view.getByRole('group', { name: 'Import' })
    expect(changesIn(confirm)).toHaveLength(7)
    expect(confirm.textContent).not.toContain('Unchanged')
  })

  it('applies a pasted document', async () => {
    const view = await renderPanel()

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await type(view.getByLabelText('Targets to import'), JSON.stringify(customTargets()))
    await fireEvent.click(view.getByRole('button', { name: 'Check' }))
    expect(view.getByRole('group', { name: 'Import' }).textContent).toContain(
      'Importing the pasted text changes:'
    )

    await fireEvent.click(view.getByRole('button', { name: 'Replace targets' }))
    await flush()

    expect(lastSent(view)).toEqual({ probeTargets: customTargets() })
    expect(view.getByRole('status').textContent).toBe('Imported. The next check uses them.')
  })

  it('says so when a document is the one already in force', async () => {
    const view = await renderPanel(null, {
      openedFile: { name: 'same.json', text: JSON.stringify(DEFAULT_PROBE_TARGETS) }
    })

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await fireEvent.click(view.getByRole('button', { name: 'Choose file…' }))
    await flush()

    expect(view.getByText(/already in force, so there is nothing to change/)).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Replace targets' })).toBeNull()

    await fireEvent.click(view.getByRole('button', { name: 'Close' }))
    expect(view.queryByRole('group', { name: 'Import' })).toBeNull()
  })

  it('does nothing when the file dialog is cancelled, or the import is', async () => {
    const view = await renderPanel()

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await fireEvent.click(view.getByRole('button', { name: 'Choose file…' }))
    await flush()

    expect(view.bridge.api.ProbeTargetsFile.open).toHaveBeenCalled()
    expect(view.queryByRole('alert')).toBeNull()

    await fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(view.queryByRole('group', { name: 'Import' })).toBeNull()
    expect(view.bridge.api.Preferences.patch).not.toHaveBeenCalled()
  })

  it('says why a file could not be read', async () => {
    const view = await renderPanel()
    vi.mocked(view.bridge.api.ProbeTargetsFile.open).mockRejectedValueOnce(
      new Error('Could not read huge.json: it is far too large to be a list of check targets.')
    )

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await fireEvent.click(view.getByRole('button', { name: 'Choose file…' }))
    await flush()

    expect(view.getByRole('alert').textContent).toContain('Could not read huge.json')
  })

  it('says why main refused an import', async () => {
    const view = await renderPanel()
    vi.mocked(view.bridge.api.Preferences.patch).mockRejectedValueOnce(new Error('Disk full'))

    await fireEvent.click(view.getByRole('button', { name: /Import/ }))
    await type(view.getByLabelText('Targets to import'), JSON.stringify(customTargets()))
    await fireEvent.click(view.getByRole('button', { name: 'Check' }))
    await fireEvent.click(view.getByRole('button', { name: 'Replace targets' }))
    await flush()

    expect(view.getByRole('alert').textContent).toContain('Disk full')
    expect(view.getByText('Defaults')).toBeTruthy()
  })
})

describe('exporting', () => {
  it('saves through main and says where', async () => {
    const view = await renderPanel()

    await fireEvent.click(view.getByRole('button', { name: /Export/ }))
    await flush()

    expect(view.bridge.api.ProbeTargetsFile.save).toHaveBeenCalledTimes(1)
    expect(view.getByRole('status').textContent).toBe('Exported to statusky-probe-targets.json.')
  })

  // An export is of what is in force, which an import of it would put back.
  it('says unsaved edits are not in it', async () => {
    const view = await renderPanel()
    const tangled = await expand(view, 'Tangled')
    await type(within(tangled).getByLabelText('Page'), '/someone.example.com/elsewhere')

    await fireEvent.click(view.getByRole('button', { name: /Export/ }))
    await flush()

    expect(view.getByRole('status').textContent).toContain('Your unsaved edits are not in it.')
  })

  it('says nothing when the dialog is cancelled', async () => {
    const view = await renderPanel()
    vi.mocked(view.bridge.api.ProbeTargetsFile.save).mockResolvedValueOnce(null)

    await fireEvent.click(view.getByRole('button', { name: /Export/ }))
    await flush()

    expect(view.queryByRole('status')).toBeNull()
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('says why it failed', async () => {
    const view = await renderPanel()
    vi.mocked(view.bridge.api.ProbeTargetsFile.save).mockRejectedValueOnce(
      new Error('Could not save x.json: EACCES: permission denied')
    )

    await fireEvent.click(view.getByRole('button', { name: /Export/ }))
    await flush()

    expect(view.getByRole('alert').textContent).toContain('permission denied')
  })
})
