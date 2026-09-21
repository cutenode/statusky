<script lang="ts">
  import { Select as SelectPrimitive } from 'bits-ui'
  import { cn, type WithoutChild } from '$lib/utils'

  let {
    class: className,
    sideOffset = 4,
    ref = $bindable(null),
    children,
    ...restProps
  }: WithoutChild<SelectPrimitive.ContentProps> = $props()
</script>

<SelectPrimitive.Portal>
  <SelectPrimitive.Content
    bind:ref
    {sideOffset}
    class={cn(
      'relative z-50 max-h-[min(20rem,var(--bits-select-content-available-height))] min-w-[8rem] overflow-y-auto overflow-x-hidden',
      'rounded-lg border border-border/70 bg-popover/95 text-popover-foreground shadow-lg backdrop-blur-xl',
      'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
      className
    )}
    {...restProps}
  >
    <SelectPrimitive.Viewport class="p-1">
      {@render children?.()}
    </SelectPrimitive.Viewport>
  </SelectPrimitive.Content>
</SelectPrimitive.Portal>
