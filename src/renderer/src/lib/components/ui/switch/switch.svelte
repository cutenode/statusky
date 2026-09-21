<script lang="ts">
  import { Switch as SwitchPrimitive } from 'bits-ui'
  import { cn, type WithoutChildrenOrChild } from '$lib/utils'

  let {
    class: className,
    checked = $bindable(false),
    ref = $bindable(null),
    ...restProps
  }: WithoutChildrenOrChild<SwitchPrimitive.RootProps> = $props()
</script>

<SwitchPrimitive.Root
  bind:ref
  bind:checked
  class={cn(
    'peer inline-flex h-[19px] w-[33px] shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none',
    'focus-visible:ring-[2px] focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50',
    'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
    className
  )}
  {...restProps}
>
  <SwitchPrimitive.Thumb
    class={cn(
      'pointer-events-none block size-[15px] rounded-full bg-white shadow-sm ring-0 transition-transform',
      'data-[state=checked]:translate-x-[16px] data-[state=unchecked]:translate-x-[2px]'
    )}
  />
</SwitchPrimitive.Root>
