<script lang="ts">
  import { Tooltip as TooltipPrimitive } from 'bits-ui'

  let { children, delayDuration = 350, ...restProps }: TooltipPrimitive.RootProps = $props()
</script>

<TooltipPrimitive.Root {delayDuration} {children} {...restProps} />
