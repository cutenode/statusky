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
import { EXPECTED_RESPONSES } from './expected-responses'
import DEFAULT_TARGETS from './probeTargets.json'
import { z } from './zod'
import type {
  Account,
  AccountPatch,
  AppState,
  AwayBehaviour,
  LoginItemStatus,
  NetworkHealth,
  NetworkReveal,
  NetworkSnapshot,
  MarkReadTrigger,
  NetworkSummary,
  NotificationSound,
  NotifyLevel,
  Platform,
  PostEmbed,
  ProbeCheck,
  ProbeCheckKind,
  ProbeCondition,
  ProbeGroup,
  ProbeKind,
  ProbeNotifyScope,
  ProbeSample,
  ProbeState,
  ProbeTier,
  ProbeAccount,
  ProbeFeed,
  ProbeImage,
  ProbeRecord,
  ProbeTargets,
  ResolvedProfile,
  RichSegment,
  ServiceProbe,
  VanishedTarget,
  Settings,
  Severity,
  ShortcutStatus,
  SourceKind,
  StatusPost,
  SweepRestraint,
  SyncStatus,
  ThemePreference,
  TrayUnreadStyle,
  UpdateStage,
  UpdateStatus,
  WebhookState,
  WebhookStatus
} from './types'

// `zod_reference` in the schema imports its `type = "..."` from this module, so the
// domain types have to be reachable from here as well as from `./types`.
export type {
  Account,
  AccountPatch,
  AppState,
  LoginItemStatus,
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
  SweepRestraint,
  SyncStatus,
  ThemePreference,
  TrayUnreadStyle,
  UpdateStage,
  UpdateStatus,
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

export const notifyLevelSchema = z.enum(['default', 'all', 'outages', 'off'])

export const notificationSoundSchema = z.enum(['all', 'urgent', 'never'])

export const probeNotifyScopeSchema = z.enum(['core', 'all', 'pinned'])

export const awayBehaviourSchema = z.enum(['digest', 'deliver', 'drop'])

/** `HH:MM`, 24-hour. Anything else would make the quiet-hours window unknowable. */
const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

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

export const loginItemStatusSchema = z.object({
  registered: z.boolean(),
  error: z.string().nullable()
})

export const shortcutStatusSchema = z.object({
  registered: z.boolean(),
  error: z.string().nullable()
})

export const updateStageSchema = z.enum(['current', 'available', 'ready'])

export const updateStatusSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('current'), version: z.null() }),
  z.object({ stage: z.literal('available'), version: z.string() }),
  z.object({ stage: z.literal('ready'), version: z.string().nullable() })
])

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
  notify: notifyLevelSchema,
  muted: z.boolean(),
  addedAt: z.string(),
  builtin: z.boolean(),
  kind: sourceKindSchema
})

/**
 * Whether a patch leaves out what it is not changing, rather than sending it as `undefined`.
 *
 * `.optional()` accepts a key that is present with nothing in it, structured clone carries
 * one across IPC intact, and `Partial<>` admits one in the type. But main spreads a patch
 * over what it has stored, so `{ muted: undefined }` would not leave the field alone: it
 * would erase it, and every `AppState` pushed after that would fail validation.
 */
function leavesOutUnchanged(patch: object): boolean {
  return Object.values(patch).every((value) => value !== undefined)
}

/** What `leavesOutUnchanged` says when it refuses a patch. */
const UNDEFINED_FIELD = 'Leave out a field that is not changing rather than sending undefined'

/**
 * Only the two fields the renderer is allowed to change, and nothing else.
 *
 * Strict, because the generated wiring asks a schema only *whether* an argument is valid
 * and then hands main the argument as it arrived, not the parsed copy. A key a plain
 * `z.object` merely strips on parsing — `builtin: false`, say — would pass, and be
 * spread over the stored account all the same, making a shipped source removable.
 */
export const accountPatchSchema = z
  .strictObject({
    notify: notifyLevelSchema.optional(),
    muted: z.boolean().optional()
  })
  .refine(leavesOutUnchanged, UNDEFINED_FIELD)

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

// ------------------------------------------------------- probe targets
//
// Unlike the rest of this file, these check the *content* of what crosses, not only its
// shape: a probe target is typed in by a person or read out of a file they chose, and a
// malformed DID or a path in the wrong form would otherwise be found out as an outage.
// So each rule says what it wants in words, for the Settings panel to show beside the
// field it is about. See `validateProbeTargets` in src/shared/probe-targets.ts.

