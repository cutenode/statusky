<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { SEVERITY_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import { SEVERITY_LABEL } from '@shared/status'
  import type { Severity } from '@shared/types'

  let { severity, class: className }: { severity: Severity; class?: string } = $props()

  const style = $derived(SEVERITY_STYLE[severity])
  const Icon = $derived(style.icon)
</script>

<Badge variant="outline" class={cn('border-transparent', style.bg, style.text, className)}>
  <Icon class="size-3" strokeWidth={2.5} />
  {SEVERITY_LABEL[severity]}
</Badge>
