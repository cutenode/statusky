<script lang="ts">
  import { Avatar as AvatarPrimitive } from 'bits-ui'
  import { cn } from '$lib/utils'

  let {
    class: className,
    ref = $bindable(null),
    children,
    ...restProps
  }: AvatarPrimitive.FallbackProps = $props()
</script>

<AvatarPrimitive.Fallback
  bind:ref
  class={cn(
    'flex size-full items-center justify-center rounded-full bg-gradient-to-br from-primary/25 to-primary/5 text-[11px] font-semibold text-foreground/70',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</AvatarPrimitive.Fallback>
