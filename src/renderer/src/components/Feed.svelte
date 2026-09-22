<script lang="ts">
  import { app } from '$lib/app-state.svelte'
  import Newspaper from '@lucide/svelte/icons/newspaper'
  import PostList from './PostList.svelte'

  /**
   * The Feed tab: what the status accounts have posted, and nothing else.
   *
   * Everything here was written by a person on AT Protocol — prose, rich text, links,
   * images — which is why it keeps the full card. What a machine filed — a pushed
   * delivery, a network finding — is terse and about one service, so it is left to the
   * Timeline rather than padded out into a card here.
   */
  let { now }: { now: number } = $props()
</script>

<PostList
  {now}
  posts={app.feedPosts}
  accounts={app.feedAccounts}
  emptyIcon={Newspaper}
  emptyTitle="No posts yet"
  emptyDescription="Statusky is fetching posts from the status accounts you track. This only takes a moment."
/>