/**
 * The most of each list a user may ask for.
 *
 * Every account is three requests to every AppView, every sweep, and the AppViews are
 * other people's infrastructure: ten is already thirty requests apiece, where the
 * defaults make eighteen. Feeds and images are one request each, but each feed is its
 * own dashboard row and each image a full-size fetch, so they are held to a handful too.
 * A PDS is five requests and a row of its own, and five is more than one person runs.
 */
export const PROBE_TARGET_LIMITS = { accounts: 10, feeds: 10, pdses: 5, cdnImages: 5 } as const

/** `did:<method>:<identifier>`, as the atproto DID syntax allows it. */
const DID_SOURCE = 'did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]'
/** A lower-case DNS name of two labels or more: a handle, or a host. */
const DOMAIN_SOURCE =
  '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?'
/** An atproto record key: anything from this alphabet, except `.` and `..`. */
const RKEY_SOURCE = '(?!\\.{1,2}$)[a-zA-Z0-9._:~-]{1,512}'
/** The record type a feed's AT-URI has to name for `getFeedSkeleton` to accept it. */
const FEED_GENERATOR = 'app.bsky.feed.generator'

const didSchema = z
  .string()
  .trim()
  .max(2048)
  .regex(new RegExp(`^${DID_SOURCE}$`), 'Must be a DID, such as did:plc:…')

/** Handles and hosts are case-insensitive, so they are compared and stored lower-case. */
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(new RegExp(`^${DOMAIN_SOURCE}$`), 'Must be a domain name, such as example.com')

const rkeySchema = z
  .string()
  .trim()
  .regex(new RegExp(`^${RKEY_SOURCE}$`), 'Must be a record key')

/** An `at://` URI naming one record of `collection`, by DID. */
function atUriSchema(collection: string): z.ZodString {
  const escaped = collection.replaceAll('.', '\\.')
  return z
    .string()
    .trim()
    .regex(
      new RegExp(`^at://${DID_SOURCE}/${escaped}/${RKEY_SOURCE}$`),
      `Must be the at:// URI of a ${collection} record`
    )
}

/**
 * Flag every entry that repeats an earlier one's `key`, at the entry itself, so the
 * Settings panel can put the message beside the right row.
 */
function uniqueBy<T>(key: keyof T & string, noun: string) {
  return (list: T[], ctx: z.RefinementCtx<T[]>): void => {
    const first = new Map<unknown, number>()
    list.forEach((item, index) => {
      const earlier = first.get(item[key])
      if (earlier === undefined) {
        first.set(item[key], index)
        return
      }
      ctx.addIssue({
        code: 'custom',
        path: [index, key],
        message: `Same ${noun} as entry ${earlier + 1}`
      })
    })
  }
}

export const probeAccountSchema = z.object({ did: didSchema, handle: domainSchema })

export const probeFeedSchema = z.object({
  label: z.string().trim().min(1, 'Needs a label').max(80, 'At most 80 characters'),
  host: domainSchema,
  uri: atUriSchema(FEED_GENERATOR)
})

export const probeRecordSchema = z.object({ did: didSchema, rkey: rkeySchema })

/** Flag every host that repeats an earlier one, at the entry itself. */
function uniqueHosts(list: string[], ctx: z.RefinementCtx<string[]>): void {
  const first = new Map<string, number>()
  list.forEach((host, index) => {
    const earlier = first.get(host)
    if (earlier === undefined) {
      first.set(host, index)
      return
    }
    ctx.addIssue({ code: 'custom', path: [index], message: `Same host as entry ${earlier + 1}` })
  })
}

export const probeImageSchema = z.object({
  did: didSchema,
  // CIDv1 in base32, which is what the CDN's image paths carry.
  cid: z
    .string()
    .trim()
    .regex(/^b[a-z2-7]{20,}$/, 'Must be a CID, such as bafkrei…')
})

