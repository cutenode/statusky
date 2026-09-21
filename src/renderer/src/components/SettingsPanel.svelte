<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Select, SelectContent, SelectItem, SelectTrigger } from '$lib/components/ui/select'
  import { Separator } from '$lib/components/ui/separator'
  import { Switch } from '$lib/components/ui/switch'
  import { app } from '$lib/app-state.svelte'
  import {
    MARK_READ_CHOICES,
    NETWORK_INTERVAL_CHOICES,
    POLL_INTERVAL_CHOICES,
    TRAY_UNREAD_STYLE_CHOICES
  } from '@shared/defaults'
  import { PROBE_SOURCE_NAME } from '@shared/network'
  import type { MarkReadTrigger, ThemePreference, TrayUnreadStyle } from '@shared/types'
  import BellRing from '@lucide/svelte/icons/bell'
  import type { Snippet } from 'svelte'
  import WebhookPanel from './WebhookPanel.svelte'

  /** Ticks the "last delivery" line. Optional so the panel stands alone in tests. */
  let { now = Date.now() }: { now?: number } = $props()

  const THEMES: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'Match system' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' }
  ]

  const intervalLabel = $derived(
    POLL_INTERVAL_CHOICES.find((c) => c.value === app.settings.pollIntervalSec)?.label ??
      `${app.settings.pollIntervalSec}s`
  )
  const networkIntervalLabel = $derived(
    NETWORK_INTERVAL_CHOICES.find((c) => c.value === app.settings.networkIntervalSec)?.label ??
      `${Math.round(app.settings.networkIntervalSec / 60)} minutes`
  )
  const themeLabel = $derived(
    THEMES.find((t) => t.value === app.settings.theme)?.label ?? 'Match system'
  )

  const trayStyle = $derived(
    TRAY_UNREAD_STYLE_CHOICES.find((c) => c.value === app.settings.trayUnreadStyle) ??
      TRAY_UNREAD_STYLE_CHOICES[0]!
  )
  const markRead = $derived(
    MARK_READ_CHOICES.find((c) => c.value === app.settings.markReadOn) ?? MARK_READ_CHOICES[0]!
  )

  // A refused notification is invisible by definition, so the button has to say
  // what happened rather than just firing and hoping.
  let testState = $state<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  let testError = $state<string | null>(null)

  async function sendTest(): Promise<void> {
    testState = 'sending'
    testError = null
    await app.testNotification()
    // `app.actionError` is cleared at the start of every action, so whatever is on it
    // now belongs to this call.
    testError = app.actionError
    testState = testError === null ? 'sent' : 'failed'
  }
</script>

