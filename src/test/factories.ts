/**
 * Builders for the app's domain objects.
 *
 * Every builder is total: it returns a valid object with no arguments, so a test
 * only names the fields it actually cares about and stays readable when the shape
 * of `Account` or `StatusPost` grows.
 */
import { DEFAULT_SETTINGS } from '../shared/defaults'
import { postPermalink, rkeyFromUri } from '../shared/bsky'
import { SERVICES, blankService } from '../shared/network'
import { classifySeverity } from '../shared/status'
import type {
  Account,
  AppState,
  NetworkSnapshot,
  NetworkSummary,
  PostEmbed,
  ProbeCheck,
  ServiceProbe,
  ResolvedProfile,
  RichSegment,
  Settings,
  StatusPost,
  WebhookStatus
} from '../shared/types'

export const DID = {
  bsky: 'did:plc:4dtbz2ivhp5app3sbntcccxc',
  blacksky: 'did:plc:njxo6cs5a6jjk4c2z6dhecsc',
  custom: 'did:plc:customaccount000000000',
  other: 'did:plc:otheraccount0000000000'
} as const

let seq = 0

export function makeAccount(overrides: Partial<Account> = {}): Account {
  const did = overrides.did ?? `did:plc:test${(seq++).toString(36).padStart(4, '0')}`
  const handle = overrides.handle ?? `${did.slice(-6)}.status.test`
  return {
    did,
    handle,
    displayName: handle,
    avatar: null,
    description: null,
    notify: 'default',
    muted: false,
    addedAt: '2026-01-01T00:00:00.000Z',
    builtin: false,
    kind: 'atproto',
    ...overrides
  }
}

export function makeWebhookStatus(overrides: Partial<WebhookStatus> = {}): WebhookStatus {
  return {
    state: 'off',
    url: null,
    port: null,
    error: null,
    deliveries: 0,
    lastDeliveryAt: null,
    ...overrides
  }
}

/**
 * A timestamp a moment ago, for a fixture that is meant to be happening now.
 *
 * `makePost` dates a post to a fixed instant, which is what keeps ordering and
 * formatting assertions stable. Health needs the other thing: a claim only speaks for
 * the present while it is recent, so a test about an incident happening *now* has to
 * say when — see `deriveClaim`.
 */
export function justPosted(minutesAgo = 1): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

export interface PostOverrides extends Partial<StatusPost> {
  /** Convenience: derive `uri`, `rkey` and `url` from a record key. */
  rkey?: string
}

export function makePost(overrides: PostOverrides = {}): StatusPost {
  const authorDid = overrides.authorDid ?? DID.bsky
  const authorHandle = overrides.authorHandle ?? 'status.bsky.app'
  const rkey = overrides.rkey ?? `3post${(seq++).toString(36)}`
  const uri = overrides.uri ?? `at://${authorDid}/app.bsky.feed.post/${rkey}`
  const text = overrides.text ?? 'Everything is operational.'
  const createdAt = overrides.createdAt ?? '2026-01-01T12:00:00.000Z'
  const segments: RichSegment[] = overrides.segments ?? (text ? [{ kind: 'text', text }] : [])

  return {
    uri,
    cid: `bafy-${rkey}`,
    rkey: rkeyFromUri(uri),
    authorDid,
    authorHandle,
    authorDisplayName: authorHandle,
    authorAvatar: null,
    text,
    segments,
    embed: null,
    createdAt,
    indexedAt: createdAt,
    severity: classifySeverity(text),
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    url: postPermalink(authorHandle, uri),
    ...overrides
  }
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

export function makeProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  const did = overrides.did ?? DID.custom
  const handle = overrides.handle ?? 'status.example.test'
  return {
    did,
    handle,
    displayName: handle,
    avatar: null,
    description: null,
    followersCount: 0,
    postsCount: 0,
    ...overrides
  }
}

export function makeEmbed(kind: PostEmbed['kind'] = 'external'): PostEmbed {
  switch (kind) {
    case 'external':
      return {
        kind: 'external',
        uri: 'https://status.bsky.app/incidents/42',
        title: 'Incident 42',
        description: 'Elevated error rates',
        thumb: 'https://cdn.bsky.app/thumb.jpg'
      }
    case 'images':
      return {
        kind: 'images',
        images: [
          {
            thumb: 'https://cdn.bsky.app/thumb-0.jpg',
            fullsize: 'https://cdn.bsky.app/full-0.jpg',
            alt: 'Latency graph'
          }
        ]
      }
    case 'record':
      return {
        kind: 'record',
        uri: 'at://did:plc:quoted/app.bsky.feed.post/abc',
        author: 'someone.bsky.social',
        text: 'Quoted post body'
      }
  }
}

export function makeNetworkSummary(overrides: Partial<NetworkSummary> = {}): NetworkSummary {
  return {
    health: 'unknown',
    total: 0,
    reachable: 0,
    down: [],
    degraded: [],
    community: [],
    running: false,
    lastSweepAt: null,
    restraint: null,
    ...overrides
  }
}

export function makeCheck(overrides: Partial<ProbeCheck> = {}): ProbeCheck {
  return {
    label: '_health',
    target: 'https://relay.example.test/xrpc/_health',
    kind: 'http',
    ok: true,
    error: null,
    durationMs: 120,
    ...overrides
  }
}

/** A measured service. Defaults to the first relay in the catalogue, live. */
export function makeService(overrides: Partial<ServiceProbe> = {}): ServiceProbe {
  const definition = SERVICES.find((s) => s.id === overrides.id) ?? SERVICES[0]!
  return {
    ...blankService(definition),
    state: 'live',
    condition: 'up',
    since: '2026-01-01T11:00:00.000Z',
    checks: [makeCheck()],
    startedAt: '2026-01-01T11:59:59.000Z',
    checkedAt: '2026-01-01T12:00:00.000Z',
    latencyMs: 120,
    ...overrides
  }
}

export function makeSnapshot(overrides: Partial<NetworkSnapshot> = {}): NetworkSnapshot {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    offline: false,
    restraint: null,
    services: [],
    ...overrides
  }
}

export function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    accounts: [],
    posts: [],
    settings: makeSettings(),
    unread: [],
    sync: { status: 'idle', lastSyncedAt: '2026-01-01T12:00:00.000Z', error: null },
    webhook: makeWebhookStatus(),
    network: makeNetworkSummary(),
    loginItem: { registered: false, error: null },
    shortcut: { registered: false, error: null },
    update: { stage: 'current', version: null },
    version: '0.1.0-test',
    ...overrides
  }
}

/** Reset the counter that keeps generated handles and rkeys unique. */
export function resetFactories(): void {
  seq = 0
}
