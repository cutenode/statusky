<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements'
  import { cn, type WithElementRef } from '$lib/utils'

  let {
    class: className,
    value = $bindable(),
    ref = $bindable(null),
    ...restProps
  }: WithElementRef<HTMLInputAttributes, HTMLInputElement> = $props()
</script>

<input
  bind:this={ref}
  bind:value
  class={cn(
    'flex h-8 w-full min-w-0 rounded-md border border-input bg-background/60 px-2.5 py-1 text-[13px] shadow-xs transition-[color,box-shadow] outline-none',
    'placeholder:text-muted-foreground/70 selection:bg-primary selection:text-primary-foreground',
    'focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/40',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
    className
  )}
  {...restProps}
/>
