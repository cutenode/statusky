<script lang="ts">
  import { Select as SelectPrimitive } from 'bits-ui'
  import CheckIcon from '@lucide/svelte/icons/check'
  import { cn, type WithoutChild } from '$lib/utils'

  let {
    class: className,
    value,
    label,
    ref = $bindable(null),
    children: childrenProp,
    ...restProps
  }: WithoutChild<SelectPrimitive.ItemProps> = $props()
</script>

<SelectPrimitive.Item
  bind:ref
  {value}
  {label}
  class={cn(
    'relative flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-7 pl-2 text-[13px] outline-none select-none',
    'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
    'data-disabled:pointer-events-none data-disabled:opacity-50',
    className
  )}
  {...restProps}
>
  {#snippet children({ selected })}
    {#if childrenProp}{@render childrenProp({ selected, highlighted: false })}{:else}
      {label ?? value}
    {/if}
    {#if selected}
      <span class="absolute right-2 flex size-3.5 items-center justify-center">
        <CheckIcon class="size-3.5" />
      </span>
    {/if}
  {/snippet}
</SelectPrimitive.Item>
