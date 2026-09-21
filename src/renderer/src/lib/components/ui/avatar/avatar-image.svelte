<script lang="ts">
  import { Avatar as AvatarPrimitive } from 'bits-ui'
  import { cn } from '$lib/utils'

  let {
    class: className,
    ref = $bindable(null),
    ...restProps
  }: AvatarPrimitive.ImageProps = $props()
</script>

<AvatarPrimitive.Image
  bind:ref
  class={cn('aspect-square size-full object-cover', className)}
  {...restProps}
/>
