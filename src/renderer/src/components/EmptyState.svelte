<script lang="ts">
  import type { LucideIcon } from '@lucide/svelte'
  import type { Snippet } from 'svelte'

  let {
    icon: Icon,
    title,
    description,
    action
  }: { icon: LucideIcon; title: string; description: string; action?: Snippet } = $props()
</script>

<div class="flex flex-col items-center justify-center gap-2 px-8 py-14 text-center">
  <div class="mb-1 rounded-full bg-muted/70 p-3 text-muted-foreground">
    <Icon class="size-5" strokeWidth={1.75} />
  </div>
  <p class="text-[13px] font-medium">{title}</p>
  <p class="max-w-[16rem] text-[12px] leading-relaxed text-muted-foreground">{description}</p>
  {#if action}
    <div class="mt-2">{@render action()}</div>
  {/if}
</div>