export const probeTargetsSchema = z.object({
  accounts: z
    .array(probeAccountSchema)
    // The AppViews' freshness check compares newest posts, and needs somebody's.
    .min(1, 'List at least one account')
    .max(PROBE_TARGET_LIMITS.accounts, `At most ${PROBE_TARGET_LIMITS.accounts} accounts`)
    .superRefine(uniqueBy('did', 'DID'))
    .superRefine(uniqueBy('handle', 'handle')),
  feeds: z
    .array(probeFeedSchema)
    .max(PROBE_TARGET_LIMITS.feeds, `At most ${PROBE_TARGET_LIMITS.feeds} feeds`)
    // A feed is one dashboard row, and a row is `feed:<host>`: one feed per generator
    // host, which is also one service, so a second feed there would measure it twice.
    .superRefine(uniqueBy('host', 'host')),
  // Optional in a document, so an override saved or exported before this list existed
  // is still a valid one rather than being dropped for lacking it.
  pdses: z
    .array(domainSchema)
    .max(PROBE_TARGET_LIMITS.pdses, `At most ${PROBE_TARGET_LIMITS.pdses} PDSes`)
    .superRefine(uniqueHosts)
    .default([]),
  forYou: z.object({ did: didSchema, feed: atUriSchema(FEED_GENERATOR) }),
  cdnImages: z
    .array(probeImageSchema)
    // A CDN row with nothing to fetch would never finish being checked.
    .min(1, 'List at least one image')
    .max(PROBE_TARGET_LIMITS.cdnImages, `At most ${PROBE_TARGET_LIMITS.cdnImages} images`),
  tangled: z.object({
    // A path on the Tangled AppView and nowhere else. `//host/…` is a URL to another
    // host as far as the URL parser is concerned, and so is `/\host/…`, since it reads a
    // backslash as a slash: either would send the check to whatever host it named, a
    // service on this machine's own loopback included. So neither may start the path,
    // and no backslash may appear in it at all.
    goGetPath: z
      .string()
      .trim()
      .regex(
        /^\/(?![/\\])[^\s?#\\]*\?(?:[^\s#\\]*&)?go-get=1(?:&[^\s#\\]*)?$/,
        'Must be a path ending in ?go-get=1, such as /core?go-get=1'
      ),
    repoPath: z
      .string()
      .trim()
      .regex(
        new RegExp(`^/${DOMAIN_SOURCE}/[a-zA-Z0-9._-]+$`),
        'Must be /<owner handle>/<repository>, with the owner as a lower-case handle'
      ),
    repoDid: didSchema,
    ownerDid: didSchema
  }),
  apps: z.object({
    // Defaulted for the reason `pdses` is: an override saved before pckt had a target
    // is still a valid one, rather than being dropped for lacking it.
    pckt: z
      .object({ publication: atUriSchema(EXPECTED_RESPONSES.standardSite.publicationCollection) })
      .default({ publication: DEFAULT_TARGETS.apps.pckt.publication }),
    leaflet: z.object({ publication: probeRecordSchema, feed: probeRecordSchema }),
    offprint: z.object({
      publication: atUriSchema(EXPECTED_RESPONSES.standardSite.publicationCollection)
    })
  })
})

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

export const settingsSchema = z.object({
  pollIntervalSec: z.number(),
  notificationsEnabled: z.boolean(),
  notificationSound: notificationSoundSchema,
  notifyStickyOutages: z.boolean(),
  notifySeverities: z.array(severitySchema),
  notifyFollowUpsOnly: z.boolean(),
  notifySources: z.array(sourceKindSchema),
  notifyProbeScope: probeNotifyScopeSchema,
  notifyProbeGraceSec: z.number(),
  notifyProbeRecovery: z.boolean(),
  notifyProbePartial: z.boolean(),
  quietHoursEnabled: z.boolean(),
  quietHoursStart: clockTimeSchema,
  quietHoursEnd: clockTimeSchema,
  quietHoursBreakthrough: z.boolean(),
  notifyWhenAway: awayBehaviourSchema,
  notifyCombineBursts: z.boolean(),
  notificationsSnoozedUntil: z.string().nullable(),
  notificationShowBody: z.boolean(),
  pinnedServices: z.array(z.string()),
  countedProbeGroups: z.array(probeGroupSchema),
  theme: themePreferenceSchema,
  launchAtLogin: z.boolean(),
  trayUnreadStyle: trayUnreadStyleSchema,
  markReadOn: markReadTriggerSchema,
  postsPerAccount: z.number(),
  webhookEnabled: z.boolean(),
  webhookPort: z.number(),
  networkChecks: z.boolean(),
  networkIntervalSec: z.number(),
  globalShortcut: z.string(),
  probeTargets: probeTargetsSchema.nullable()
})

/**
 * Every field optional: the renderer sends only what the user actually changed.
 *
 * Strict for the reason `accountPatchSchema` is: main spreads the patch it was handed,
 * not the parsed copy, so a key no setting has would otherwise be persisted beside the
 * real ones and carried in every `AppState` from then on. The refinement comes after
 * `.partial()` because `.partial()` drops any it is given.
 */
export const settingsPatchSchema = z
  .strictObject(settingsSchema.shape)
  .partial()
  .refine(leavesOutUnchanged, UNDEFINED_FIELD)

/** Named so `schemas/statusky.eipc` can reference it; `Partial<Settings>` is not a name. */
export type SettingsPatch = Partial<Settings>

export const probeKindSchema = z.enum([
  'relay',
  'pds',
  'entryway',
  'appview',
  'feed',
  'constellation',
  'cdn',
  'plc',
  'internet',
  'jetstream',
  'spacedust',
  'ufos',
  'slingshot',
  'foryou',
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
  durationMs: z.number().nullable(),
  excused: z.string().optional()
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

export const sweepRestraintSchema = z.enum(['battery', 'thermal'])

export const vanishedTargetSchema = z.object({
  did: z.string(),
  part: z.enum(['account', 'handle'])
})

export const networkSnapshotSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  offline: z.boolean(),
  restraint: sweepRestraintSchema.nullable(),
  vanished: z.array(vanishedTargetSchema),
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
  uncounted: z.array(z.string()),
  vanished: z.array(vanishedTargetSchema),
  running: z.boolean(),
  lastSweepAt: z.string().nullable(),
  restraint: sweepRestraintSchema.nullable()
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
  loginItem: loginItemStatusSchema,
  shortcut: shortcutStatusSchema,
  update: updateStatusSchema,
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

/**
 * True only when `A` and `B` are the same type, as the compiler itself decides identity.
 *
 * Not mutual assignability, which is what `[A] extends [B]` both ways would test: that
 * passes when either side is `any`, and cannot see a `readonly` on one side only. The
 * compiler relates two unresolved `T extends X ? 1 : 2` only when their `X`s are
 * identical, so comparing one built over each side asks the stricter question.
 */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
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
export type _NotifyLevelMatches = Assert<Exact<z.infer<typeof notifyLevelSchema>, NotifyLevel>>
export type _NotificationSoundMatches = Assert<
  Exact<z.infer<typeof notificationSoundSchema>, NotificationSound>
>
export type _ProbeNotifyScopeMatches = Assert<
  Exact<z.infer<typeof probeNotifyScopeSchema>, ProbeNotifyScope>
>
export type _AwayBehaviourMatches = Assert<
  Exact<z.infer<typeof awayBehaviourSchema>, AwayBehaviour>
>
export type _SourceKindMatches = Assert<Exact<z.infer<typeof sourceKindSchema>, SourceKind>>
export type _WebhookStateMatches = Assert<Exact<z.infer<typeof webhookStateSchema>, WebhookState>>
export type _WebhookStatusMatches = Assert<
  Exact<z.infer<typeof webhookStatusSchema>, WebhookStatus>
>
export type _LoginItemStatusMatches = Assert<
  Exact<z.infer<typeof loginItemStatusSchema>, LoginItemStatus>
>
export type _ShortcutStatusMatches = Assert<
  Exact<z.infer<typeof shortcutStatusSchema>, ShortcutStatus>
>
export type _UpdateStageMatches = Assert<Exact<z.infer<typeof updateStageSchema>, UpdateStage>>
export type _UpdateStatusMatches = Assert<Exact<z.infer<typeof updateStatusSchema>, UpdateStatus>>
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
export type _VanishedTargetMatches = Assert<
  Exact<z.infer<typeof vanishedTargetSchema>, VanishedTarget>
>
export type _SweepRestraintMatches = Assert<
  Exact<z.infer<typeof sweepRestraintSchema>, SweepRestraint>
>
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
export type _ProbeAccountMatches = Assert<Exact<z.infer<typeof probeAccountSchema>, ProbeAccount>>
export type _ProbeFeedMatches = Assert<Exact<z.infer<typeof probeFeedSchema>, ProbeFeed>>
export type _ProbeRecordMatches = Assert<Exact<z.infer<typeof probeRecordSchema>, ProbeRecord>>
export type _ProbeImageMatches = Assert<Exact<z.infer<typeof probeImageSchema>, ProbeImage>>
export type _ProbeTargetsMatches = Assert<Exact<z.infer<typeof probeTargetsSchema>, ProbeTargets>>
