<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Select, SelectContent, SelectItem, SelectTrigger } from '$lib/components/ui/select'
  import { Separator } from '$lib/components/ui/separator'
  import { Switch } from '$lib/components/ui/switch'
  import { app } from '$lib/app-state.svelte'
  import { PendingList, Refusals } from '$lib/requests.svelte'
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
  import Refused from './Refused.svelte'

  /** Reads the snooze against. Optional so the panel stands alone in tests. */
  let { now = Date.now() }: { now?: number } = $props()

  const settings = $derived(app.settings)
  const off = $derived(!settings.notificationsEnabled)

  // The three lists toggled an entry at a time, each built on — and drawn from — the last
  // unanswered click, so two quick ones both land.
  const severities = new PendingList(() => settings.notifySeverities)
  const sources = new PendingList(() => settings.notifySources)
  const pins = new PendingList(() => settings.pinnedServices)

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
  const preset = $derived(presetOf(severities.current))
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

  /** Why main refused what each control last asked for, said under that control. */
  const refusals = new Refusals()

  /** Change a setting for one control, and say beside it if main refuses. */
  function patch(key: string, next: Partial<Settings>): Promise<unknown> {
    return refusals.track(key, app.patchSettings(next))
  }

  function toggleSeverity(severity: Severity): void {
    const chosen = new Set(severities.current)
    if (chosen.has(severity)) chosen.delete(severity)
    else chosen.add(severity)
    // Stored in display order, so the list reads the same way the chips do.
    const next = SEVERITY_ORDER.filter((s) => chosen.has(s))
    void refusals.track(
      'severities',
      severities.send(next, (list) => app.patchSettings({ notifySeverities: list }))
    )
  }

  /** A preset replaces the list whole, and the chips build on it from there. */
  function choosePreset(next: Severity[]): void {
    void refusals.track(
      'severities',
      severities.send(next, (list) => app.patchSettings({ notifySeverities: list }))
    )
  }

  function toggleSource(kind: SourceKind, on: boolean): void {
    const chosen = new Set(sources.current)
    if (on) chosen.add(kind)
    else chosen.delete(kind)
    const next = SOURCE_ROWS.map((row) => row.kind).filter((k) => chosen.has(k))
    void refusals.track(
      kind,
      sources.send(next, (list) => app.patchSettings({ notifySources: list }))
    )
  }

  function togglePin(id: string): void {
    const before = pins.current
    const next = before.includes(id) ? before.filter((p) => p !== id) : [...before, id]
    void refusals.track(
      'pins',
      pins.send(next, (list) => app.patchSettings({ pinnedServices: list }))
    )
  }

  function snooze(choice: SnoozeChoice): void {
    void patch('pause', {
      notificationsSnoozedUntil: snoozeEnd(choice, settings, new Date()).toISOString()
    })
  }

  /**
   * A time input reports an empty string while half-typed; only store whole times.
   *
   * Once main has answered, the box is put back to what it has, which a refusal — or a
   * time main tidied — would otherwise leave out of step with the box.
   */
  async function setClock(
    event: Event & { currentTarget: HTMLInputElement },
    key: 'quietHoursStart' | 'quietHoursEnd'
  ): Promise<void> {
    const input = event.currentTarget
    if (!/^\d{2}:\d{2}$/.test(input.value)) return
    await patch('quietHours', { [key]: input.value })
    input.value = settings[key]
  }

  // A refused notification is invisible by definition, so the button has to say
  // what happened rather than just firing and hoping.
  let testState = $state<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  let testError = $state<string | null>(null)

  async function sendTest(): Promise<void> {
    testState = 'sending'
    testError = null
    // This call's own answer: nothing else that happens meanwhile is mistaken for it.
    const outcome = await app.testNotification()
    testError = outcome.ok ? null : outcome.error
    testState = outcome.ok ? 'sent' : 'failed'
  }
</script>

