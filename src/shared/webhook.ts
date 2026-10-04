/**
 * Normalisation for pushed status updates.
 *
 * Hosted status pages — Instatus, which is what `status.bsky.app` runs on, and
 * Statuspage, whose payload is close enough to share this code — let a subscriber
 * register a URL and receive every incident, maintenance window and component change
 * as JSON. See https://status.bsky.app/subscribe/webhook, and
 * https://instatus.com/help/webhooks for the shape.
 *
 * Everything here is pure: it takes a parsed request body and returns the source it
 * came from plus the feed entries it represents, so `src/main/webhook.ts` is left with
 * nothing but sockets and `src/main/model.ts` with nothing but state.
 *
 * The payload is remote input from a URL the user has published, so nothing in it is
 * trusted: unknown shapes return null, unknown statuses fall back to classifying the
 * prose the way an AT Protocol post is classified, every string that reaches the UI is
 * length-capped, every link is held to `safeHttpUrl`, and no timestamp may run ahead of
 * the delivery by more than `MAX_CLOCK_SKEW_MS`.
 */
import { isProbeSource } from './network'
import { safeHttpUrl } from './richtext'
import { classifySeverity } from './status'
import type { Account, RichSegment, Severity, StatusPost } from './types'

/** Namespace for the synthetic `Account.did` of a pushed source. */
export const WEBHOOK_SOURCE_PREFIX = 'webhook:'

/** Caps on remote strings, so a hostile payload cannot bloat the persisted store. */
const MAX_TEXT = 4_000
const MAX_NAME = 200
/** Updates per delivery. A status page sends an incident's whole history every time. */
const MAX_UPDATES = 50

export function webhookSourceId(pageId: string): string {
  return `${WEBHOOK_SOURCE_PREFIX}${pageId}`
}

export function isWebhookSource(did: string): boolean {
  return did.startsWith(WEBHOOK_SOURCE_PREFIX)
}

/**
 * How a source is written wherever its name appears.
 *
 * An AT Protocol handle is conventionally written with an `@`; a status page's
 * hostname is not, and writing `@status.bsky.app` for one would suggest an account
 * that does not exist. Nor is the network checks' own name.
 */
export function sourceLabel(authorDid: string, handle: string): string {
  return isWebhookSource(authorDid) || isProbeSource(authorDid) ? handle : `@${handle}`
}

/**
 * The tracked source a status page registers itself as on its first delivery.
 *
 * It is an ordinary `Account` so that muting, per-source notification toggles, the
 * feed's filter chips, unread counts and the health rollup all keep working with no
 * second code path — the only thing `kind` changes is that nothing tries to poll it.
 */
export function webhookAccount(source: WebhookSource, addedAt: string): Account {
  return {
    did: source.id,
    handle: source.host,
    displayName: source.host,
    avatar: null,
    description: source.description,
    notify: 'default',
    muted: false,
    addedAt,
    builtin: false,
    kind: 'webhook'
  }
}

/** The status page behind a delivery, as far as we can identify it. */
export interface WebhookSource {
  /** `webhook:<page id>` — the `Account.did` this source's posts are filed under. */
  id: string
  /** Display name: the page's hostname, which is what a user recognises. */
  host: string
  /** The page's own URL, for the "open" affordance. Always http(s), or null. */
  url: string | null
  description: string | null
}

export interface WebhookDelivery {
  source: WebhookSource
  /** Newest first, matching the order the feed stores posts in. */
  posts: StatusPost[]
}

/**
 * Instatus lifecycle statuses. Statuspage uses the same words in lower case, so both
 * land here after upper-casing.
 */
const INCIDENT_SEVERITY: Record<string, Severity> = {
  INVESTIGATING: 'investigating',
  IDENTIFIED: 'identified',
  MONITORING: 'monitoring',
  RESOLVED: 'resolved',
  POSTMORTEM: 'resolved'
}

const MAINTENANCE_SEVERITY: Record<string, Severity> = {
  NOTSTARTEDYET: 'maintenance',
  SCHEDULED: 'maintenance',
  INPROGRESS: 'maintenance',
  COMPLETED: 'resolved',
  VERIFYING: 'maintenance'
}

