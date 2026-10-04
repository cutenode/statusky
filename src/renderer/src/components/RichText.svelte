<script lang="ts">
  import { app } from '$lib/app-state.svelte'
  import type { RichSegment } from '@shared/types'

  let { segments, text }: { segments: RichSegment[]; text: string } = $props()

  /** Fall back to the raw text if facet segmentation produced nothing. */
  const parts = $derived<RichSegment[]>(segments.length ? segments : [{ kind: 'text', text }])

  function open(event: MouseEvent, url: string): void {
    event.preventDefault()
    event.stopPropagation()
    app.openExternal(url)
  }

  /**
   * A middle click opens the link the way a left click does, and never the way a browser
   * would. Left to Chromium it is "open in a new tab", which in Electron is a popup
   * request that skips `onclick` entirely and goes straight to main with whatever the
   * `href` says — so it is taken here and sent down the same path as any other click.
   * Any other button is only stopped from doing what a browser does with it.
   */
  function auxOpen(event: MouseEvent, url: string): void {
    if (event.button === 1) open(event, url)
    else event.preventDefault()
  }
</script>

<!--
  `draggable="false"` on every link for the same reason: a link dragged out of the popover
  is a URL dropped on whatever is under the cursor, outside anything this app can check.
-->
<p class="selectable text-[13px] leading-[1.55] break-words whitespace-pre-wrap text-foreground/90">
  {#each parts as part, i (i)}
    {#if part.kind === 'link'}
      <a
        href={part.uri}
        title={part.uri}
        draggable="false"
        class="rounded-sm text-primary decoration-primary/40 underline-offset-2 hover:underline"
        onclick={(e) => open(e, part.uri)}
        onauxclick={(e) => auxOpen(e, part.uri)}>{part.text}</a
      >
    {:else if part.kind === 'mention'}
      <a
        href={`https://bsky.app/profile/${part.did}`}
        draggable="false"
        class="rounded-sm text-primary hover:underline"
        onclick={(e) => open(e, `https://bsky.app/profile/${part.did}`)}
        onauxclick={(e) => auxOpen(e, `https://bsky.app/profile/${part.did}`)}>{part.text}</a
      >
    {:else if part.kind === 'tag'}
      <a
        href={`https://bsky.app/hashtag/${part.tag}`}
        draggable="false"
        class="rounded-sm text-primary hover:underline"
        onclick={(e) => open(e, `https://bsky.app/hashtag/${part.tag}`)}
        onauxclick={(e) => auxOpen(e, `https://bsky.app/hashtag/${part.tag}`)}>{part.text}</a
      >
    {:else}{part.text}{/if}
  {/each}
</p>
