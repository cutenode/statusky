<script lang="ts" module>
  import { type VariantProps, tv } from 'tailwind-variants'

  export const buttonVariants = tv({
    base: "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-all outline-none focus-visible:ring-[2px] focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 active:scale-[0.98]",
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-8 px-3 py-1.5',
        sm: 'h-7 rounded-md px-2.5 text-xs',
        lg: 'h-9 rounded-md px-4',
        icon: 'size-8',
        'icon-sm': 'size-7 rounded-md'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  })

  export type ButtonVariant = VariantProps<typeof buttonVariants>['variant']
  export type ButtonSize = VariantProps<typeof buttonVariants>['size']
</script>

<script lang="ts">
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements'
  import { cn, type WithElementRef } from '$lib/utils'

  type Props = WithElementRef<HTMLButtonAttributes> &
    WithElementRef<HTMLAnchorAttributes> & {
      variant?: ButtonVariant
      size?: ButtonSize
    }

  let {
    class: className,
    variant = 'default',
    size = 'default',
    ref = $bindable(null),
    href = undefined,
    type = 'button',
    children,
    ...restProps
  }: Props = $props()
</script>

{#if href}
  <a bind:this={ref} class={cn(buttonVariants({ variant, size }), className)} {href} {...restProps}>
    {@render children?.()}
  </a>
{:else}
  <button
    bind:this={ref}
    class={cn(buttonVariants({ variant, size }), className)}
    {type}
    {...restProps}
  >
    {@render children?.()}
  </button>
{/if}
