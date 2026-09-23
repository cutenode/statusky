<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Select, SelectContent, SelectItem, SelectTrigger } from '$lib/components/ui/select'
  import { Separator } from '$lib/components/ui/separator'
  import { Switch } from '$lib/components/ui/switch'
  import { app } from '$lib/app-state.svelte'
  import { SEVERITY_STYLE } from '$lib/severity'
  import { cn } from '$lib/utils'
  import { isControl, servicesFor } from '@shared/network'
  import {
    AWAY_CHOICES,
    formatClock,
    GRACE_CHOICES,
    NOTIFY_PRESETS,
    presetOf,
    PROBE_SCOPE_CHOICES,
    SEVERITY_ORDER,
    SNOOZE_CHOICES,
    snoozedUntil,
    snoozeEnd,
    SOUND_CHOICES,
    type SnoozeChoice
  } from '@shared/notify'
  import { effectiveProbeTargets } from '@shared/probe-targets'
  import { SEVERITY_LABEL } from '@shared/status'
  import type {
    AwayBehaviour,
    NotificationSound,
    ProbeNotifyScope,
    Settings,
    Severity,
    SourceKind
  } from '@shared/types'
  import BellRing from '@lucide/svelte/icons/bell'
  import type { Snippet } from 'svelte'

  /** Reads the snooze against. Optional so the panel stands alone in tests. */
  let { now = Date.now() }: { now?: number } = $props()

  const settings = $derived(app.settings)
  const off = $derived(!settings.notificationsEnabled)

  const sound = $derived(
    SOUND_CHOICES.find((c) => c.value === settings.notificationSound) ?? SOUND_CHOICES[1]!
  )
  const away = $derived(
    AWAY_CHOICES.find((c) => c.value === settings.notifyWhenAway) ?? AWAY_CHOICES[0]!
  )
  const scope = $derived(
    PROBE_SCOPE_CHOICES.find((c) => c.value === settings.notifyProbeScope) ??
      PROBE_SCOPE_CHOICES[0]!
  )
  const grace = $derived(
    GRACE_CHOICES.find((c) => c.value === settings.notifyProbeGraceSec)?.label ??
      `${Math.round(settings.notifyProbeGraceSec / 60)} minutes`
  )
  const preset = $derived(presetOf(settings.notifySeverities))
  const pausedUntil = $derived(snoozedUntil(settings, new Date(now)))
  const probesOn = $derived(settings.notifySources.includes('probe'))

  /**
   * Everything the checks measure, bar the controls that only say whether we are online.
   * Under the user's own targets, like the dashboard: a feed they added can be pinned, and
   * one they took out is not offered for a pin that could never fire.
   */
  const services = $derived(
    servicesFor(effectiveProbeTargets(settings.probeTargets))
      .filter((s) => !isControl(s))
      .toSorted((a, b) => a.label.localeCompare(b.label))
  )

  const SOURCE_ROWS: { kind: SourceKind; title: string; hint: string }[] = [
    { kind: 'atproto', title: 'Status accounts', hint: 'Posts from the accounts you track.' },
    { kind: 'webhook', title: 'Webhook sources', hint: 'Updates status pages push to you.' },
    { kind: 'probe', title: 'Network checks', hint: 'Outages measured from this computer.' }
  ]

  function patch(next: Partial<Settings>): void {
    void app.patchSettings(next)
  }

  function toggleSeverity(severity: Severity): void {
    const chosen = new Set(settings.notifySeverities)
    if (chosen.has(severity)) chosen.delete(severity)
    else chosen.add(severity)
    // Stored in display order, so the list reads the same way the chips do.
    patch({ notifySeverities: SEVERITY_ORDER.filter((s) => chosen.has(s)) })
  }

  function toggleSource(kind: SourceKind, on: boolean): void {
    const chosen = new Set(settings.notifySources)
    if (on) chosen.add(kind)
    else chosen.delete(kind)
    patch({ notifySources: SOURCE_ROWS.map((row) => row.kind).filter((k) => chosen.has(k)) })
  }

  function togglePin(id: string): void {
    const pinned = settings.pinnedServices
    patch({
      pinnedServices: pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id]
    })
  }

  function snooze(choice: SnoozeChoice): void {
    patch({
      notificationsSnoozedUntil: snoozeEnd(choice, settings, new Date()).toISOString()
    })
  }

  /** A time input reports an empty string while half-typed; only store whole times. */
  function setClock(key: 'quietHoursStart' | 'quietHoursEnd', value: string): void {
    if (/^\d{2}:\d{2}$/.test(value)) patch({ [key]: value })
  }

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

