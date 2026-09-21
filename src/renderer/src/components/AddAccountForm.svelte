<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { app } from '$lib/app-state.svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  let value = $state('')
  let submitting = $state(false)

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const input = value.trim()
    if (!input || submitting) return

    submitting = true
    const account = await app.addAccount(input)
    submitting = false
    if (account) value = ''
  }
</script>

<form onsubmit={submit} class="flex flex-col gap-1.5">
  <div class="flex gap-1.5">
    <Input
      bind:value
      class="selectable"
      placeholder="handle, DID, or bsky.app profile link"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck={false}
      disabled={submitting}
      oninput={() => app.clearError()}
    />
    <Button type="submit" size="icon" disabled={!value.trim() || submitting} title="Track account">
      {#if submitting}
        <LoaderCircle class="size-4 animate-spin" />
      {:else}
        <Plus class="size-4" />
      {/if}
    </Button>
  </div>

  {#if app.actionError}
    <p class="px-0.5 text-[11.5px] text-destructive">{app.actionError}</p>
  {:else}
    <p class="px-0.5 text-[11px] text-muted-foreground">
      Any AT Protocol account works — its <code class="font-mono text-[10.5px]"
        >app.bsky.feed.post</code
      > records show up in your feed.
    </p>
  {/if}
</form>
