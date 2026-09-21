<script lang="ts">
  import { Separator } from '$lib/components/ui/separator'
  import { app } from '$lib/app-state.svelte'
  import AccountRow from './AccountRow.svelte'
  import AddAccountForm from './AddAccountForm.svelte'

  const notifying = $derived(app.accounts.filter((a) => a.notify && !a.muted).length)
</script>

<div class="scroll-thin h-full min-h-0 overflow-y-auto px-3 pb-4">
  <section class="mb-3">
    <h2
      class="mb-1.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
    >
      Track an account
    </h2>
    <AddAccountForm />
  </section>

  <Separator class="my-3" />

  <section>
    <div class="mb-1.5 flex items-baseline justify-between">
      <h2 class="text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        Tracking {app.accounts.length}
      </h2>
      <span class="text-[10.5px] text-muted-foreground">
        {notifying} notifying
      </span>
    </div>

    <div class="flex flex-col gap-1.5">
      {#each app.accounts as account (account.did)}
        <AccountRow {account} />
      {/each}
    </div>
  </section>
</div>
