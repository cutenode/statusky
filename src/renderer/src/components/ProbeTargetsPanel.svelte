<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { app } from '$lib/app-state.svelte'
  import {
    compareProbeTargets,
    issuesByPath,
    pathKey,
    readProbeTargets,
    sectionOf,
    SECTIONS,
    type SectionChange,
    type SectionKey,
    type TargetPath
  } from '$lib/probe-targets'
  import { cn } from '$lib/utils'
  import {
    DEFAULT_PROBE_TARGETS,
    effectiveProbeTargets,
    PROBE_TARGET_LIMITS,
    sameProbeTargets,
    validateProbeTargets,
    type ProbeAccount,
    type ProbeTargetIssue,
    type ProbeTargets
  } from '@shared/probe-targets'
  import Check from '@lucide/svelte/icons/check'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Download from '@lucide/svelte/icons/download'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Plus from '@lucide/svelte/icons/plus'
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import Upload from '@lucide/svelte/icons/upload'
  import X from '@lucide/svelte/icons/x'
  import { tick, untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'

  /**
   * The check targets editor: the accounts and records the network checks read, which
   * belong to other people and go stale when they delete or change them.
   *
   * Edits collect in a working copy and are saved together, never field by field. Each
   * save moves every check onto the new targets and measures again, so a document half
   * way through an edit — a DID changed and its handle not yet — would be measured, and
   * look like an outage. The copy is checked with `validateProbeTargets` on every
   * change, and only a valid one is ever sent: the IPC boundary refuses an invalid one
   * too, but with a sentence about the whole patch rather than one beside each field.
   *
   * An import and a reset replace the whole document, so both say what they would change
   * and wait to be confirmed. Export writes what is in force, not the working copy: the
   * file is exactly what an import of it would put back.
   */

  /** What the checks read now: the saved override, or the checked-in defaults. */
  const saved = $derived(effectiveProbeTargets(app.settings.probeTargets))
  /** A missing value is the preview fixture, which predates the setting: the defaults. */
  const custom = $derived(app.settings.probeTargets != null)

  const copy = (targets: ProbeTargets): ProbeTargets => structuredClone(targets)

  let draft = $state(copy(effectiveProbeTargets(app.settings.probeTargets)))
  /** The saved document the working copy was last taken from, to tell edits from pushes. */
  let base = effectiveProbeTargets(app.settings.probeTargets)

  const current = $derived($state.snapshot(draft) as ProbeTargets)
  const validation = $derived(validateProbeTargets(current))
  const dirty = $derived(!sameProbeTargets(current, saved))
  /** Which sections the working copy has changed, for the headers to say so. */
  const edited = $derived(
    new Set(
      compareProbeTargets(saved, current)
        .filter((section) => section.change)
        .map((section) => section.key)
    )
  )

  /**
   * Fields the user has been into and left, and whether they have tried to save.
   *
   * A field nobody has reached yet is not told off for being empty: an added feed is
   * three blank fields, and three red sentences under them before anything is typed
   * would be scolding the user for pressing the button. There are no issues about a
   * whole list to show: the add and remove buttons stop at each list's limits.
   */
  const touched = new SvelteSet<string>()
  let attempted = $state(false)

  const shown = $derived(
    validation.ok
      ? []
      : validation.issues.filter(
          (issue: ProbeTargetIssue) => attempted || touched.has(pathKey(issue.path))
        )
  )
  const fieldIssues = $derived(issuesByPath(shown))

  const expanded = new SvelteSet<SectionKey>()

  function problemsIn(key: SectionKey): number {
    return shown.filter((issue) => sectionOf(issue.path) === key).length
  }

  // ------------------------------------------------------------ status line

  type Notice = { kind: 'done' | 'error'; text: string }
  let notice = $state<Notice | null>(null)
  /** What is waiting on main, so its button can say so and the others hold still. */
  let busy = $state<'export' | 'open' | 'save' | 'apply' | null>(null)

  /** Put the working copy back to what is saved, forgetting edits and errors alike. */
  function reset(next: ProbeTargets): void {
    base = next
    draft = copy(next)
    attempted = false
    touched.clear()
    editing = null
    editError = null
    addError = null
  }

  // Follow what is saved when it changes underneath — an import, a reset, this panel's
  // own save — unless there are edits in progress that the change did not come from.
  $effect.pre(() => {
    const next = saved
    untrack(() => {
      if (sameProbeTargets(next, base)) return
      if (sameProbeTargets(current, base)) reset(next)
      else base = next
    })
  })

  // ------------------------------------------------------------- fields

  type Node = Record<string | number, unknown>

  function read(path: TargetPath): string {
    let node: unknown = draft
    for (const key of path) node = (node as Node)[key]
    return node as string
  }

  function write(path: TargetPath, value: string): void {
    let node = draft as unknown as Node
    for (const key of path.slice(0, -1)) node = node[key] as Node
    node[path.at(-1)!] = value
    notice = null
  }

  function toggle(key: SectionKey): void {
    if (expanded.has(key)) expanded.delete(key)
    else expanded.add(key)
  }

  async function focusField(path: TargetPath): Promise<void> {
    await tick()
    document.getElementById(`probe-target-${pathKey(path)}`)?.focus()
  }

  function addFeed(): void {
    draft.feeds.push({ label: '', host: '', uri: '' })
    void focusField(['feeds', draft.feeds.length - 1, 'label'])
  }

  function addImage(): void {
    draft.cdnImages.push({ did: '', cid: '' })
    void focusField(['cdnImages', draft.cdnImages.length - 1, 'did'])
  }

  // ----------------------------------------------------------- accounts

  let addValue = $state('')
  let addError = $state<string | null>(null)
  /** The account being replaced, by index, and what it is being replaced with. */
  let editing = $state<number | null>(null)
  let editValue = $state('')
  let editError = $state<string | null>(null)
  let editInput = $state<HTMLInputElement | null>(null)
  /** Which lookup is in flight: the add field, or the row being changed. */
  let looking = $state<'add' | number | null>(null)

  const accountsFull = $derived(draft.accounts.length >= PROBE_TARGET_LIMITS.accounts)

  /**
   * Both halves of an account from either one, or why it cannot be listed.
   *
   * Goes through main, which answers from the same AppView lookup that tracking a
   * status account uses. An account whose handle does not verify comes back as
   * `handle.invalid`, which is a real domain name as far as the schema can tell and a
   * handle check that could never pass, so it is refused here. `replacing` is the row
   * being changed, which may of course resolve to itself.
   */
  async function lookUp(input: string, replacing: number | null): Promise<ProbeAccount | string> {
    const outcome = await app.lookUpActor(input)
    if (!outcome.ok) return outcome.error
    const did = outcome.value.did
    const handle = outcome.value.handle.toLowerCase()
    if (handle === 'handle.invalid') {
      return `${did} has no handle that verifies, so its handle check could never pass.`
    }
    const clash = draft.accounts.findIndex(
      (account, index) => index !== replacing && (account.did === did || account.handle === handle)
    )
    if (clash !== -1) return `@${handle} is already in the list.`
    return { did, handle }
  }

  async function addAccount(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const input = addValue.trim()
    if (!input || looking !== null || accountsFull) return
    looking = 'add'
    const result = await lookUp(input, null)
    looking = null
    if (typeof result === 'string') {
      addError = result
      return
    }
    draft.accounts.push(result)
    addValue = ''
    notice = null
  }

  async function startEdit(index: number): Promise<void> {
    editing = index
    editValue = draft.accounts[index]!.handle
    editError = null
    await tick()
    editInput?.select()
  }

  function cancelEdit(): void {
    editing = null
    editError = null
  }

  async function replaceAccount(event: SubmitEvent, index: number): Promise<void> {
    event.preventDefault()
    const input = editValue.trim()
    if (!input || looking !== null) return
    looking = index
    const result = await lookUp(input, index)
    looking = null
    if (typeof result === 'string') {
      editError = result
      return
    }
    draft.accounts[index] = result
    cancelEdit()
    notice = null
  }

  // --------------------------------------------------------------- save

  async function save(): Promise<void> {
    attempted = true
    notice = null
    const result = validateProbeTargets(current)
    if (!result.ok) {
      // Open every section with something to fix, since a closed one hides where it is.
      for (const issue of result.issues) {
        const key = sectionOf(issue.path)
        if (key) expanded.add(key)
      }
      return
    }
    busy = 'save'
    const outcome = await app.setProbeTargets(result.targets)
    busy = null
    if (!outcome.ok) {
      notice = { kind: 'error', text: outcome.error }
      return
    }
    reset(effectiveProbeTargets(outcome.value.probeTargets))
    notice = { kind: 'done', text: 'Saved. The next check uses them.' }
  }

  function discard(): void {
    reset(saved)
    notice = null
  }

  // ---------------------------------------------------- export and import

  async function exportTargets(): Promise<void> {
    notice = null
    busy = 'export'
    const outcome = await app.exportProbeTargets()
    busy = null
    if (!outcome.ok) notice = { kind: 'error', text: outcome.error }
    else if (outcome.value) {
      const unsaved = dirty ? ' Your unsaved edits are not in it.' : ''
      notice = { kind: 'done', text: `Exported to ${outcome.value}.${unsaved}` }
    }
  }

  /** A document waiting to replace the one in force: an import, or the defaults. */
  interface Pending {
    kind: 'import' | 'reset'
    /** Where it came from, to say so: a file's name, or null for pasted text. */
    from: string | null
    /** What to save: the document, or null for the defaults. */
    targets: ProbeTargets | null
    changes: SectionChange[]
  }

  let importing = $state(false)
  let pasted = $state('')
  // Raw, because both are only ever replaced whole — and `pending.targets` is sent to main
  // as it is, where a deep state proxy would fail to cross: Electron clones what it sends.
  /** Why the last file or paste could not be imported, one line per issue. */
  let problems = $state.raw<{ from: string; lines: string[] } | null>(null)
  let pending = $state.raw<Pending | null>(null)

  /** How many problems to list before summing up the rest. */
  const PROBLEM_LINES = 6

  function startImport(): void {
    notice = null
    pending = null
    problems = null
    pasted = ''
    importing = true
  }

  function closeImport(): void {
    importing = false
    pending = null
    problems = null
  }

  function check(text: string, from: string | null): void {
    const result = readProbeTargets(text)
    if (!result.ok) {
      problems = { from: from ?? 'The pasted text', lines: result.problems }
      return
    }
    problems = null
    pending = {
      kind: 'import',
      from,
      targets: result.targets,
      changes: compareProbeTargets(saved, result.targets)
    }
  }

  async function chooseFile(): Promise<void> {
    problems = null
    busy = 'open'
    const outcome = await app.openProbeTargetsFile()
    busy = null
    if (!outcome.ok) problems = { from: 'The file', lines: [outcome.error] }
    else if (outcome.value) check(outcome.value.text, outcome.value.name)
  }

  function startReset(): void {
    notice = null
    importing = false
    problems = null
    pending = {
      kind: 'reset',
      from: null,
      targets: null,
      changes: compareProbeTargets(saved, DEFAULT_PROBE_TARGETS)
    }
  }

  async function apply({ kind, from, targets }: Pending): Promise<void> {
    busy = 'apply'
    const outcome = await app.setProbeTargets(targets)
    busy = null
    if (!outcome.ok) {
      notice = { kind: 'error', text: outcome.error }
      return
    }
    closeImport()
    reset(effectiveProbeTargets(outcome.value.probeTargets))
    notice = {
      kind: 'done',
      text:
        kind === 'reset'
          ? 'Back on the defaults.'
          : `Imported${from ? ` ${from}` : ''}. The next check uses them.`
    }
  }

  // ----------------------------------------------------------- sections

  const HINTS: Record<SectionKey, string> = {
    accounts: 'Every AppView is asked for each one’s profile, handle and newest posts.',
    feeds: 'Each is asked for one post, from its own host, and gets a row of its own.',
    forYou: 'A feed the AppViews serve, and the service its generator record names.',
    cdnImages: 'The CDN is asked for the start of each image.',
    tangled: 'One repository: its page, its Go import path and its DID.',
    leaflet: 'A published document, and a busy publication whose feed shows it is current.',
    offprint: 'The publication its well-known route answers with.'
  }

  function countOf(key: SectionKey): string | null {
    if (key === 'accounts') return `${draft.accounts.length} of ${PROBE_TARGET_LIMITS.accounts}`
    if (key === 'feeds') return `${draft.feeds.length} of ${PROBE_TARGET_LIMITS.feeds}`
    if (key === 'cdnImages') {
      return `${draft.cdnImages.length} of ${PROBE_TARGET_LIMITS.cdnImages}`
    }
    return null
  }

  const inputClass = 'h-7 px-2 font-mono text-[11px]'
</script>

{#snippet field(label: string, path: TargetPath, placeholder: string)}
  {@const key = pathKey(path)}
  {@const id = `probe-target-${key}`}
  {@const error = fieldIssues.get(key)}
  <div class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5">
    <label for={id} class="text-[11px] text-muted-foreground">{label}</label>
    <Input
      {id}
      class={inputClass}
      value={read(path)}
      {placeholder}
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      oninput={(event) => write(path, event.currentTarget.value)}
      onblur={() => touched.add(key)}
    />
    {#if error}
      <p id="{id}-error" class="col-start-2 text-[10.5px] leading-snug text-destructive">
        {error}
      </p>
    {/if}
  </div>
{/snippet}

{#snippet removeButton(name: string, onremove: () => void, keep?: string)}
  <!-- `keep` says why this one cannot go, when it cannot: it is the last its list may lose. -->
  <Button
    variant="ghost"
    size="icon-sm"
    class="size-6 text-muted-foreground"
    aria-label={`Remove ${name}`}
    title={keep ?? `Remove ${name}`}
    disabled={keep !== undefined}
    onclick={onremove}
  >
    <X class="size-3.5" />
  </Button>
{/snippet}

{#snippet accountsBody()}
  <ul class="divide-y divide-border/60 rounded-md border border-border/70">
    {#each draft.accounts as account, index (index)}
      {@const didIssue = fieldIssues.get(pathKey(['accounts', index, 'did']))}
      {@const handleIssue = fieldIssues.get(pathKey(['accounts', index, 'handle']))}
      <li class="px-2.5 py-1.5">
        {#if editing === index}
          <form
            class="flex items-center gap-1.5"
            onsubmit={(event) => replaceAccount(event, index)}
          >
            <Input
              bind:ref={editInput}
              bind:value={editValue}
              class="h-7 px-2 text-[12px]"
              aria-label={`Replace @${account.handle} with`}
              placeholder="handle or DID"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              disabled={looking === index}
              oninput={() => (editError = null)}
              onkeydown={(event) => event.key === 'Escape' && cancelEdit()}
            />
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              aria-label="Look it up and replace"
              disabled={!editValue.trim() || looking !== null}
            >
              {#if looking === index}
                <LoaderCircle class="size-3.5 animate-spin" />
              {:else}
                <Check class="size-3.5" />
              {/if}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Keep this account"
              onclick={cancelEdit}
            >
              <X class="size-3.5" />
            </Button>
          </form>
          {#if editError}
            <p class="pt-1 text-[10.5px] leading-snug text-destructive" role="alert">{editError}</p>
          {/if}
        {:else}
          <div class="flex items-center gap-1">
            <div class="min-w-0 flex-1">
              <p class="truncate text-[12px] font-medium">@{account.handle}</p>
              <p class="truncate font-mono text-[10.5px] text-muted-foreground" title={account.did}>
                {account.did}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-6 text-muted-foreground"
              aria-label={`Change @${account.handle}`}
              title="Replace with another account"
              disabled={looking !== null}
              onclick={() => void startEdit(index)}
            >
              <Pencil class="size-3" />
            </Button>
            {@render removeButton(
              `@${account.handle}`,
              () => draft.accounts.splice(index, 1),
              draft.accounts.length <= 1 ? 'The checks need at least one account' : undefined
            )}
          </div>
          {#if didIssue || handleIssue}
            <p class="pt-1 text-[10.5px] leading-snug text-destructive">
              {handleIssue ?? didIssue}
            </p>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>

  <form class="mt-1.5 flex gap-1.5" onsubmit={addAccount}>
    <Input
      bind:value={addValue}
      class="h-7 px-2 text-[12px]"
      placeholder="handle or DID"
      aria-label="Account to add"
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      disabled={accountsFull || looking === 'add'}
      oninput={() => (addError = null)}
    />
    <Button
      type="submit"
      variant="outline"
      size="icon-sm"
      aria-label="Add account"
      title="Add account"
      disabled={!addValue.trim() || accountsFull || looking !== null}
    >
      {#if looking === 'add'}
        <LoaderCircle class="size-3.5 animate-spin" />
      {:else}
        <Plus class="size-3.5" />
      {/if}
    </Button>
  </form>
  {#if addError}
    <p class="px-0.5 pt-1 text-[10.5px] leading-snug text-destructive" role="alert">{addError}</p>
  {:else}
    <p class="px-0.5 pt-1 text-[10.5px] leading-snug text-muted-foreground">
      {accountsFull
        ? `That is the most there can be. Remove one to add another.`
        : 'Enter either half; the other is looked up.'}
    </p>
  {/if}
{/snippet}

{#snippet feedsBody()}
  <div class="space-y-1.5">
    {#each draft.feeds as feed, index (index)}
      <div
        class="relative space-y-1 rounded-md border border-border/70 py-2 pr-9 pl-2"
        role="group"
        aria-label={`Feed ${index + 1}`}
      >
        <div class="absolute top-2.5 right-1.5">
          {@render removeButton(feed.label || `feed ${index + 1}`, () =>
            draft.feeds.splice(index, 1)
          )}
        </div>
        {@render field('Label', ['feeds', index, 'label'], 'Discover feed')}
        {@render field('Host', ['feeds', index, 'host'], 'feed.example.com')}
        {@render field('Feed', ['feeds', index, 'uri'], 'at://did:plc:…/app.bsky.feed.generator/…')}
      </div>
    {:else}
      <p class="px-0.5 text-[11px] text-muted-foreground">No custom feeds are checked.</p>
    {/each}
  </div>
  <Button
    variant="ghost"
    size="sm"
    class="mt-1 text-muted-foreground"
    disabled={draft.feeds.length >= PROBE_TARGET_LIMITS.feeds}
    title={draft.feeds.length >= PROBE_TARGET_LIMITS.feeds
      ? `At most ${PROBE_TARGET_LIMITS.feeds} feeds`
      : undefined}
    onclick={addFeed}
  >
    <Plus class="size-3.5" />
    Add feed
  </Button>
{/snippet}

{#snippet imagesBody()}
  <div class="space-y-1.5">
    {#each draft.cdnImages, index (index)}
      <div
        class="relative space-y-1 rounded-md border border-border/70 py-2 pr-9 pl-2"
        role="group"
        aria-label={`Image ${index + 1}`}
      >
        <div class="absolute top-2.5 right-1.5">
          {@render removeButton(
            `image ${index + 1}`,
            () => draft.cdnImages.splice(index, 1),
            draft.cdnImages.length <= 1 ? 'The CDN check needs at least one image' : undefined
          )}
        </div>
        {@render field('DID', ['cdnImages', index, 'did'], 'did:plc:…')}
        {@render field('CID', ['cdnImages', index, 'cid'], 'bafkrei…')}
      </div>
    {/each}
  </div>
  <Button
    variant="ghost"
    size="sm"
    class="mt-1 text-muted-foreground"
    disabled={draft.cdnImages.length >= PROBE_TARGET_LIMITS.cdnImages}
    title={draft.cdnImages.length >= PROBE_TARGET_LIMITS.cdnImages
      ? `At most ${PROBE_TARGET_LIMITS.cdnImages} images`
      : undefined}
    onclick={addImage}
  >
    <Plus class="size-3.5" />
    Add image
  </Button>
{/snippet}

{#snippet forYouBody()}
  <div class="space-y-1">
    {@render field('Feed', ['forYou', 'feed'], 'at://did:plc:…/app.bsky.feed.generator/…')}
    {@render field('Service', ['forYou', 'did'], 'did:web:…')}
  </div>
{/snippet}

{#snippet tangledBody()}
  <div class="space-y-1">
    {@render field('Page', ['tangled', 'repoPath'], '/owner.handle/repository')}
    {@render field('Go path', ['tangled', 'goGetPath'], '/repository?go-get=1')}
    {@render field('Repo DID', ['tangled', 'repoDid'], 'did:plc:…')}
    {@render field('Owner DID', ['tangled', 'ownerDid'], 'did:plc:…')}
  </div>
{/snippet}

{#snippet leafletBody()}
  <div class="space-y-1.5">
    {#each [{ key: 'publication', title: 'Document' }, { key: 'feed', title: 'Feed' }] as record (record.key)}
      <div class="space-y-1" role="group" aria-label={record.title}>
        <p class="text-[11px] font-medium">{record.title}</p>
        {@render field('DID', ['apps', 'leaflet', record.key, 'did'], 'did:plc:…')}
        {@render field('Record', ['apps', 'leaflet', record.key, 'rkey'], 'record key')}
      </div>
    {/each}
  </div>
{/snippet}

{#snippet offprintBody()}
  {@render field(
    'Publication',
    ['apps', 'offprint', 'publication'],
    'at://did:plc:…/site.standard.publication/…'
  )}
{/snippet}

{#snippet sectionBody(key: SectionKey)}
  {#if key === 'accounts'}
    {@render accountsBody()}
  {:else if key === 'feeds'}
    {@render feedsBody()}
  {:else if key === 'forYou'}
    {@render forYouBody()}
  {:else if key === 'cdnImages'}
    {@render imagesBody()}
  {:else if key === 'tangled'}
    {@render tangledBody()}
  {:else if key === 'leaflet'}
    {@render leafletBody()}
  {:else}
    {@render offprintBody()}
  {/if}
{/snippet}

<section>
  <h2 class="mb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
    Check targets
  </h2>

  <div class="flex items-center justify-between gap-4 py-2">
    <div class="min-w-0">
      <p class="text-[12.5px] font-medium">What the checks read</p>
      <p class="text-[11px] leading-snug text-muted-foreground">
        The accounts and records the network checks ask about. They go stale when their owners
        delete or change them.
      </p>
    </div>
    {#if custom}
      <Badge variant="secondary" title="You have replaced the built-in targets">Custom</Badge>
    {:else}
      <Badge variant="outline" title="The targets Statusky ships with">Defaults</Badge>
    {/if}
  </div>

  <div class="flex items-center gap-1.5 pb-1">
    <Button
      variant="outline"
      size="sm"
      disabled={busy !== null}
      onclick={() => void exportTargets()}
    >
      {#if busy === 'export'}
        <LoaderCircle class="size-3.5 animate-spin" />
      {:else}
        <Download class="size-3.5" />
      {/if}
      Export…
    </Button>
    <Button variant="outline" size="sm" disabled={busy !== null} onclick={startImport}>
      <Upload class="size-3.5" />
      Import…
    </Button>
    <Button
      variant="ghost"
      size="sm"
      class="ml-auto text-muted-foreground"
      disabled={!custom || busy !== null}
      title={custom ? undefined : 'Already on the defaults'}
      onclick={startReset}
    >
      <RotateCcw class="size-3.5" />
      Reset to defaults
    </Button>
  </div>

  {#if notice}
    <p
      class={cn(
        'px-0.5 pb-1 text-[11px] leading-snug',
        notice.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'
      )}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {notice.text}
    </p>
  {/if}

  {#if pending}
    {@const confirming = pending}
    {@const doing =
      pending.kind === 'import'
        ? `Importing ${pending.from ?? 'the pasted text'}`
        : 'Going back to the defaults'}
    {@const changed = pending.changes.filter((section) => section.change)}
    {@const same = pending.changes.filter((section) => !section.change)}
    <div
      class="mt-1 mb-2 space-y-1.5 rounded-md border border-border/70 bg-muted/40 p-2.5"
      role="group"
      aria-label={pending.kind === 'reset' ? 'Reset to defaults' : 'Import'}
    >
      {#if changed.length}
        <p class="text-[11.5px] font-medium">{doing} changes:</p>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          {#each changed as section (section.key)}
            <dt class="font-medium">{section.label}</dt>
            <dd class="text-muted-foreground">{section.change}</dd>
          {/each}
        </dl>
        {#if same.length}
          <p class="text-[11px] leading-snug text-muted-foreground">
            Unchanged: {same.map((section) => section.label).join(', ')}.
          </p>
        {/if}
        {#if pending.kind === 'reset'}
          <p class="text-[11px] leading-snug text-muted-foreground">
            Your own set is not kept anywhere else. Export it first to keep a copy.
          </p>
        {/if}
        {#if dirty}
          <p class="text-[11px] leading-snug text-muted-foreground">
            Your unsaved edits below are dropped.
          </p>
        {/if}
      {:else}
        <p class="text-[11.5px] leading-snug">
          These are the targets already in force, so there is nothing to change.
        </p>
      {/if}
      <div class="flex justify-end gap-1.5 pt-0.5">
        <Button variant="ghost" size="sm" onclick={closeImport}>
          {changed.length ? 'Cancel' : 'Close'}
        </Button>
        {#if changed.length}
          <Button size="sm" disabled={busy !== null} onclick={() => void apply(confirming)}>
            {#if busy === 'apply'}
              <LoaderCircle class="size-3.5 animate-spin" />
            {/if}
            {pending.kind === 'reset' ? 'Reset' : 'Replace targets'}
          </Button>
        {/if}
      </div>
    </div>
  {:else if importing}
    <div
      class="mt-1 mb-2 space-y-1.5 rounded-md border border-border/70 bg-muted/40 p-2.5"
      role="group"
      aria-label="Import"
    >
      <p class="text-[11px] leading-snug text-muted-foreground">
        Replace every target with a document exported from Statusky. Nothing changes until you
        confirm.
      </p>
      <textarea
        bind:value={pasted}
        rows="3"
        class="selectable flex w-full min-w-0 resize-none rounded-md border border-input bg-background/60 px-2 py-1.5 font-mono text-[11px] shadow-xs outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/40"
        placeholder="Paste JSON here, or choose a file."
        aria-label="Targets to import"
        spellcheck="false"
        oninput={() => (problems = null)}></textarea>
      <div class="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onclick={() => void chooseFile()}
        >
          {#if busy === 'open'}
            <LoaderCircle class="size-3.5 animate-spin" />
          {/if}
          Choose file…
        </Button>
        <Button variant="ghost" size="sm" class="ml-auto" onclick={closeImport}>Cancel</Button>
        <Button size="sm" disabled={!pasted.trim()} onclick={() => check(pasted, null)}>
          Check
        </Button>
      </div>
      {#if problems}
        <div class="space-y-0.5" role="alert">
          <p class="text-[11px] font-medium text-destructive">
            {problems.from} can’t be used, so nothing was changed.
          </p>
          <ul class="list-disc space-y-0.5 pl-4 text-[10.5px] leading-snug text-destructive">
            {#each problems.lines.slice(0, PROBLEM_LINES) as line, index (index)}
              <li class="selectable font-mono break-words">{line}</li>
            {/each}
          </ul>
          {#if problems.lines.length > PROBLEM_LINES}
            <p class="text-[10.5px] text-destructive">
              And {problems.lines.length - PROBLEM_LINES} more.
            </p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <div class="divide-y divide-border/60">
    {#each SECTIONS as section (section.key)}
      {@const open = expanded.has(section.key)}
      {@const count = countOf(section.key)}
      {@const issues = problemsIn(section.key)}
      <div>
        <button
          type="button"
          class="flex w-full items-center gap-1.5 py-2 text-left"
          aria-expanded={open}
          aria-controls={`probe-section-${section.key}`}
          onclick={() => toggle(section.key)}
        >
          <ChevronRight
            class={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
          <span class="text-[12.5px] font-medium">{section.label}</span>
          {#if issues}
            <span class="text-[10.5px] text-destructive">{issues} to fix</span>
          {:else if edited.has(section.key)}
            <span class="text-[10.5px] text-primary">edited</span>
          {/if}
          {#if count}
            <span class="ml-auto text-[11px] text-muted-foreground tabular-nums">{count}</span>
          {/if}
        </button>
        {#if open}
          <div
            id={`probe-section-${section.key}`}
            class="pb-2.5 pl-5"
            role="group"
            aria-label={section.label}
          >
            <p class="pb-1.5 text-[11px] leading-snug text-muted-foreground">
              {HINTS[section.key]}
            </p>
            {@render sectionBody(section.key)}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <!--
    Sticky to the bottom of the Settings scroll area, so Save is in reach from anywhere
    in a long edit — and only while this section is on screen, since it lives inside it.
    The negative offset is that area's own bottom padding, which a sticky box otherwise
    keeps clear of, leaving a strip of content scrolling past underneath.
  -->
  {#if dirty}
    {@const failing = attempted && !validation.ok}
    {@const count = validation.ok ? 0 : validation.issues.length}
    <div
      class="sticky -bottom-4 z-10 -mx-3 mt-2 flex items-center gap-2 border-t border-border/70 bg-background/40 px-3 py-2 backdrop-blur-md"
    >
      <p
        class={cn(
          'min-w-0 flex-1 text-[11px] leading-snug',
          failing ? 'text-destructive' : 'text-muted-foreground'
        )}
        role={failing ? 'alert' : undefined}
      >
        {failing
          ? `Fix ${count === 1 ? 'one field' : `${count} fields`} before saving.`
          : 'Unsaved changes to the check targets.'}
      </p>
      <Button variant="ghost" size="sm" onclick={discard}>Discard</Button>
      <Button size="sm" disabled={busy !== null} onclick={() => void save()}>
        {#if busy === 'save'}
          <LoaderCircle class="size-3.5 animate-spin" />
        {/if}
        Save
      </Button>
    </div>
  {/if}
</section>
