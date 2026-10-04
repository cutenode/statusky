<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Select, SelectContent, SelectItem, SelectTrigger } from '$lib/components/ui/select'
  import { Separator } from '$lib/components/ui/separator'
  import { Switch } from '$lib/components/ui/switch'
  import { app } from '$lib/app-state.svelte'
  import { PendingList, Refusals } from '$lib/requests.svelte'
  import { cn } from '$lib/utils'
  import {
    formatAccelerator,
    GLOBAL_SHORTCUT_CHOICES,
    LATEST_RELEASE_URL,
    MARK_READ_CHOICES,
    NETWORK_INTERVAL_CHOICES,
    POLL_INTERVAL_CHOICES,
    TRAY_UNREAD_STYLE_CHOICES
  } from '@shared/defaults'
  import { PROBE_GROUPS, PROBE_SOURCE_NAME } from '@shared/network'
  import type {
    MarkReadTrigger,
    ProbeGroup,
    Settings,
    ThemePreference,
    TrayUnreadStyle
  } from '@shared/types'
  import Check from '@lucide/svelte/icons/check'
  import Download from '@lucide/svelte/icons/download'
  import type { Snippet } from 'svelte'
  import NotificationSettings from './NotificationSettings.svelte'
  import ProbeTargetsPanel from './ProbeTargetsPanel.svelte'
  import Refused from './Refused.svelte'
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

  /** Why main refused what each row last asked for, said under that row. */
  const refusals = new Refusals()

  /** Change a setting for one row's control, and say under that row if main refuses. */
  function patch(key: string, next: Partial<Settings>): void {
    void refusals.track(key, app.patchSettings(next))
  }

  /** Every panel but the control group, which is never judged and so never counts. */
  const COUNTABLE = PROBE_GROUPS.filter((group) => group.id !== 'internet')

  /** Built on — and drawn from — the last unanswered click, so two quick ones both land. */
  const counted = new PendingList(() => app.settings.countedProbeGroups)

  function toggleCounted(group: ProbeGroup): void {
    const before = counted.current
    const next = before.includes(group)
      ? before.filter((id) => id !== group)
      : // Kept in the dashboard's own order, so the setting reads the same way round.
        COUNTABLE.map(({ id }) => id).filter((id) => id === group || before.includes(id))
    void refusals.track(
      'counted',
      counted.send(next, (list) => app.patchSettings({ countedProbeGroups: list }))
    )
  }

  /**
   * The value the select uses for "no shortcut".
   *
   * The setting itself is the empty string, which is the honest representation of a
   * shortcut that is not set — but an empty string is also falsy, and the select
   * primitive reads a falsy value as "nothing is selected". The sentinel exists only
   * between the two and is mapped back on the way out.
   */
  const NO_SHORTCUT = 'off'
  const shortcutValue = $derived(app.settings.globalShortcut || NO_SHORTCUT)
  const shortcutLabel = $derived(formatAccelerator(app.settings.globalShortcut, app.platform))
</script>