/**
 * The component states a delivery can name, after `statusKey`. Both tables below are
 * keyed by exactly this set, so a state added to one and not the other is a compile
 * error rather than a feed entry reading "Relay is undefined."
 */
type ComponentStatus =
  'OPERATIONAL' | 'UNDERMAINTENANCE' | 'DEGRADEDPERFORMANCE' | 'PARTIALOUTAGE' | 'MAJOROUTAGE'

/**
 * Component health. `PARTIALOUTAGE` maps to `outage` rather than `degraded`: our scale
 * reads `degraded` as slow-but-working, and a partial outage is not that.
 */
const COMPONENT_SEVERITY: Record<ComponentStatus, Severity> = {
  OPERATIONAL: 'resolved',
  UNDERMAINTENANCE: 'maintenance',
  DEGRADEDPERFORMANCE: 'degraded',
  PARTIALOUTAGE: 'outage',
  MAJOROUTAGE: 'outage'
}

function isComponentStatus(key: string): key is ComponentStatus {
  return Object.hasOwn(COMPONENT_SEVERITY, key)
}

const COMPONENT_LABEL: Record<ComponentStatus, string> = {
  OPERATIONAL: 'operational',
  UNDERMAINTENANCE: 'under maintenance',
  DEGRADEDPERFORMANCE: 'seeing degraded performance',
  PARTIALOUTAGE: 'in a partial outage',
  MAJOROUTAGE: 'in a major outage'
}

// -------------------------------------------------------------- raw payload

interface RawPage {
  id?: unknown
  url?: unknown
  status_description?: unknown
  status_indicator?: unknown
}

interface RawUpdate {
  id?: unknown
  body?: unknown
  status?: unknown
  created_at?: unknown
  updated_at?: unknown
}

interface RawIncident {
  id?: unknown
  name?: unknown
  status?: unknown
  url?: unknown
  created_at?: unknown
  updated_at?: unknown
  resolved_at?: unknown
  incident_updates?: unknown
  maintenance_updates?: unknown
  duration?: unknown
}

interface RawComponent {
  id?: unknown
  name?: unknown
  status?: unknown
}

interface RawComponentUpdate {
  component_id?: unknown
  new_status?: unknown
  created_at?: unknown
}

/**
 * A delivery's top level, once it is known to be an object at all.
 *
 * Every part is still whatever the sender put there: `page` is a `RawPage` when the
 * payload is well formed, and a string, a number or null when it is not, so each one is
 * only read as its shape after `isObject` has said it is one. The interfaces above are
 * what a part looks like *after* that check — an object whose fields are unverified.
 */
export interface RawWebhookBody {
  page?: unknown
  incident?: unknown
  maintenance?: unknown
  component?: unknown
  component_update?: unknown
}

// ------------------------------------------------------------- small helpers

/** A JSON object, as opposed to an array, a primitive or null. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : ''
}

/** The hostname of an already-validated URL. */
function hostOf(url: string | null): string | null {
  return url === null ? null : new URL(url).hostname
}

/**
 * How far past the moment a delivery arrived an update in it may be dated.
 *
 * A status page's clock and this machine's need not agree, and an update stamped a
 * minute after it reached us is two clocks disagreeing and nothing else — it keeps its
 * own time, so the updates in one delivery stay in the order their author put them in.
 * But the timestamp is the sender's to choose. An update dated 2099 would sit at the top
 * of the feed until then, push the rest of the feed out of the post cap a few dozen at a
 * time, and carry any cursor that is moved onto it — the source's notification cursor,
 * and through *Mark this and everything older as read* every source's read cursor —
 * into a future where nothing is ever news again. Past this allowance a timestamp is
 * taken to be a lie, and the update is dated when it arrived, which is the one moment
 * this machine actually knows about.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000

/**
 * Normalise a timestamp to ISO, or null when it is missing or unparseable. One that is
 * further ahead of `receivedAt` than `MAX_CLOCK_SKEW_MS` becomes `receivedAt`.
 */
