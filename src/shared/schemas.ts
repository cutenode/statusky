/**
 * Runtime shapes for everything that crosses IPC.
 *
 * `types.ts` stays the hand-written source of truth for the domain — it is what the
 * renderer, the model and the tests all read. This file mirrors it as Zod schemas so
 * the generated IPC wiring can *validate* those payloads at the process boundary, and
 * the `Assert<Exact<...>>` lines at the bottom fail the type-check the moment the two
 * drift apart.
 *
 * `schemas/statusky.eipc` references these by name through `zod_reference`, which is
 * how the schema language expresses types it cannot spell itself (discriminated
 * unions, mostly). Keeping one definition per type here means the generated
 * `src/ipc/common/*` re-exports our types rather than inventing parallel ones.
 */
import { z } from 'zod'
import type {
  Account,
  AccountPatch,
  AppState,
  NetworkHealth,
  NetworkReveal,
  NetworkSnapshot,
  MarkReadTrigger,
  NetworkSummary,
  Platform,
  PostEmbed,
  ProbeCheck,
  ProbeCheckKind,
  ProbeCondition,
  ProbeGroup,
  ProbeKind,
  ProbeSample,
  ProbeState,
  ProbeTier,
  ResolvedProfile,
  RichSegment,
  ServiceProbe,
  Settings,
  Severity,
  SourceKind,
  StatusPost,
  SyncStatus,
  ThemePreference,
  TrayUnreadStyle,
  WebhookState,
  WebhookStatus
} from './types'

// `zod_reference` in the schema imports its `type = "..."` from this module, so the
// domain types have to be reachable from here as well as from `./types`.
export type {
  Account,
  AccountPatch,
  AppState,
  MarkReadTrigger,
  NetworkReveal,
  NetworkSnapshot,
  Platform,
  PostEmbed,
  ResolvedProfile,
  RichSegment,
  Settings,
  Severity,
  SourceKind,
  StatusPost,
  SyncStatus,
  ThemePreference,
  TrayUnreadStyle,
  WebhookState,
  WebhookStatus
} from './types'

export const severitySchema = z.enum([
  'resolved',
  'monitoring',
  'identified',
  'investigating',
  'outage',
  'degraded',
  'maintenance',
  'update'
])

export const themePreferenceSchema = z.enum(['system', 'light', 'dark'])

export const trayUnreadStyleSchema = z.enum(['beat', 'dot', 'count', 'none'])

export const markReadTriggerSchema = z.enum(['never', 'open', 'seen'])

export const syncStatusSchema = z.enum(['idle', 'syncing', 'error'])

export const sourceKindSchema = z.enum(['atproto', 'webhook', 'probe'])

export const webhookStateSchema = z.enum(['off', 'listening', 'error'])

export const webhookStatusSchema = z.object({
  state: webhookStateSchema,
  url: z.string().nullable(),
  port: z.number().nullable(),
  error: z.string().nullable(),
  deliveries: z.number(),
  lastDeliveryAt: z.string().nullable()
})

export const platformSchema = z.enum([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
])

export const accountSchema = z.object({
  did: z.string(),
  handle: z.string(),
  displayName: z.string(),
  avatar: z.string().nullable(),
  description: z.string().nullable(),
  notify: z.boolean(),
  muted: z.boolean(),
  addedAt: z.string(),
  builtin: z.boolean(),
  kind: sourceKindSchema
})

/** Only the two fields the renderer is allowed to change. */
export const accountPatchSchema = z.object({
  notify: z.boolean().optional(),
  muted: z.boolean().optional()
})

export const richSegmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('link'), text: z.string(), uri: z.string() }),
  z.object({ kind: z.literal('mention'), text: z.string(), did: z.string() }),
  z.object({ kind: z.literal('tag'), text: z.string(), tag: z.string() })
])

export const postEmbedSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('external'),
    uri: z.string(),
    title: z.string(),
    description: z.string(),
    thumb: z.string().nullable()
  }),
  z.object({
    kind: z.literal('images'),
    images: z.array(z.object({ thumb: z.string(), fullsize: z.string(), alt: z.string() }))
  }),
  z.object({
    kind: z.literal('record'),
    uri: z.string(),
    author: z.string(),
    text: z.string()
  })
])