{#snippet row(title: string, description: string, control: Snippet, indent = false)}
  <div
    class={cn(
      'flex items-center justify-between gap-4 py-2',
      indent && 'pl-3',
      off && 'opacity-50'
    )}
  >
    <div class="min-w-0">
      <p class="text-[12.5px] font-medium">{title}</p>
      <p class="text-[11px] leading-snug text-muted-foreground">{description}</p>
    </div>
    <div class="shrink-0">{@render control()}</div>
  </div>
{/snippet}

{#snippet heading(title: string)}
  <h3
    class="mt-3 mb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
  >
    {title}
  </h3>
{/snippet}

<section>
  <h2 class="mb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
    Notifications
  </h2>

  <div class="flex items-center justify-between gap-4 py-2">
    <div class="min-w-0">
      <p class="text-[12.5px] font-medium">Push notifications</p>
      <p class="text-[11px] leading-snug text-muted-foreground">
        Master switch. Individual sources can still be silenced.
      </p>
    </div>
    <Switch
      checked={settings.notificationsEnabled}
      onCheckedChange={(checked) => patch({ notificationsEnabled: checked })}
      aria-label="Enable notifications"
    />
  </div>

  <Separator />

  {#snippet pauseControl()}
    {#if pausedUntil}
      <Button
        variant="outline"
        size="sm"
        disabled={off}
        onclick={() => patch({ notificationsSnoozedUntil: null })}
      >
        Resume
      </Button>
    {:else}
      <Select
        type="single"
        value=""
        disabled={off}
        onValueChange={(value) => snooze(value as SnoozeChoice)}
      >
        <SelectTrigger class="w-[8.5rem]" aria-label="Pause notifications">Pause…</SelectTrigger>
        <SelectContent>
          {#each SNOOZE_CHOICES as choice (choice.value)}
            <SelectItem value={choice.value} label={choice.label} />
          {/each}
        </SelectContent>
      </Select>
    {/if}
  {/snippet}
  {@render row(
    pausedUntil ? 'Paused' : 'Pause notifications',
    pausedUntil
      ? `Held until ${formatClock(pausedUntil, new Date(now))}, then summarized.`
      : 'For a call or a screen share. Also in the menu bar.',
    pauseControl
  )}

  <Separator />

  {#snippet soundControl()}
    <Select
      type="single"
      value={settings.notificationSound}
      disabled={off}
      onValueChange={(value) => patch({ notificationSound: value as NotificationSound })}
    >
      <SelectTrigger class="w-[8.5rem]" aria-label="When to play the notification sound"
        >{sound.label}</SelectTrigger
      >
      <SelectContent>
        {#each SOUND_CHOICES as choice (choice.value)}
          <SelectItem value={choice.value} label={choice.label} />
        {/each}
      </SelectContent>
    </Select>
  {/snippet}
  {@render row('Play sound', sound.hint, soundControl)}

  <Separator />

  {#snippet stickyControl()}
    <Switch
      checked={settings.notifyStickyOutages}
      disabled={off}
      onCheckedChange={(checked) => patch({ notifyStickyOutages: checked })}
      aria-label="Keep outages on screen"
    />
  {/snippet}
  {@render row(
    'Keep outages on screen',
    'Until dismissed. Needs the Alerts style in System Settings.',
    stickyControl
  )}

  <Separator />

  {#snippet bodyControl()}
    <Switch
      checked={settings.notificationShowBody}
      disabled={off}
      onCheckedChange={(checked) => patch({ notificationShowBody: checked })}
      aria-label="Show update text"
    />
  {/snippet}
  {@render row('Show update text', 'Off shows only the source and stage.', bodyControl)}

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
  <div class="flex items-center justify-between gap-4 py-2">
    <div class="min-w-0">
      <p class="text-[12.5px] font-medium">Test notification</p>
      <p class="text-[11px] leading-snug text-muted-foreground">
        Check that macOS is letting them through.
      </p>
    </div>
    <div class="shrink-0">{@render testControl()}</div>
  </div>

  {#if testState === 'sent'}
    <p class="px-0.5 pb-2 text-[11px] text-muted-foreground" role="status">
      Sent. If nothing appeared, check Notifications in System Settings.
    </p>
  {:else if testState === 'failed'}
    <p class="px-0.5 pb-2 text-[11px] text-destructive" role="alert">
      {testError ?? 'The system refused the notification.'}
    </p>
  {/if}

  <!-- ------------------------------------------------------------ what -->

  {@render heading('What deserves a banner')}

  <div class={cn('py-2', off && 'opacity-50')}>
    <div
      class="flex gap-0.5 rounded-lg bg-muted p-0.5"
      role="group"
      aria-label="Notification preset"
    >
      {#each NOTIFY_PRESETS as choice (choice.value)}
        <button
          type="button"
          disabled={off}
          title={choice.hint}
          aria-pressed={preset === choice.value}
          onclick={() => patch({ notifySeverities: [...choice.severities] })}
          class={cn(
            'flex-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-muted-foreground transition-colors',
            'focus-visible:ring-[2px] focus-visible:ring-ring/40 focus-visible:outline-none',
            preset === choice.value && 'bg-elevated text-foreground shadow-xs'
          )}>{choice.label}</button
        >
      {/each}
    </div>
    <p class="mt-1.5 text-[11px] leading-snug text-muted-foreground">
      {preset
        ? NOTIFY_PRESETS.find((p) => p.value === preset)?.hint
        : 'A hand-picked set of stages.'}
    </p>

    <div class="mt-2 flex flex-wrap gap-1" role="group" aria-label="Incident stages">
      {#each SEVERITY_ORDER as severity (severity)}
        {@const chosen = settings.notifySeverities.includes(severity)}
        <button
          type="button"
          disabled={off}
          aria-pressed={chosen}
          onclick={() => toggleSeverity(severity)}
          class={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
            'focus-visible:ring-[2px] focus-visible:ring-ring/40 focus-visible:outline-none',
            chosen
              ? cn('border-transparent text-foreground', SEVERITY_STYLE[severity].bg)
              : 'border-border text-muted-foreground'
          )}
        >
          <span
            class={cn(
              'size-1.5 rounded-full',
              SEVERITY_STYLE[severity].rail,
              !chosen && 'opacity-35'
            )}
            aria-hidden="true"
          ></span>
          {SEVERITY_LABEL[severity]}
        </button>
      {/each}
    </div>
  </div>

  <Separator />

  {#snippet followControl()}
    <Switch
      checked={settings.notifyFollowUpsOnly}
      disabled={off}
      onCheckedChange={(checked) => patch({ notifyFollowUpsOnly: checked })}
      aria-label="Only follow-ups for incidents I was told about"
    />
  {/snippet}
  {@render row(
    'Only follow-ups I asked for',
    'Monitoring and Resolved only for incidents you got a banner about.',
    followControl
  )}

  <!-- ------------------------------------------------------------ where -->

  {@render heading('Sources')}

  {#each SOURCE_ROWS as source, index (source.kind)}
    {#if index > 0}<Separator />{/if}
    {#snippet sourceControl()}
      <Switch
        checked={settings.notifySources.includes(source.kind)}
        disabled={off}
        onCheckedChange={(checked) => toggleSource(source.kind, checked)}
        aria-label={`Notifications from ${source.title.toLowerCase()}`}
      />
    {/snippet}
    {@render row(source.title, source.hint, sourceControl)}
  {/each}

  {#if probesOn}
    {#snippet scopeControl()}
      <Select
        type="single"
        value={settings.notifyProbeScope}
        disabled={off}
        onValueChange={(value) => patch({ notifyProbeScope: value as ProbeNotifyScope })}
      >
        <SelectTrigger class="w-[9.5rem]" aria-label="Which measured services to notify about"
          >{scope.label}</SelectTrigger
        >
        <SelectContent>
          {#each PROBE_SCOPE_CHOICES as choice (choice.value)}
            <SelectItem value={choice.value} label={choice.label} />
          {/each}
        </SelectContent>
      </Select>
    {/snippet}
    {@render row('Which services', scope.hint, scopeControl, true)}

    {#if settings.notifyProbeScope === 'pinned'}
      <div
        class={cn(
          'scroll-thin ml-3 max-h-40 overflow-y-auto rounded-md border border-border py-1',
          off && 'opacity-50'
        )}
        role="group"
        aria-label="Pinned services"
      >
        {#each services as service (service.id)}
          {@const pinned = settings.pinnedServices.includes(service.id)}
          <label
            class="flex cursor-pointer items-center gap-2 px-2 py-1 text-[11.5px] hover:bg-accent"
          >
            <input
              type="checkbox"
              class="accent-primary"
              checked={pinned}
              disabled={off}
              onchange={() => togglePin(service.id)}
            />
            <span class="min-w-0 flex-1 truncate">{service.label}</span>
            {#if service.tier === 'community'}
              <span class="shrink-0 text-[10px] text-muted-foreground">community</span>
            {/if}
          </label>
        {/each}
      </div>
    {/if}

    {#snippet graceControl()}
      <Select
        type="single"
        value={String(settings.notifyProbeGraceSec)}
        disabled={off}
        onValueChange={(value) => patch({ notifyProbeGraceSec: Number(value) })}
      >
        <SelectTrigger class="w-[8.5rem]" aria-label="How long a service must be down">
          {grace}
        </SelectTrigger>
        <SelectContent>
          {#each GRACE_CHOICES as choice (choice.value)}
            <SelectItem value={String(choice.value)} label={choice.label} />
          {/each}
        </SelectContent>
      </Select>
    {/snippet}
    {@render row(
      'Down for at least',
      'Blips shorter than this are never announced.',
      graceControl,
      true
    )}

    {#snippet recoveryControl()}
      <Switch
        checked={settings.notifyProbeRecovery}
        disabled={off}
        onCheckedChange={(checked) => patch({ notifyProbeRecovery: checked })}
        aria-label="Notify when a service recovers"
      />
    {/snippet}
    {@render row('When it recovers', 'A banner when a service is back.', recoveryControl, true)}

    {#snippet partialControl()}
      <Switch
        checked={settings.notifyProbePartial}
        disabled={off}
        onCheckedChange={(checked) => patch({ notifyProbePartial: checked })}
        aria-label="Notify when a service is partly failing"
      />
    {/snippet}
    {@render row(
      'When it is partly failing',
      'Some checks failing, others passing.',
      partialControl,
      true
    )}
  {/if}

  <!-- ------------------------------------------------------------ when -->

  {@render heading('Timing')}

  {#snippet quietControl()}
    <Switch
      checked={settings.quietHoursEnabled}
      disabled={off}
      onCheckedChange={(checked) => patch({ quietHoursEnabled: checked })}
      aria-label="Quiet hours"
    />
  {/snippet}
  {@render row(
    'Quiet hours',
    'Banners wait until the end, then arrive as one. macOS Focus still applies.',
    quietControl
  )}

  {#if settings.quietHoursEnabled}
    <div class={cn('flex items-center gap-2 py-1 pl-3', off && 'opacity-50')}>
      <Input
        type="time"
        class="h-7 w-[6.5rem] text-[12px] tabular-nums"
        value={settings.quietHoursStart}
        disabled={off}
        aria-label="Quiet hours start"
        onchange={(event) => setClock('quietHoursStart', event.currentTarget.value)}
      />
      <span class="text-[11px] text-muted-foreground">to</span>
      <Input
        type="time"
        class="h-7 w-[6.5rem] text-[12px] tabular-nums"
        value={settings.quietHoursEnd}
        disabled={off}
        aria-label="Quiet hours end"
        onchange={(event) => setClock('quietHoursEnd', event.currentTarget.value)}
      />
    </div>

    {#snippet breakthroughControl()}
      <Switch
        checked={settings.quietHoursBreakthrough}
        disabled={off}
        onCheckedChange={(checked) => patch({ quietHoursBreakthrough: checked })}
        aria-label="Let outages through quiet hours"
      />
    {/snippet}
    {@render row(
      'Let outages through',
      'Outages and degradations still get a banner.',
      breakthroughControl,
      true
    )}
  {/if}

  <Separator />

  {#snippet awayControl()}
    <Select
      type="single"
      value={settings.notifyWhenAway}
      disabled={off}
      onValueChange={(value) => patch({ notifyWhenAway: value as AwayBehaviour })}
    >
      <SelectTrigger class="w-[8.5rem]" aria-label="What to do while you are away"
        >{away.label}</SelectTrigger
      >
      <SelectContent>
        {#each AWAY_CHOICES as choice (choice.value)}
          <SelectItem value={choice.value} label={choice.label} />
        {/each}
      </SelectContent>
    </Select>
  {/snippet}
  {@render row("While I'm away", away.hint, awayControl)}

  <Separator />

  {#snippet burstControl()}
    <Switch
      checked={settings.notifyCombineBursts}
      disabled={off}
      onCheckedChange={(checked) => patch({ notifyCombineBursts: checked })}
      aria-label="Combine bursts"
    />
  {/snippet}
  {@render row(
    'Combine bursts',
    'Updates within two minutes of a banner arrive as one.',
    burstControl
  )}

  <p class="px-0.5 pt-2 text-[11px] leading-snug text-muted-foreground">
    Each account can override the stages above from the Accounts panel.
  </p>
</section>
