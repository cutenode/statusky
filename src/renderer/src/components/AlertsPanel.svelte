<script lang="ts">
  import { app } from '$lib/app-state.svelte'
  import Siren from '@lucide/svelte/icons/siren'
  import PostList from './PostList.svelte'

  /**
   * The Alerts tab: everything that arrived without being asked for.
   *
   * Two sources share it. A hosted status page POSTs its incidents to the local
   * receiver, and the network checks file an entry whenever a service they measure
   * changes condition. Neither is somebody's post — both are a machine saying a named
   * service moved between states — so they read as one chronology, and keeping them
   * out of Feed leaves each tab scannable for what it is.
   */
  let { now }: { now: number } = $props()
</script>

<PostList
  {now}
  posts={app.alertPosts}
  accounts={app.alertAccounts}
  emptyIcon={Siren}
  emptyTitle="No alerts"
  emptyDescription="Pushed status-page updates and anything the network checks notice will land here."
/>