function isoOrNull(value: unknown, receivedAt: string): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  // Checked on the Date rather than the number: a finite number can still lie outside
  // the range a Date holds, and `toISOString` throws on one of those rather than
  // answering, which would take the whole delivery down with it.
  const date = new Date(typeof value === 'number' ? value : Date.parse(value))
  const time = date.getTime()
  if (Number.isNaN(time)) return null
  return time > Date.parse(receivedAt) + MAX_CLOCK_SKEW_MS ? receivedAt : date.toISOString()
}

/** Statuses arrive in assorted casing and with spaces or underscores between words. */
function statusKey(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\s_-]/g, '').toUpperCase() : ''
}

// ------------------------------------------------------------------ rich text

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'"
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    const lower = name.toLowerCase()
    // Own keys only: `&constructor;` is not an entity, whatever the prototype says.
    const direct = Object.hasOwn(ENTITIES, lower) ? ENTITIES[lower] : undefined
    if (direct) return direct
    const numeric = lower.startsWith('#x')
      ? Number.parseInt(name.slice(2), 16)
      : lower.startsWith('#')
        ? Number.parseInt(name.slice(1), 10)
        : NaN
    return Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : match
  })
}

/** Bare URLs in prose, minus the punctuation that usually ends the sentence. */
const BARE_URL = /https?:\/\/[^\s<>"']+/g

function pushText(segments: RichSegment[], text: string): void {
  if (!text) return
  const last = segments.at(-1)
  // Merge rather than emitting a run of adjacent text nodes; `RichText` renders one
  // span per segment and consecutive spans would break word wrapping.
  if (last?.kind === 'text') last.text += text
  else segments.push({ kind: 'text', text })
}

/** Split plain prose so bare URLs become real links. */
function pushLinkified(segments: RichSegment[], text: string): void {
  let cursor = 0
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index
    let raw = match[0]
    // Trailing punctuation belongs to the sentence, not to the URL.
    const trailing = /[.,;:!?)\]}]+$/.exec(raw)
    if (trailing) raw = raw.slice(0, raw.length - trailing[0].length)
    const uri = safeHttpUrl(raw)
    if (!uri) continue

    pushText(segments, text.slice(cursor, start))
    segments.push({ kind: 'link', text: raw, uri })
    cursor = start + raw.length
  }
  pushText(segments, text.slice(cursor))
}

/** Tags that end a line when they close; everything else is inline. */
const BLOCK_TAG = /^\/?(p|div|br|li|ul|ol|h[1-6]|tr|blockquote)$/i

/**
 * Turn an update body into segments.
 *
 * Status pages send HTML, so the tags have to go — but an `<a href>` in an incident
 * update is usually the link to the thing that broke, and dropping it would lose the
 * most useful part of the message. Anchors therefore survive as link segments and
 * everything else is flattened, which also means no remote markup is ever handed to
 * the renderer.
 */
