<script lang="ts">
  import { Select as SelectPrimitive } from 'bits-ui'
  import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down'
  import { cn } from '$lib/utils'

  let {
    class: className,
    ref = $bindable(null),
    children,
    ...restProps
  }: SelectPrimitive.TriggerProps = $props()
</script>

<SelectPrimitive.Trigger
  bind:ref
  class={cn(
    'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-background/60 px-2.5 py-1 text-[13px] whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none',
    'data-placeholder:text-muted-foreground focus:border-ring focus:ring-[2px] focus:ring-ring/40',
    'disabled:cursor-not-allowed disabled:opacity-50',
    className
  )}
  {...restProps}
>
  {@render children?.()}
  <ChevronsUpDownIcon class="size-3.5 shrink-0 opacity-50" />
</SelectPrimitive.Trigger>