{#snippet row(title: string, description: string, control: Snippet, key: string, indent = false)}
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
  <Refused class={cn(indent && 'pl-3')} text={refusals.of(key)} />
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
      bind:checked={
        () => settings.notificationsEnabled,
        (checked) => void patch('enabled', { notificationsEnabled: checked })
      }
      aria-label="Enable notifications"
    />
  </div>
  <Refused text={refusals.of('enabled')} />

  <Separator />

  {#snippet pauseControl()}
    {#if pausedUntil}
      <Button
        variant="outline"
        size="sm"
        disabled={off}
        onclick={() => void patch('pause', { notificationsSnoozedUntil: null })}
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
    pauseControl,
    'pause'
  )}

  <Separator />

  {#snippet soundControl()}
    <Select
      type="single"
      bind:value={
        () => settings.notificationSound,
        (value) => void patch('sound', { notificationSound: value as NotificationSound })
      }
      disabled={off}
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
  {@render row('Play sound', sound.hint, soundControl, 'sound')}

  <Separator />

  {#snippet stickyControl()}
    <Switch
      bind:checked={
        () => settings.notifyStickyOutages,
        (checked) => void patch('sticky', { notifyStickyOutages: checked })
      }
      disabled={off}
      aria-label="Keep outages on screen"
    />
  {/snippet}
  {@render row(
    'Keep outages on screen',
    'Until dismissed. Needs the Alerts style in System Settings.',
    stickyControl,
    'sticky'
  )}

  <Separator />

  {#snippet bodyControl()}
    <Switch
      bind:checked={
        () => settings.notificationShowBody,
        (checked) => void patch('body', { notificationShowBody: checked })
      }
      disabled={off}
      aria-label="Show update text"
    />
  {/snippet}
  {@render row('Show update text', 'Off shows only the source and stage.', bodyControl, 'body')}

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
    <Refused text={testError} />
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
          onclick={() => choosePreset([...choice.severities])}
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
        {@const chosen = severities.current.includes(severity)}
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
  <Refused text={refusals.of('severities')} />

  <Separator />

  {#snippet followControl()}
    <Switch
      bind:checked={
        () => settings.notifyFollowUpsOnly,
        (checked) => void patch('followUps', { notifyFollowUpsOnly: checked })
      }
      disabled={off}
      aria-label="Only follow-ups for incidents I was told about"
    />
  {/snippet}
  {@render row(
    'Only follow-ups I asked for',
    'Monitoring and Resolved only for incidents you got a banner about.',
    followControl,
    'followUps'
  )}

  <!-- ------------------------------------------------------------ where -->

  {@render heading('Sources')}

  {#each SOURCE_ROWS as source, index (source.kind)}
    {#if index > 0}<Separator />{/if}
    {#snippet sourceControl()}
      <Switch
        bind:checked={
          () => sources.current.includes(source.kind),
          (checked) => toggleSource(source.kind, checked)
        }
        disabled={off}
        aria-label={`Notifications from ${source.title.toLowerCase()}`}
      />
    {/snippet}
    {@render row(source.title, source.hint, sourceControl, source.kind)}
  {/each}

  {#if probesOn}
    {#snippet scopeControl()}
      <Select
        type="single"
        bind:value={
          () => settings.notifyProbeScope,
          (value) => void patch('scope', { notifyProbeScope: value as ProbeNotifyScope })
        }
        disabled={off}
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
    {@render row('Which services', scope.hint, scopeControl, 'scope', true)}

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
          {@const pinned = pins.current.includes(service.id)}
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
      <Refused class="pt-1 pl-3" text={refusals.of('pins')} />
    {/if}

    {#snippet graceControl()}
      <Select
        type="single"
        bind:value={
          () => String(settings.notifyProbeGraceSec),
          (value) => void patch('grace', { notifyProbeGraceSec: Number(value) })
        }
        disabled={off}
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
      'grace',
      true
    )}

    {#snippet recoveryControl()}
      <Switch
        bind:checked={
          () => settings.notifyProbeRecovery,
          (checked) => void patch('recovery', { notifyProbeRecovery: checked })
        }
        disabled={off}
        aria-label="Notify when a service recovers"
      />
    {/snippet}
    {@render row(
      'When it recovers',
      'A banner when a service is back.',
      recoveryControl,
      'recovery',
      true
    )}

    {#snippet partialControl()}
      <Switch
        bind:checked={
          () => settings.notifyProbePartial,
          (checked) => void patch('partial', { notifyProbePartial: checked })
        }
        disabled={off}
        aria-label="Notify when a service is partly failing"
      />
    {/snippet}
    {@render row(
      'When it is partly failing',
      'Some checks failing, others passing.',
      partialControl,
      'partial',
      true
    )}
  {/if}

  <!-- ------------------------------------------------------------ when -->

  {@render heading('Timing')}

  {#snippet quietControl()}
    <Switch
      bind:checked={
        () => settings.quietHoursEnabled,
        (checked) => void patch('quietHoursEnabled', { quietHoursEnabled: checked })
      }
      disabled={off}
      aria-label="Quiet hours"
    />
  {/snippet}
  {@render row(
    'Quiet hours',
    'Banners wait until the end, then arrive as one. macOS Focus still applies.',
    quietControl,
    'quietHoursEnabled'
  )}

  {#if settings.quietHoursEnabled}
    <div class={cn('flex items-center gap-2 py-1 pl-3', off && 'opacity-50')}>
      <Input
        type="time"
        class="h-7 w-[6.5rem] text-[12px] tabular-nums"
        value={settings.quietHoursStart}
        disabled={off}
        aria-label="Quiet hours start"
        onchange={(event) => void setClock(event, 'quietHoursStart')}
      />
      <span class="text-[11px] text-muted-foreground">to</span>
      <Input
        type="time"
        class="h-7 w-[6.5rem] text-[12px] tabular-nums"
        value={settings.quietHoursEnd}
        disabled={off}
        aria-label="Quiet hours end"
        onchange={(event) => void setClock(event, 'quietHoursEnd')}
      />
    </div>
    <Refused class="pt-1 pl-3" text={refusals.of('quietHours')} />

    {#snippet breakthroughControl()}
      <Switch
        bind:checked={
          () => settings.quietHoursBreakthrough,
          (checked) => void patch('breakthrough', { quietHoursBreakthrough: checked })
        }
        disabled={off}
        aria-label="Let outages through quiet hours"
      />
    {/snippet}
    {@render row(
      'Let outages through',
      'Outages and degradations still get a banner.',
      breakthroughControl,
      'breakthrough',
      true
    )}
  {/if}

  <Separator />

  {#snippet awayControl()}
    <Select
      type="single"
      bind:value={
        () => settings.notifyWhenAway,
        (value) => void patch('away', { notifyWhenAway: value as AwayBehaviour })
      }
      disabled={off}
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
  {@render row("While I'm away", away.hint, awayControl, 'away')}

  <Separator />

  {#snippet burstControl()}
    <Switch
      bind:checked={
        () => settings.notifyCombineBursts,
        (checked) => void patch('bursts', { notifyCombineBursts: checked })
      }
      disabled={off}
      aria-label="Combine bursts"
    />
  {/snippet}
  {@render row(
    'Combine bursts',
    'Updates within two minutes of a banner arrive as one.',
    burstControl,
    'bursts'
  )}

  <p class="px-0.5 pt-2 text-[11px] leading-snug text-muted-foreground">
    Each account can override the stages above from the Accounts panel.
  </p>
</section>