export function segmentWebhookBody(html: string): RichSegment[] {
  const segments: RichSegment[] = []
  /** The href of the anchor currently open, and the text seen inside it so far. */
  let anchor: string | null = null
  let anchorText = ''
  let open = false
  let cursor = 0

  const emit = (raw: string): void => {
    const text = decodeEntities(raw)
    if (!text) return
    // Text inside an anchor is accumulated separately: it has to stay out of the
    // preceding text segment, which `pushText` would otherwise merge it into.
    if (open) anchorText += text
    else pushLinkified(segments, text)
  }

  const closeAnchor = (): void => {
    const text = anchorText.replace(/\s+/g, ' ').trim()
    if (anchor && text) segments.push({ kind: 'link', text, uri: anchor })
    // A missing or non-http href still keeps the words; only the link is lost.
    else if (text) pushLinkified(segments, text)
    anchor = null
    anchorText = ''
    open = false
  }

  for (const match of html.matchAll(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    emit(html.slice(cursor, match.index))
    cursor = match.index + match[0].length

    const name = match[1]!.toLowerCase()
    const closing = match[0].startsWith('</')

    if (name === 'a') {
      if (open) closeAnchor()
      if (!closing) {
        const href = /href\s*=\s*["']?([^"'\s>]+)/i.exec(match[0])
        anchor = safeHttpUrl(href?.[1])
        open = true
      }
      continue
    }

    if (BLOCK_TAG.test(closing ? `/${name}` : name)) {
      // An unclosed anchor must not swallow the rest of the document.
      if (open) closeAnchor()
      pushText(segments, '\n')
    }
  }

  emit(html.slice(cursor))
  if (open) closeAnchor()

  return finishSegments(segments)
}

/** Flatten segments and trim the edges; the result is what notifications read. */
function segmentsToText(segments: RichSegment[]): string {
  return segments
    .map((s) => s.text)
    .join('')
    .trim()
}

/**
 * Join runs of plain text, tidy the whitespace stripped markup leaves behind, and
 * trim the ends.
 *
 * `RichText` renders one span per segment, so two adjacent text segments would break
 * a word across them; only links are meant to be their own span.
 */
function finishSegments(segments: RichSegment[]): RichSegment[] {
  const out: RichSegment[] = []
  for (const segment of segments) {
    const last = out.at(-1)
    if (segment.kind === 'text' && last?.kind === 'text') last.text += segment.text
    else out.push({ ...segment })
  }

  for (const segment of out) {
    if (segment.kind === 'text') {
      segment.text = segment.text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    }
  }

  const first = out[0]
  if (first?.kind === 'text') first.text = first.text.replace(/^\s+/, '')
  const last = out.at(-1)
  if (last?.kind === 'text') last.text = last.text.replace(/\s+$/, '')
  return out.filter((s) => s.text !== '')
}

// ------------------------------------------------------------------- parsing

interface PostInput {
  source: WebhookSource
  /** Unique within the source; becomes the post's rkey and the tail of its URI. */
  key: string
  title: string
  body: string
  severity: Severity
  createdAt: string
  url: string | null
  receivedAt: string
}

function makeWebhookPost(input: PostInput): StatusPost {
  const { source, key, title, body, severity, createdAt, url, receivedAt } = input

  // The name is the headline and the update body is the detail; a status page repeats
  // the name on every update, so together they read the way a status post does.
  const segments = finishSegments([
    ...(title ? [{ kind: 'text' as const, text: `${title}\n\n` }] : []),
    ...segmentWebhookBody(body)
  ])
  const text = segmentsToText(segments).slice(0, MAX_TEXT)

  return {
    uri: `${source.id}/${key}`,
    cid: key,
    rkey: key,
    authorDid: source.id,
    authorHandle: source.host,
    authorDisplayName: source.host,
    authorAvatar: null,
    text,
    segments,
    embed: null,
    createdAt,
    // There is no index to read from: the moment it reached us is the best we have.
    indexedAt: receivedAt,
    severity,
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    url: url ?? source.url ?? ''
  }
}

function parseSource(page: RawPage | undefined): WebhookSource | null {
  const url = safeHttpUrl(page?.url)
  const host = hostOf(url)
  // The page id is stable across renames; the hostname is the fallback when a payload
  // omits it, and one of the two has to exist or the delivery cannot be filed anywhere.
  const id = str(page?.id, MAX_NAME) || host
  if (!id) return null

  return {
    id: webhookSourceId(id),
    host: host ?? id,
    url,
    description: str(page?.status_description, MAX_NAME) || null
  }
}

function updatesOf(incident: RawIncident): RawUpdate[] {
  const raw = incident.incident_updates ?? incident.maintenance_updates
  // Only the entries that are objects: a `null` in the list would otherwise throw on the
  // first field read off it, and a number would become an entry with nothing to say.
  return Array.isArray(raw) ? raw.filter(isObject).slice(0, MAX_UPDATES) : []
}

/**
 * An incident or maintenance window: one feed entry per update it carries.
 *
 * Status pages send the whole update history on every delivery, which is what makes
 * the feed read as a timeline rather than as a series of overwrites — and, because
 * each entry's URI is derived from the update's own id, a redelivery merges onto the
 * entries already stored instead of duplicating them.
 */
function parseIncident(
  incident: RawIncident,
  source: WebhookSource,
  table: Record<string, Severity>,
  kind: 'incident' | 'maintenance',
  receivedAt: string
): StatusPost[] {
  const incidentId = str(incident.id, MAX_NAME)
  const name = str(incident.name, MAX_NAME)
  const url = safeHttpUrl(incident.url)
  const openedAt = isoOrNull(incident.created_at, receivedAt) ?? receivedAt
  const fallback = table[statusKey(incident.status)]

  const updates = updatesOf(incident)
  if (!updates.length) {
    // No update list: the incident record itself is the only thing to show.
    if (!incidentId && !name) return []
    return [
      makeWebhookPost({
        source,
        key: `${kind}/${incidentId || name}`,
        title: name,
        body: '',
        severity: fallback ?? classifySeverity(name),
        createdAt: isoOrNull(incident.updated_at, receivedAt) ?? openedAt,
        url,
        receivedAt
      })
    ]
  }

  const posts: StatusPost[] = []
  updates.forEach((update, index) => {
    const updateId = str(update.id, MAX_NAME) || `${index}`
    const body = str(update.body, MAX_TEXT)
    const status = table[statusKey(update.status)]
    posts.push(
      makeWebhookPost({
        source,
        key: `${kind}/${incidentId || name || 'unknown'}/${updateId}`,
        title: name,
        body,
        // The status field is the page author naming the stage, which beats guessing
        // it from prose — but an unknown value should not silently become `update`.
        severity: status ?? fallback ?? classifySeverity(body || name),
        createdAt: isoOrNull(update.created_at, receivedAt) ?? openedAt,
        url,
        receivedAt
      })
    )
  })
  return posts
}

/** A component flipping between operational and broken. */
function parseComponent(
  component: RawComponent,
  update: RawComponentUpdate,
  source: WebhookSource,
  receivedAt: string
): StatusPost[] {
  const componentId = str(component.id, MAX_NAME) || str(update.component_id, MAX_NAME)
  const name = str(component.name, MAX_NAME)
  if (!componentId && !name) return []

  const status = statusKey(update.new_status) || statusKey(component.status)
  if (!isComponentStatus(status)) return []
  const severity = COMPONENT_SEVERITY[status]

  const createdAt = isoOrNull(update.created_at, receivedAt) ?? receivedAt
  return [
    makeWebhookPost({
      source,
      // A component can change state repeatedly, so the timestamp is part of identity.
      key: `component/${componentId || name}/${createdAt}`,
      title: '',
      body: `${name || 'A component'} is ${COMPONENT_LABEL[status]}.`,
      severity,
      createdAt,
      url: null,
      receivedAt
    })
  ]
}

/**
 * Turn one delivery into the source it came from and the feed entries it carries.
 *
 * Returns null when the body is not a status-page payload at all — the caller answers
 * such a request with "accepted, ignored" rather than an error, because a provider
 * that sees failures will eventually disable the endpoint.
 */
export function parseWebhookDelivery(
  body: unknown,
  receivedAt: string = new Date().toISOString()
): WebhookDelivery | null {
  if (!isObject(body)) return null
  const payload: RawWebhookBody = body

  const source = parseSource(isObject(payload.page) ? payload.page : undefined)
  if (!source) return null

  let posts: StatusPost[] = []
  if (isObject(payload.incident)) {
    posts = parseIncident(payload.incident, source, INCIDENT_SEVERITY, 'incident', receivedAt)
  } else if (isObject(payload.maintenance)) {
    posts = parseIncident(
      payload.maintenance,
      source,
      MAINTENANCE_SEVERITY,
      'maintenance',
      receivedAt
    )
  } else if (isObject(payload.component_update)) {
    posts = parseComponent(
      isObject(payload.component) ? payload.component : {},
      payload.component_update,
      source,
      receivedAt
    )
  }

  if (!posts.length) return null
  return { source, posts }
}
