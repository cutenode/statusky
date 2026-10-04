<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { app } from '$lib/app-state.svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  let value = $state('')
  let submitting = $state(false)
  /**
   * Why the last account could not be added. This form's own, from its own request: a
   * sentence here is about what was typed here, and nothing else the popover does can
   * put one here or take it away.
   */
  let error = $state<string | null>(null)

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const input = value.trim()
    if (!input || submitting) return

    submitting = true
    const outcome = await app.addAccount(input)
    submitting = false
    if (outcome.ok) value = ''
    else error = outcome.error
  }
</script>

<form onsubmit={submit} class="flex flex-col gap-1.5">
  <!-- Named for a screen reader; the heading above already says it to everyone else. -->
  <label for="add-account" class="sr-only">Account to track</label>
  <div class="flex gap-1.5">
    <Input
      id="add-account"
      bind:value
      class="selectable"
      placeholder="handle, DID, or bsky.app profile link"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck={false}
      disabled={submitting}
      aria-invalid={error ? true : undefined}
      aria-describedby="add-account-note"
      oninput={() => (error = null)}
    />
    <Button type="submit" size="icon" disabled={!value.trim() || submitting} title="Track account">
      {#if submitting}
        <LoaderCircle class="size-4 animate-spin" />
      {:else}
        <Plus class="size-4" />
      {/if}
    </Button>
  </div>

  {#if error}
    <p id="add-account-note" class="px-0.5 text-[11.5px] text-destructive" role="alert">{error}</p>
  {:else}
    <p id="add-account-note" class="px-0.5 text-[11px] text-muted-foreground">
      Any AT Protocol account works — its <code class="font-mono text-[10.5px]"
        >app.bsky.feed.post</code
      > records show up in your feed.
    </p>
  {/if}
</form>
