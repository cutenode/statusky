<script lang="ts">
  import { Tooltip as TooltipPrimitive } from 'bits-ui'
  import { cn } from '$lib/utils'

  let {
    class: className,
    ref = $bindable(null),
    children,
    ...restProps
  }: TooltipPrimitive.TriggerProps = $props()
</script>

<TooltipPrimitive.Trigger bind:ref class={cn(className)} {...restProps}>
  {@render children?.()}
</TooltipPrimitive.Trigger>
