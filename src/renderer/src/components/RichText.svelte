<script lang="ts">
  import { app } from '$lib/app-state.svelte'
  import type { RichSegment } from '@shared/types'

  let { segments, text }: { segments: RichSegment[]; text: string } = $props()

  /** Fall back to the raw text if facet segmentation produced nothing. */
  const parts = $derived(segments.length ? segments : ([{ kind: 'text', text }] as RichSegment[]))

  function open(event: MouseEvent, url: string): void {
    event.preventDefault()
    event.stopPropagation()
    app.openExternal(url)
  }
</script>

<p class="selectable text-[13px] leading-[1.55] break-words whitespace-pre-wrap text-foreground/90">
  {#each parts as part, i (i)}
    {#if part.kind === 'link'}
      <a
        href={part.uri}
        title={part.uri}
        class="rounded-sm text-primary decoration-primary/40 underline-offset-2 hover:underline"
        onclick={(e) => open(e, part.uri)}>{part.text}</a
      >
    {:else if part.kind === 'mention'}
      <a
        href={`https://bsky.app/profile/${part.did}`}
        class="rounded-sm text-primary hover:underline"
        onclick={(e) => open(e, `https://bsky.app/profile/${part.did}`)}>{part.text}</a
      >
    {:else if part.kind === 'tag'}
      <a
        href={`https://bsky.app/hashtag/${part.tag}`}
        class="rounded-sm text-primary hover:underline"
        onclick={(e) => open(e, `https://bsky.app/hashtag/${part.tag}`)}>{part.text}</a
      >
    {:else}{part.text}{/if}
  {/each}
</p>
