import CircleCheck from '@lucide/svelte/icons/circle-check'
import RadioTower from '@lucide/svelte/icons/radio-tower'
import Crosshair from '@lucide/svelte/icons/crosshair'
import SearchCheck from '@lucide/svelte/icons/search-check'
import CloudOff from '@lucide/svelte/icons/cloud-off'
import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
import Wrench from '@lucide/svelte/icons/wrench'
import Megaphone from '@lucide/svelte/icons/megaphone'
import type { Component } from 'svelte'
import type { ProbeState, Severity } from '@shared/types'
import type { Health } from '@shared/status'

export interface SeverityStyle {
  /** Full class strings, not interpolated — Tailwind only sees literals. */
  text: string
  bg: string
  rail: string
  ring: string
  /**
   * A whole row tinted by its severity, for the timeline. An eighth of `bg`'s strength:
   * this sits under body text on a translucent surface, where anything you can name a
   * colour for is already too much.
   */
  wash: string
  /**
   * A halo for a timeline node that is still unread, so it reads as lit rather than as
   * a flat disc — the same two-stop trick the dashboard lights its LEDs with.
   */
  glow: string
  icon: Component
}

export const SEVERITY_STYLE: Record<Severity, SeverityStyle> = {
  resolved: {
    text: 'text-sev-resolved',
    bg: 'bg-sev-resolved/12',
    rail: 'bg-sev-resolved',
    ring: 'ring-sev-resolved/30',
    wash: 'bg-sev-resolved/[0.045]',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-resolved)_20%,transparent),0_0_9px_color-mix(in_oklch,var(--sev-resolved)_50%,transparent)]',
    icon: CircleCheck
  },
  monitoring: {
    text: 'text-sev-monitoring',
    bg: 'bg-sev-monitoring/12',
    rail: 'bg-sev-monitoring',
    ring: 'ring-sev-monitoring/30',
    wash: 'bg-sev-monitoring/[0.045]',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-monitoring)_20%,transparent),0_0_9px_color-mix(in_oklch,var(--sev-monitoring)_50%,transparent)]',
    icon: RadioTower
  },
  identified: {
    text: 'text-sev-identified',
    bg: 'bg-sev-identified/12',
    rail: 'bg-sev-identified',
    ring: 'ring-sev-identified/30',
    wash: 'bg-sev-identified/[0.045]',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-identified)_20%,transparent),0_0_9px_color-mix(in_oklch,var(--sev-identified)_50%,transparent)]',
    icon: Crosshair
  },
  investigating: {
    text: 'text-sev-investigating',
    bg: 'bg-sev-investigating/12',
    rail: 'bg-sev-investigating',
    ring: 'ring-sev-investigating/30',
    wash: 'bg-sev-investigating/[0.045]',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-investigating)_20%,transparent),0_0_9px_color-mix(in_oklch,var(--sev-investigating)_50%,transparent)]',
    icon: SearchCheck
  },
  outage: {
    text: 'text-sev-outage',
    bg: 'bg-sev-outage/12',
    rail: 'bg-sev-outage',
    ring: 'ring-sev-outage/30',
    wash: 'bg-sev-outage/[0.045]',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-outage)_20%,transparent),0_0_9px_color-mix(in_oklch,var(--sev-outage)_50%,transparent)]',
    icon: CloudOff
  },
  degraded: {
    text: 'text-sev-degraded',
    bg: 'bg-sev-degraded/12',
    rail: 'bg-sev-degraded',
    ring: 'ring-sev-degraded/30',
    wash: 'bg-sev-degraded/[0.045]',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-degraded)_20%,transparent),0_0_9px_color-mix(in_oklch,var(--sev-degraded)_50%,transparent)]',
    icon: TriangleAlert
  },
  maintenance: {
    text: 'text-sev-maintenance',
    bg: 'bg-sev-maintenance/12',
    rail: 'bg-sev-maintenance',
    ring: 'ring-sev-maintenance/30',
    wash: 'bg-sev-maintenance/[0.045]',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-maintenance)_20%,transparent),0_0_9px_color-mix(in_oklch,var(--sev-maintenance)_50%,transparent)]',
    icon: Wrench
  },
  update: {
    text: 'text-sev-update',
    bg: 'bg-sev-update/12',
    rail: 'bg-sev-update',
    ring: 'ring-sev-update/30',
    wash: 'bg-sev-update/[0.045]',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-update)_20%,transparent),0_0_9px_color-mix(in_oklch,var(--sev-update)_50%,transparent)]',
    icon: Megaphone
  }
}

export const HEALTH_STYLE: Record<Health, { dot: string; text: string; glow: string }> = {
  operational: {
    dot: 'bg-sev-resolved',
    text: 'text-sev-resolved',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-resolved)_22%,transparent)]'
  },
  monitoring: {
    dot: 'bg-sev-monitoring',
    text: 'text-sev-monitoring',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-monitoring)_22%,transparent)]'
  },
  maintenance: {
    dot: 'bg-sev-maintenance',
    text: 'text-sev-maintenance',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-maintenance)_22%,transparent)]'
  },
  degraded: {
    dot: 'bg-sev-degraded',
    text: 'text-sev-degraded',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-degraded)_22%,transparent)]'
  },
  incident: {
    dot: 'bg-sev-outage',
    text: 'text-sev-outage',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-outage)_22%,transparent)]'
  },
  offline: {
    dot: 'bg-muted-foreground/70',
    text: 'text-muted-foreground',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--muted-foreground)_18%,transparent)]'
  },
  unknown: {
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    glow: ''
  }
}

export interface ProbeStateStyle {
  label: string
  /** The LED itself. */
  dot: string
  /** A soft halo, so a lit LED reads as lit rather than as a flat circle. */
  glow: string
  text: string
  /** One bar of the uptime strip. */
  bar: string
}

/** How each observed state of a service is drawn: LEDs, labels and uptime bars. */
export const PROBE_STATE_STYLE: Record<ProbeState, ProbeStateStyle> = {
  pending: {
    label: 'Checking',
    dot: 'bg-muted-foreground/45',
    glow: '',
    text: 'text-muted-foreground',
    bar: 'bg-muted-foreground/30'
  },
  live: {
    label: 'Live',
    dot: 'bg-sev-resolved',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-resolved)_20%,transparent),0_0_8px_color-mix(in_oklch,var(--sev-resolved)_55%,transparent)]',
    text: 'text-sev-resolved',
    bar: 'bg-sev-resolved/85'
  },
  slow: {
    label: 'Slow',
    dot: 'bg-sev-degraded',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-degraded)_20%,transparent),0_0_8px_color-mix(in_oklch,var(--sev-degraded)_55%,transparent)]',
    text: 'text-sev-degraded',
    bar: 'bg-sev-degraded'
  },
  partial: {
    label: 'Partial',
    dot: 'bg-sev-investigating',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-investigating)_22%,transparent),0_0_8px_color-mix(in_oklch,var(--sev-investigating)_60%,transparent)]',
    text: 'text-sev-investigating',
    bar: 'bg-sev-investigating'
  },
  down: {
    label: 'Down',
    dot: 'bg-sev-outage',
    glow: 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--sev-outage)_22%,transparent),0_0_10px_color-mix(in_oklch,var(--sev-outage)_65%,transparent)]',
    text: 'text-sev-outage',
    bar: 'bg-sev-outage'
  }
}
