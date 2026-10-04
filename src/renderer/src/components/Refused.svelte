<script lang="ts">
  import { cn } from '$lib/utils'

  /**
   * Why main refused what a control just asked for, said beside that control.
   *
   * An alert, because it answers something the user did a moment ago and has no other
   * way of finding out about: the control itself goes on showing what main has, which
   * after a refusal is what it had before.
   */
  let { text, class: className }: { text: string | null; class?: string } = $props()
</script>

{#if text}
  <p
    class={cn('selectable px-0.5 pb-2 text-[11px] leading-snug text-destructive', className)}
    role="alert"
  >
    {text}
  </p>
{/if}