export const statusPostSchema = z.object({
  uri: z.string(),
  cid: z.string(),
  rkey: z.string(),
  authorDid: z.string(),
  authorHandle: z.string(),
  authorDisplayName: z.string(),
  authorAvatar: z.string().nullable(),
  text: z.string(),
  segments: z.array(richSegmentSchema),
  embed: postEmbedSchema.nullable(),
  createdAt: z.string(),
  indexedAt: z.string(),
  severity: severitySchema,
  replyCount: z.number(),
  repostCount: z.number(),
  likeCount: z.number(),
  url: z.string()
})

export const settingsSchema = z.object({
  pollIntervalSec: z.number(),
  notificationsEnabled: z.boolean(),
  notificationSound: z.boolean(),
  theme: themePreferenceSchema,
  launchAtLogin: z.boolean(),
  trayUnreadStyle: trayUnreadStyleSchema,
  markReadOn: markReadTriggerSchema,
  postsPerAccount: z.number(),
  webhookEnabled: z.boolean(),
  webhookPort: z.number(),
  networkChecks: z.boolean(),
  networkIntervalSec: z.number()
})

/** Every field optional: the renderer sends only what the user actually changed. */
export const settingsPatchSchema = settingsSchema.partial()

/** Named so `schemas/statusky.eipc` can reference it; `Partial<Settings>` is not a name. */
export type SettingsPatch = Partial<Settings>

export const probeGroupSchema = z.enum([
  'relays',
  'streams',
  'appviews',
  'pdses',
  'tangled',
  'apps',
  'infrastructure',
  'internet'
])

export const probeKindSchema = z.enum([
  'relay',
  'pds',
  'appview',
  'feed',
  'constellation',
  'cdn',
  'internet',
  'jetstream',
  'spacedust',
  'ufos',
  'slingshot',
  'foryou',
  'fleet',
  'tangled-appview',
  'bobbin',
  'hydrant',
  'knot',
  'spindle',
  'pckt',
  'leaflet',
  'offprint'
])

export const probeTierSchema = z.enum(['core', 'community'])

export const probeCheckKindSchema = z.enum(['http', 'stream', 'derived'])

export const probeStateSchema = z.enum(['pending', 'live', 'slow', 'partial', 'down'])

export const probeConditionSchema = z.enum(['unknown', 'up', 'partial', 'down'])

export const probeCheckSchema = z.object({
  label: z.string(),
  target: z.string().nullable(),
  kind: probeCheckKindSchema,
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().nullable()
})

export const probeSampleSchema = z.object({
  at: z.string(),
  state: probeStateSchema,
  latencyMs: z.number().nullable()
})

export const serviceProbeSchema = z.object({
  id: z.string(),
  group: probeGroupSchema,
  kind: probeKindSchema,
  label: z.string(),
  host: z.string(),
  tier: probeTierSchema,
  state: probeStateSchema,
  condition: probeConditionSchema,
  since: z.string().nullable(),
  checks: z.array(probeCheckSchema),
  startedAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  history: z.array(probeSampleSchema),
  rechecking: z.boolean()
})

export const networkSnapshotSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  offline: z.boolean(),
  services: z.array(serviceProbeSchema)
})

export const networkHealthSchema = z.enum([
  'off',
  'unknown',
  'operational',
  'degraded',
  'down',
  'offline'
])

export const networkSummarySchema = z.object({
  health: networkHealthSchema,
  total: z.number(),
  reachable: z.number(),
  down: z.array(z.string()),
  degraded: z.array(z.string()),
  community: z.array(z.string()),
  running: z.boolean(),
  lastSweepAt: z.string().nullable()
})

export const networkRevealSchema = z.object({
  serviceId: z.string().nullable()
})

export const appStateSchema = z.object({
  accounts: z.array(accountSchema),
  posts: z.array(statusPostSchema),
  settings: settingsSchema,
  unread: z.array(z.string()),
  sync: z.object({
    status: syncStatusSchema,
    lastSyncedAt: z.string().nullable(),
    error: z.string().nullable()
  }),
  webhook: webhookStatusSchema,
  network: networkSummarySchema,
  version: z.string()
})