{#snippet row(title: string, description: string, control: Snippet)}
  <div class="flex items-center justify-between gap-4 py-2">
    <div class="min-w-0">
      <p class="text-[12.5px] font-medium">{title}</p>
      <p class="text-[11px] leading-snug text-muted-foreground">{description}</p>
    </div>
    <div class="shrink-0">{@render control()}</div>
  </div>
{/snippet}

<div class="scroll-thin h-full min-h-0 overflow-y-auto px-3 pb-4">
  <section>
    <h2
      class="mb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
    >
      Notifications
    </h2>

    {#snippet notificationsControl()}
      <Switch
        checked={app.settings.notificationsEnabled}
        onCheckedChange={(checked) => void app.patchSettings({ notificationsEnabled: checked })}
        aria-label="Enable notifications"
      />
    {/snippet}
    {@render row(
      'Push notifications',
      'Master switch. Individual accounts can still be silenced.',
      notificationsControl
    )}

    <Separator />

    {#snippet soundControl()}
      <Switch
        checked={app.settings.notificationSound}
        disabled={!app.settings.notificationsEnabled}
        onCheckedChange={(checked) => void app.patchSettings({ notificationSound: checked })}
        aria-label="Play notification sound"
      />
    {/snippet}
    {@render row('Play sound', 'Use the system notification sound.', soundControl)}

    <Separator />

    {#snippet testControl()}
      <Button
        variant="outline"
        size="sm"
        disabled={testState === 'sending'}
        onclick={() => void sendTest()}
      >
        <BellRing class="size-3.5" />
        {testState === 'sending' ? 'Sending…' : 'Send test'}
      </Button>
    {/snippet}
    {@render row('Test notification', 'Check that macOS is letting them through.', testControl)}

    {#if testState === 'sent'}
      <p class="px-0.5 pb-2 text-[11px] text-muted-foreground" role="status">
        Sent. If nothing appeared, check Notifications in System Settings.
      </p>
    {:else if testState === 'failed'}
      <p class="px-0.5 pb-2 text-[11px] text-destructive" role="alert">
        {testError ?? 'The system refused the notification.'}
      </p>
    {/if}
  </section>

  <Separator class="my-3" />

  <section>
    <h2
      class="mb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
    >
      Feed
    </h2>

    {#snippet intervalControl()}
      <Select
        type="single"
        value={String(app.settings.pollIntervalSec)}
        onValueChange={(value) => void app.patchSettings({ pollIntervalSec: Number(value) })}
      >
        <SelectTrigger class="w-[8.5rem]">{intervalLabel}</SelectTrigger>
        <SelectContent>
          {#each POLL_INTERVAL_CHOICES as choice (choice.value)}
            <SelectItem value={String(choice.value)} label={choice.label} />
          {/each}
        </SelectContent>
      </Select>
    {/snippet}
    {@render row(
      'Check for updates',
      'How often to poll the AT Protocol AppView.',
      intervalControl
    )}

    <Separator />

    {#snippet markReadControl()}
      <Select
        type="single"
        value={app.settings.markReadOn}
        onValueChange={(value) => void app.patchSettings({ markReadOn: value as MarkReadTrigger })}
      >
        <SelectTrigger class="w-[9.5rem]" aria-label="When to mark updates as read"
          >{markRead.label}</SelectTrigger
        >
        <SelectContent>
          {#each MARK_READ_CHOICES as choice (choice.value)}
            <SelectItem value={choice.value} label={choice.label} />
          {/each}
        </SelectContent>
      </Select>
    {/snippet}
    {@render row('Mark as read', markRead.hint, markReadControl)}
  </section>

  <Separator class="my-3" />

  <section>
    <h2
      class="mb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
    >
      Menu bar
    </h2>

    {#snippet trayStyleControl()}
      <Select
        type="single"
        value={app.settings.trayUnreadStyle}
        onValueChange={(value) =>
          void app.patchSettings({ trayUnreadStyle: value as TrayUnreadStyle })}
      >
        <SelectTrigger class="w-[9.5rem]" aria-label="How unread updates show in the menu bar"
          >{trayStyle.label}</SelectTrigger
        >
        <SelectContent>
          {#each TRAY_UNREAD_STYLE_CHOICES as choice (choice.value)}
            <SelectItem value={choice.value} label={choice.label} />
          {/each}
        </SelectContent>
      </Select>
    {/snippet}
    {@render row('Unread updates', trayStyle.hint, trayStyleControl)}

    <p class="px-0.5 pt-1 text-[11px] leading-snug text-muted-foreground">
      The icon reports health either way — neutral when everything is operational, amber while
      recovering, red during an active incident. This is only how it asks you to look at something.
    </p>
  </section>

  <Separator class="my-3" />

  <section>
    <h2
      class="mb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
    >
      Network checks
    </h2>

    {#snippet networkControl()}
      <Switch
        checked={app.settings.networkChecks}
        onCheckedChange={(checked) => void app.patchSettings({ networkChecks: checked })}
        aria-label="Run network checks"
      />
    {/snippet}
    {@render row(
      'Measure the network',
      'Probe relays, PDSes and AppViews from this computer, as status.feeds.blue does.',
      networkControl
    )}

    <Separator />

    {#snippet networkIntervalControl()}
      <Select
        type="single"
        value={String(app.settings.networkIntervalSec)}
        disabled={!app.settings.networkChecks}
        onValueChange={(value) => void app.patchSettings({ networkIntervalSec: Number(value) })}
      >
        <SelectTrigger class="w-[8.5rem]" aria-label="How often to check the network"
          >{networkIntervalLabel}</SelectTrigger
        >
        <SelectContent>
          {#each NETWORK_INTERVAL_CHOICES as choice (choice.value)}
            <SelectItem value={String(choice.value)} label={choice.label} />
          {/each}
        </SelectContent>
      </Select>
    {/snippet}
    {@render row(
      'Check every',
      'In the background. Opening the popover re-checks anything older than two minutes.',
      networkIntervalControl
    )}

    <p class="px-0.5 pt-1 text-[11px] leading-snug text-muted-foreground">
      A confirmed outage or recovery is filed in the feed as “{PROBE_SOURCE_NAME}”, which can be
      silenced or hidden under Accounts like any other source.
    </p>
  </section>

  <Separator class="my-3" />

  <WebhookPanel {now} />

  <Separator class="my-3" />

  <section>
    <h2
      class="mb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
    >
      Application
    </h2>

    {#snippet themeControl()}
      <Select
        type="single"
        value={app.settings.theme}
        onValueChange={(value) => void app.patchSettings({ theme: value as ThemePreference })}
      >
        <SelectTrigger class="w-[8.5rem]">{themeLabel}</SelectTrigger>
        <SelectContent>
          {#each THEMES as theme (theme.value)}
            <SelectItem value={theme.value} label={theme.label} />
          {/each}
        </SelectContent>
      </Select>
    {/snippet}
    {@render row('Appearance', 'Follow the system theme or pin one.', themeControl)}

    <Separator />

    {#snippet loginControl()}
      <Switch
        checked={app.settings.launchAtLogin}
        onCheckedChange={(checked) => void app.patchSettings({ launchAtLogin: checked })}
        aria-label="Launch at login"
      />
    {/snippet}
    {@render row(
      'Launch at login',
      'Start Statusky in the menu bar when you sign in.',
      loginControl
    )}
  </section>

  <p class="mt-4 text-center text-[10.5px] text-muted-foreground">
    Statusky {app.version} · reads public
    <code class="font-mono">app.bsky.feed.post</code> records
  </p>
</div>
