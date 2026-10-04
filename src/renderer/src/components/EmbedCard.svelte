<script lang="ts">
  import { app } from '$lib/app-state.svelte'
  import type { PostEmbed } from '@shared/types'
  import ExternalLink from '@lucide/svelte/icons/external-link'

  let { embed }: { embed: PostEmbed } = $props()

  function hostOf(uri: string): string {
    try {
      return new URL(uri).hostname.replace(/^www\./, '')
    } catch {
      return uri
    }
  }
</script>

{#if embed.kind === 'external'}
  <button
    type="button"
    class="group mt-2 flex w-full items-stretch gap-0 overflow-hidden rounded-lg border border-border/70 bg-background/40 text-left transition-colors hover:border-border hover:bg-accent/40"
    onclick={(e) => {
      e.stopPropagation()
      app.openExternal(embed.uri)
    }}
  >
    {#if embed.thumb}
      <img
        src={embed.thumb}
        alt=""
        class="size-14 shrink-0 object-cover"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
    {/if}
    <span class="flex min-w-0 flex-col justify-center gap-0.5 px-2.5 py-1.5">
      <span
        class="flex items-center gap-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase"
      >
        <ExternalLink class="size-2.5" />
        {hostOf(embed.uri)}
      </span>
      <span class="truncate text-[12.5px] font-medium">{embed.title}</span>
      {#if embed.description}
        <span class="line-clamp-1 text-[11.5px] text-muted-foreground">{embed.description}</span>
      {/if}
    </span>
  </button>
{:else if embed.kind === 'images'}
  {@const shown = embed.images.slice(0, 4)}
  <div
    class="mt-2 grid gap-1 overflow-hidden rounded-lg"
    class:grid-cols-2={embed.images.length > 1}
  >
    <!--
      Keyed by position, not by URL: the same picture attached twice is the same blob,
      so the same URL, and a repeated key would throw and take the feed down with it.
      An image with no alt text still needs a name for its button, so it is counted.
    -->
    {#each shown as image, index (index)}
      <button
        type="button"
        class="overflow-hidden rounded-md border border-border/60"
        aria-label={image.alt ? undefined : `Image ${index + 1} of ${shown.length}`}
        title="Open the full-size image"
        onclick={(e) => {
          e.stopPropagation()
          app.openExternal(image.fullsize)
        }}
      >
        <img
          src={image.thumb}
          alt={image.alt}
          class="h-28 w-full object-cover transition-transform hover:scale-[1.02]"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
      </button>
    {/each}
  </div>
{:else}
  <div class="mt-2 rounded-lg border border-border/70 bg-background/40 px-2.5 py-1.5">
    <p class="text-[11px] font-medium text-muted-foreground">@{embed.author}</p>
    <p class="line-clamp-3 text-[12px] text-foreground/80">{embed.text}</p>
  </div>
{/if}
