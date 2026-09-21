<script lang="ts">
  import { Select as SelectPrimitive } from 'bits-ui'

  // `SelectRootProps` is a union discriminated on `type`, so the props are passed
  // straight through rather than destructured — narrowing happens at the call site.
  let props: SelectPrimitive.RootProps = $props()
</script>

<SelectPrimitive.Root {...props} />
