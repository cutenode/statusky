<script lang="ts">
  import { Avatar as AvatarPrimitive } from 'bits-ui'
  import { cn } from '$lib/utils'

  let {
    class: className,
    ref = $bindable(null),
    children,
    ...restProps
  }: AvatarPrimitive.RootProps = $props()
</script>

<AvatarPrimitive.Root
  bind:ref
  class={cn(
    'relative flex size-8 shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-border/60',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</AvatarPrimitive.Root>
