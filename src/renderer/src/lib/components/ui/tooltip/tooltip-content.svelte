<script lang="ts">
  import { Tooltip as TooltipPrimitive } from 'bits-ui'
  import { cn, type WithoutChild } from '$lib/utils'

  let {
    class: className,
    sideOffset = 6,
    ref = $bindable(null),
    children,
    ...restProps
  }: WithoutChild<TooltipPrimitive.ContentProps> = $props()
</script>

<TooltipPrimitive.Portal>
  <TooltipPrimitive.Content
    bind:ref
    {sideOffset}
    class={cn(
      'z-50 max-w-64 rounded-md border border-border/60 bg-popover/95 px-2 py-1 text-[11.5px] text-popover-foreground shadow-md backdrop-blur-xl',
      'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95',
      'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
      className
    )}
    {...restProps}
  >
    {@render children?.()}
  </TooltipPrimitive.Content>
</TooltipPrimitive.Portal>