export const resolvedProfileSchema = z.object({
  did: z.string(),
  handle: z.string(),
  displayName: z.string(),
  avatar: z.string().nullable(),
  description: z.string().nullable(),
  followersCount: z.number(),
  postsCount: z.number()
})

// ------------------------------------------------------- drift guards

/** True only when `A` and `B` are mutually assignable, i.e. the same type. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** Instantiating this with `false` is a compile error, which is the whole point. */
type Assert<T extends true> = T

export type _SeverityMatches = Assert<Exact<z.infer<typeof severitySchema>, Severity>>
export type _ThemeMatches = Assert<Exact<z.infer<typeof themePreferenceSchema>, ThemePreference>>
export type _TrayUnreadStyleMatches = Assert<
  Exact<z.infer<typeof trayUnreadStyleSchema>, TrayUnreadStyle>
>
export type _MarkReadTriggerMatches = Assert<
  Exact<z.infer<typeof markReadTriggerSchema>, MarkReadTrigger>
>
export type _SyncStatusMatches = Assert<Exact<z.infer<typeof syncStatusSchema>, SyncStatus>>
export type _SourceKindMatches = Assert<Exact<z.infer<typeof sourceKindSchema>, SourceKind>>
export type _WebhookStateMatches = Assert<Exact<z.infer<typeof webhookStateSchema>, WebhookState>>
export type _WebhookStatusMatches = Assert<
  Exact<z.infer<typeof webhookStatusSchema>, WebhookStatus>
>
export type _PlatformMatches = Assert<Exact<z.infer<typeof platformSchema>, Platform>>
export type _AccountMatches = Assert<Exact<z.infer<typeof accountSchema>, Account>>
export type _AccountPatchMatches = Assert<Exact<z.infer<typeof accountPatchSchema>, AccountPatch>>
export type _RichSegmentMatches = Assert<Exact<z.infer<typeof richSegmentSchema>, RichSegment>>
export type _PostEmbedMatches = Assert<Exact<z.infer<typeof postEmbedSchema>, PostEmbed>>
export type _StatusPostMatches = Assert<Exact<z.infer<typeof statusPostSchema>, StatusPost>>
export type _SettingsMatches = Assert<Exact<z.infer<typeof settingsSchema>, Settings>>
export type _SettingsPatchMatches = Assert<
  Exact<z.infer<typeof settingsPatchSchema>, Partial<Settings>>
>
export type _ProbeGroupMatches = Assert<Exact<z.infer<typeof probeGroupSchema>, ProbeGroup>>
export type _ProbeKindMatches = Assert<Exact<z.infer<typeof probeKindSchema>, ProbeKind>>
export type _ProbeTierMatches = Assert<Exact<z.infer<typeof probeTierSchema>, ProbeTier>>
export type _ProbeCheckKindMatches = Assert<
  Exact<z.infer<typeof probeCheckKindSchema>, ProbeCheckKind>
>
export type _ProbeStateMatches = Assert<Exact<z.infer<typeof probeStateSchema>, ProbeState>>
export type _ProbeConditionMatches = Assert<
  Exact<z.infer<typeof probeConditionSchema>, ProbeCondition>
>
export type _ProbeCheckMatches = Assert<Exact<z.infer<typeof probeCheckSchema>, ProbeCheck>>
export type _ProbeSampleMatches = Assert<Exact<z.infer<typeof probeSampleSchema>, ProbeSample>>
export type _ServiceProbeMatches = Assert<Exact<z.infer<typeof serviceProbeSchema>, ServiceProbe>>
export type _NetworkSnapshotMatches = Assert<
  Exact<z.infer<typeof networkSnapshotSchema>, NetworkSnapshot>
>
export type _NetworkHealthMatches = Assert<
  Exact<z.infer<typeof networkHealthSchema>, NetworkHealth>
>
export type _NetworkSummaryMatches = Assert<
  Exact<z.infer<typeof networkSummarySchema>, NetworkSummary>
>
export type _NetworkRevealMatches = Assert<
  Exact<z.infer<typeof networkRevealSchema>, NetworkReveal>
>
export type _AppStateMatches = Assert<Exact<z.infer<typeof appStateSchema>, AppState>>
export type _ResolvedProfileMatches = Assert<
  Exact<z.infer<typeof resolvedProfileSchema>, ResolvedProfile>
>
