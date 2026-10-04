<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Separator } from '$lib/components/ui/separator'
  import { Switch } from '$lib/components/ui/switch'
  import { app } from '$lib/app-state.svelte'
  import { Refusals } from '$lib/requests.svelte'
  import { cn } from '$lib/utils'
  import { relativeTime } from '@shared/time'
  import Check from '@lucide/svelte/icons/check'
  import Copy from '@lucide/svelte/icons/copy'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Refused from './Refused.svelte'

  let { now }: { now: number } = $props()

  const webhook = $derived(app.webhook)
  const enabled = $derived(app.settings.webhookEnabled)

  /** Why main refused what each control here last asked for, said beside it. */
  const refusals = new Refusals()

  /** Shown next to the button for a moment, because a copy has no other evidence. */
  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  /** Said only once main has copied it: a copy that failed is said as a failure. */
  async function copy(url: string): Promise<void> {
    const outcome = await refusals.track('copy', app.copyText(url))
    if (!outcome.ok) return
    copied = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied = false), 2000)
  }

  /**
   * Commit the port on blur or Enter rather than on every keystroke: each change
   * rebinds a socket, and typing "8080" would walk through three doomed ports first.
   *
   * Main keeps a port inside the range it can bind, so what lands may not be what was
   * typed, and a refusal lands nothing. Either way the box goes back to the port in
   * force once main has answered — which it would not do by itself whenever the setting
   * had not moved, leaving a port on screen that nothing is listening on.
   */
  async function commitPort(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const input = event.currentTarget
    const port = Number(input.value)
    // An empty or nonsensical box is someone mid-edit, not a request for port 0.
    if (!input.value.trim() || !Number.isFinite(port) || port <= 0) return
    if (port === app.settings.webhookPort) return
    await refusals.track('port', app.patchSettings({ webhookPort: port }))
    input.value = String(app.settings.webhookPort)
  }

  function onPortKey(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.key !== 'Enter') return
    void commitPort(event)
    event.currentTarget.blur()
  }

  // Only ever read inside the `enabled` branch, so it never has to describe being off.
  const statusLine = $derived.by(() => {
    if (webhook.state === 'error') return webhook.error ?? 'The receiver could not start.'
    if (webhook.state === 'listening') return `Listening on port ${webhook.port}.`
    return 'Starting…'
  })

  const deliveryLine = $derived.by(() => {
    if (!webhook.deliveries) return 'No deliveries yet.'
    const plural = webhook.deliveries === 1 ? 'delivery' : 'deliveries'
    const last = webhook.lastDeliveryAt ? `, last ${relativeTime(webhook.lastDeliveryAt, now)}` : ''
    return `${webhook.deliveries} ${plural} since launch${last}.`
  })
</script>

<section>
  <h2 class="mb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
    Pushed updates
  </h2>

  <div class="flex items-center justify-between gap-4 py-2">
    <div class="min-w-0">
      <p class="text-[12.5px] font-medium">Webhook receiver</p>
      <p class="text-[11px] leading-snug text-muted-foreground">
        Let a hosted status page push incidents straight into the feed.
      </p>
    </div>
    <div class="shrink-0">
      <Switch
        bind:checked={
          () => enabled,
          (checked) =>
            void refusals.track('enabled', app.patchSettings({ webhookEnabled: checked }))
        }
        aria-label="Enable the webhook receiver"
      />
    </div>
  </div>
  <Refused text={refusals.of('enabled')} />

  {#if enabled}
    <div class="pb-2">
      <p
        class={cn(
          'flex items-center gap-1.5 text-[11px]',
          webhook.state === 'error' ? 'text-destructive' : 'text-muted-foreground'
        )}
        role="status"
      >
        <span
          class={cn(
            'size-1.5 shrink-0 rounded-full',
            webhook.state === 'listening'
              ? 'bg-emerald-500'
              : webhook.state === 'error'
                ? 'bg-destructive'
                : 'bg-muted-foreground/50'
          )}
          aria-hidden="true"
        ></span>
        {statusLine}
      </p>

      {#if webhook.url}
        {@const url = webhook.url}
        <div class="mt-2 flex items-center gap-1.5">
          <!-- Readonly rather than disabled: the text still has to be selectable. -->
          <Input
            class="font-mono text-[11px]"
            value={url}
            readonly
            spellcheck="false"
            aria-label="Webhook endpoint URL"
            onfocus={(event) => event.currentTarget.select()}
          />
          <Button variant="outline" size="sm" class="shrink-0" onclick={() => void copy(url)}>
            {#if copied}
              <Check class="size-3.5" />
              Copied
            {:else}
              <Copy class="size-3.5" />
              Copy
            {/if}
          </Button>
        </div>
        <Refused class="pt-1 pb-0" text={refusals.of('copy')} />

        <p class="selectable mt-1.5 text-[11px] leading-snug text-muted-foreground">
          Paste this into a status page's webhook subscription — for example
          <button
            type="button"
            class="text-primary hover:underline"
            onclick={() => app.openExternal('https://status.bsky.app/subscribe/webhook')}
            >status.bsky.app/subscribe/webhook</button
          >. It only answers on this machine, so a status page on the internet needs a tunnel
          pointed at port {webhook.port}.
        </p>

        <div class="mt-2 flex items-center justify-between gap-3">
          <p class="truncate text-[11px] text-muted-foreground">{deliveryLine}</p>
          <Button
            variant="ghost"
            size="sm"
            class="shrink-0 text-muted-foreground"
            onclick={() => void refusals.track('secret', app.regenerateWebhookSecret())}
          >
            <RefreshCw class="size-3.5" />
            New secret
          </Button>
        </div>
        <Refused class="pt-1 pb-0" text={refusals.of('secret')} />
      {/if}
    </div>

    <Separator />

    <div class="flex items-center justify-between gap-4 py-2">
      <div class="min-w-0">
        <p class="text-[12.5px] font-medium">Port</p>
        <p class="text-[11px] leading-snug text-muted-foreground">
          Where the receiver listens on localhost.
        </p>
      </div>
      <Input
        class="w-24 shrink-0 tabular-nums"
        type="number"
        min="1024"
        max="65535"
        value={app.settings.webhookPort}
        aria-label="Webhook port"
        onchange={(event) => void commitPort(event)}
        onkeydown={onPortKey}
      />
    </div>
    <Refused text={refusals.of('port')} />
  {/if}
</section>
