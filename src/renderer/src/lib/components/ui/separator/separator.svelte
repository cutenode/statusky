<script lang="ts">
  import { Separator as SeparatorPrimitive } from 'bits-ui'
  import { cn, type WithoutChildrenOrChild } from '$lib/utils'

  let {
    class: className,
    orientation = 'horizontal',
    ref = $bindable(null),
    ...restProps
  }: WithoutChildrenOrChild<SeparatorPrimitive.RootProps> = $props()
</script>

<SeparatorPrimitive.Root
  bind:ref
  {orientation}
  class={cn(
    'shrink-0 bg-border',
    orientation === 'vertical' ? 'h-full w-px' : 'h-px w-full',
    className
  )}
  {...restProps}
/>
