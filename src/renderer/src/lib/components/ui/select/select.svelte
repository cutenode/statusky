<script lang="ts">
  import { Select as SelectPrimitive, type SelectSingleRootProps } from 'bits-ui'

  // Single choice only, which is all this app asks of a select. That is what lets
  // `value` be taken out of the props and bound, where the union `SelectRootProps` is
  // discriminated on `type` and cannot be destructured: a parent that binds it is drawn
  // from what it answers rather than from the click, so a choice main refuses never
  // shows as made.
  let { value = $bindable(), ...props }: SelectSingleRootProps = $props()
</script>

<SelectPrimitive.Root bind:value {...props} />
