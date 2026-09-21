<script lang="ts" module>
  import { type VariantProps, tv } from 'tailwind-variants'

  export const badgeVariants = tv({
    base: 'inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[10.5px] font-semibold tracking-wide uppercase transition-colors w-fit whitespace-nowrap shrink-0',
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-muted-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground'
      }
    },
    defaultVariants: { variant: 'default' }
  })

  export type BadgeVariant = VariantProps<typeof badgeVariants>['variant']
</script>

<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements'
  import { cn, type WithElementRef } from '$lib/utils'

  let {
    class: className,
    variant = 'default',
    ref = $bindable(null),
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLSpanElement>> & { variant?: BadgeVariant } = $props()
</script>

<span bind:this={ref} class={cn(badgeVariants({ variant }), className)} {...restProps}>
  {@render children?.()}
</span>
