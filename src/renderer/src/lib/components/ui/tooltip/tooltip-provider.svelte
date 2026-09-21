<script lang="ts">
  import { Tooltip as TooltipPrimitive } from 'bits-ui'

  let { children, delayDuration = 350, ...restProps }: TooltipPrimitive.ProviderProps = $props()
</script>

<TooltipPrimitive.Provider {delayDuration} {...restProps}>
  {@render children?.()}
</TooltipPrimitive.Provider>