{#snippet row(title: string, description: string, control: Snippet, key: string)}
  <div class="flex items-center justify-between gap-4 py-2">
    <div class="min-w-0">
      <p class="text-[12.5px] font-medium">{title}</p>
      <p class="text-[11px] leading-snug text-muted-foreground">{description}</p>
    </div>
    <div class="shrink-0">{@render control()}</div>
  </div>
  <Refused text={refusals.of(key)} />
{/snippet}

<div class="scroll-thin h-full min-h-0 overflow-y-auto px-3 pb-4">
  <NotificationSettings {now} />

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
        bind:value={
          () => String(app.settings.pollIntervalSec),
          (value) => patch('interval', { pollIntervalSec: Number(value) })
        }
      >
        <SelectTrigger class="w-[8.5rem]" aria-label="How often to check for updates"
          >{intervalLabel}</SelectTrigger
        >
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
      intervalControl,
      'interval'
    )}

    <Separator />

    {#snippet markReadControl()}
      <Select
        type="single"
        bind:value={
          () => app.settings.markReadOn,
          (value) => patch('markRead', { markReadOn: value as MarkReadTrigger })
        }
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
    {@render row('Mark as read', markRead.hint, markReadControl, 'markRead')}
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
        bind:value={
          () => app.settings.trayUnreadStyle,
          (value) => patch('trayStyle', { trayUnreadStyle: value as TrayUnreadStyle })
        }
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
    {@render row('Unread updates', trayStyle.hint, trayStyleControl, 'trayStyle')}

    <p class="px-0.5 pt-1 text-[11px] leading-snug text-muted-foreground">
      The icon reports health either way — neutral when everything is operational, amber while
      recovering, red during an active incident. This is only how it asks you to look at something.
    </p>

    <Separator class="my-2" />

    {#snippet shortcutControl()}
      <Select
        type="single"
        bind:value={
          () => shortcutValue,
          (value) => patch('shortcut', { globalShortcut: value === NO_SHORTCUT ? '' : value })
        }
      >
        <SelectTrigger class="w-[9.5rem]" aria-label="Keyboard shortcut to open Statusky"
          >{shortcutLabel}</SelectTrigger
        >
        <SelectContent>
          {#each GLOBAL_SHORTCUT_CHOICES as choice (choice)}
            <SelectItem
              value={choice || NO_SHORTCUT}
              label={formatAccelerator(choice, app.platform)}
            />
          {/each}
        </SelectContent>
      </Select>
    {/snippet}
    {@render row(
      'Summon with a keypress',
      'A shortcut that opens the popover from whatever you are in. Off unless you say.',
      shortcutControl,
      'shortcut'
    )}

    <!--
      A shortcut belongs to whichever application asked for it first, and losing that
      race is completely silent: the key just does somebody else's thing. This is the
      only place anybody finds out. See `ShortcutStatus`.
    -->
    {#if app.shortcutError}
      <p class="px-0.5 pb-2 text-[11px] text-destructive" role="alert">{app.shortcutError}</p>
    {/if}
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
        bind:checked={
          () => app.settings.networkChecks,
          (checked) => patch('networkChecks', { networkChecks: checked })
        }
        aria-label="Run network checks"
      />
    {/snippet}
    {@render row(
      'Measure the network',
      'Probe relays, PDSes and AppViews from this computer, as status.feeds.blue does.',
      networkControl,
      'networkChecks'
    )}

    <Separator />

    {#snippet networkIntervalControl()}
      <Select
        type="single"
        bind:value={
          () => String(app.settings.networkIntervalSec),
          (value) => patch('networkInterval', { networkIntervalSec: Number(value) })
        }
        disabled={!app.settings.networkChecks}
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
      networkIntervalControl,
      'networkInterval'
    )}

    <Separator />

    <div class="py-2">
      <p class="text-[12.5px] font-medium" id="counted-groups-label">Count in the menu bar</p>
      <p class="text-[11px] leading-snug text-muted-foreground">
        Which panels can turn the icon amber or red, and raise banners about core services. The rest
        are still measured and filed in the feed.
      </p>
      <div class="mt-2 flex flex-wrap gap-1.5" role="group" aria-labelledby="counted-groups-label">
        {#each COUNTABLE as group (group.id)}
          {@const on = counted.current.includes(group.id)}
          <Button
            variant={on ? 'secondary' : 'outline'}
            size="sm"
            class={cn('h-6 px-2 text-[11px]', !on && 'text-muted-foreground')}
            aria-pressed={on}
            title={group.blurb}
            disabled={!app.settings.networkChecks}
            onclick={() => toggleCounted(group.id)}
          >
            {#if on}<Check class="size-3" />{/if}
            {group.title}
          </Button>
        {/each}
      </div>
      <Refused class="pt-1.5 pb-0" text={refusals.of('counted')} />
    </div>

    <p class="px-0.5 pt-1 text-[11px] leading-snug text-muted-foreground">
      A confirmed outage or recovery is filed in the feed as “{PROBE_SOURCE_NAME}”, which can be
      silenced or hidden under Accounts like any other source.
    </p>
  </section>

  <Separator class="my-3" />

  <ProbeTargetsPanel />

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
        bind:value={
          () => app.settings.theme, (value) => patch('theme', { theme: value as ThemePreference })
        }
      >
        <SelectTrigger class="w-[8.5rem]" aria-label="Appearance">{themeLabel}</SelectTrigger>
        <SelectContent>
          {#each THEMES as theme (theme.value)}
            <SelectItem value={theme.value} label={theme.label} />
          {/each}
        </SelectContent>
      </Select>
    {/snippet}
    {@render row('Appearance', 'Follow the system theme or pin one.', themeControl, 'theme')}

    <Separator />

    {#snippet loginControl()}
      <Switch
        bind:checked={
          () => app.settings.launchAtLogin,
          (checked) => patch('launchAtLogin', { launchAtLogin: checked })
        }
        aria-label="Launch at login"
      />
    {/snippet}
    {@render row(
      'Launch at login',
      'Start Statusky in the menu bar when you sign in.',
      loginControl,
      'launchAtLogin'
    )}

    <!--
      The toggle keeps showing the setting; this says what the OS did with it. A refused
      login item is invisible by definition — the app that would have told you is the one
      that did not start — so the refusal has to be said here, at the moment it happens,
      and it has to say what to do about it. See `explainLoginItemFailure`.
    -->
    {#if app.loginItemError}
      <p class="px-0.5 pb-2 text-[11px] text-destructive" role="alert">{app.loginItemError}</p>
    {/if}

    <!--
      The one piece of news this app carries about itself, and the one place besides the
      menu bar icon's own menu that carries it. Deliberately not an OS notification: a
      banner from Statusky means the Atmosphere is broken, and spending that channel on
      a version number is how it stops meaning that. See `UpdateStatus`.

      Which of the two appears says what this build can actually do. `ready` is macOS or
      Windows having already downloaded one, so all that is left is a restart, and the
      menu bar is where that verb lives. `available` is everywhere Squirrel cannot help —
      Linux always, and either of the others when the signature or the install layout
      will not let it — so the only honest instruction is to go and fetch the new build.
      It does not say to update, because nothing here will.
    -->
    {#if app.update.stage === 'available'}
      <Separator />

      {#snippet downloadControl()}
        <Button variant="outline" size="sm" onclick={() => app.openExternal(LATEST_RELEASE_URL)}>
          <Download class="size-3.5" />
          Download
        </Button>
      {/snippet}
      {@render row(
        `Statusky ${app.update.version} is available`,
        'Nothing on this machine updates Statusky for you — these builds come from a download page rather than a package repository. Fetch the new one and replace this copy.',
        downloadControl,
        'download'
      )}
    {:else if app.update.stage === 'ready'}
      <Separator />
      <p class="px-0.5 py-2 text-[11px] leading-snug text-muted-foreground" role="status">
        {app.update.version
          ? `Statusky ${app.update.version} has been downloaded`
          : 'A new version of Statusky has been downloaded'} and installs the next time it starts.
        <span class="font-medium">Restart to update</span> in the menu bar icon's menu does it now.
      </p>
    {/if}
  </section>

  <p class="mt-4 text-center text-[10.5px] text-muted-foreground">
    Statusky {app.version} · reads public
    <code class="font-mono">app.bsky.feed.post</code> records
  </p>
</div>
