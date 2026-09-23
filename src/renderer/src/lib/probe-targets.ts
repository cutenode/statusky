/**
 * The parts of the check targets editor that are not about drawing it.
 *
 * Reading a document someone pasted or picked, saying what replacing the targets in
 * force with it would change, and putting each validation issue beside the field it is
 * about. The validation itself is `validateProbeTargets` in src/shared/probe-targets.ts,
 * the same Zod schema the IPC boundary runs; this only arranges its answers.
 */
import {
  describeProbeTargetIssues,
  validateProbeTargets,
  type ProbeTargetIssue,
  type ProbeTargets
} from '@shared/probe-targets'

/** A field or list in the document, as keys and indices from its root. */
export type TargetPath = readonly (string | number)[]

/**
 * A path to one of the document's text fields, which is every field the editor draws:
 * `['feeds', 0, 'host']`, `['apps', 'leaflet', 'feed', 'rkey']`.
 *
 * Narrower than `TargetPath`, which an issue may also use to name a whole list or one
 * entry in it. Built from `ProbeTargets` itself, so a field the editor names that the
 * document does not have — a typo, or a field renamed underneath it — fails to compile
 * rather than drawing an empty box that edits nothing the checks read.
 */
export type FieldPath = TextPaths<ProbeTargets>

type TextPaths<T> = T extends string
  ? []
  : T extends readonly (infer Item)[]
    ? [number, ...TextPaths<Item>]
    : T extends object
      ? { [K in keyof T & string]: [K, ...TextPaths<T[K]>] }[keyof T & string]
      : never

/** One string per path, `feeds.0.host`, for looking a field's issue up. */
export function pathKey(path: TargetPath): string {
  return path.join('.')
}

/**
 * The editor's sections, in the order it draws them.
 *
 * The two apps are separate sections although they share `apps` in the document,
 * because they are separate services with nothing else in common.
 */
export const SECTIONS = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'feeds', label: 'Custom feeds' },
  { key: 'forYou', label: 'For You' },
  { key: 'cdnImages', label: 'CDN images' },
  { key: 'tangled', label: 'Tangled' },
  { key: 'leaflet', label: 'Leaflet' },
  { key: 'offprint', label: 'Offprint' }
] as const

export type SectionKey = (typeof SECTIONS)[number]['key']

/** Which section a path belongs to, or null for the document as a whole. */
export function sectionOf(path: TargetPath): SectionKey | null {
  const [head, next] = path
  const key = head === 'apps' ? next : head
  return SECTIONS.find((section) => section.key === key)?.key ?? null
}

/** The first issue at each path, since one sentence beside a field is enough. */
export function issuesByPath(issues: readonly ProbeTargetIssue[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const { path, message } of issues) {
    const key = pathKey(path)
    if (!map.has(key)) map.set(key, message)
  }
  return map
}

export type ReadResult = { ok: true; targets: ProbeTargets } | { ok: false; problems: string[] }

/**
 * Turn the text of a file or a paste into a document, or say why it is not one.
 *
 * A byte-order mark is dropped first, since some editors write one and `JSON.parse`
 * refuses it. On success the document is the normalised one the schema hands back,
 * which is what should be saved.
 */
export function readProbeTargets(text: string): ReadResult {
  const body = text.replace(/^\uFEFF/, '').trim()
  if (!body) return { ok: false, problems: ['There is nothing in it.'] }

  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch (error) {
    return { ok: false, problems: [`It is not JSON. ${(error as Error).message}`] }
  }

  const result = validateProbeTargets(doc)
  if (result.ok) return { ok: true, targets: result.targets }
  return { ok: false, problems: describeProbeTargetIssues(result.issues) }
}

/** JSON with every object's keys sorted, so two values compare by content alone. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : 1)))
      : inner
  )
}

function tally<T>(list: readonly T[], id: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of list) map.set(id(item), [...(map.get(id(item)) ?? []), item])
  return map
}

/**
 * How a list differs, in words: `2 added, 1 removed, now 7`.
 *
 * Entries are matched by `id` — an account by its DID, a feed by its host — so one
 * whose other fields were edited reads as changed rather than as one removed and one
 * added. Null when the two lists are the same, order and all.
 */
function compareList<T>(before: readonly T[], after: readonly T[], id: (item: T) => string) {
  if (canonical(before) === canonical(after)) return null

  const was = tally(before, id)
  const now = tally(after, id)
  let added = 0
  let removed = 0
  let changed = 0
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(key) ?? []
    const b = now.get(key) ?? []
    added += Math.max(0, b.length - a.length)
    removed += Math.max(0, a.length - b.length)
    if (a[0] && b[0] && canonical(a[0]) !== canonical(b[0])) changed++
  }

  const parts: string[] = []
  if (added) parts.push(`${added} added`)
  if (removed) parts.push(`${removed} removed`)
  if (changed) parts.push(`${changed} changed`)
  // Everything is still there and nothing was edited, so all that moved is the order.
  if (!parts.length) parts.push('reordered')
  if (before.length !== after.length) parts.push(`now ${after.length}`)
  return parts.join(', ')
}

function compareOne(before: unknown, after: unknown): string | null {
  return canonical(before) === canonical(after) ? null : 'changed'
}

export interface SectionChange {
  key: SectionKey
  label: string
  /** How the section would differ, in a few words, or null if it would not. */
  change: string | null
}

/** What replacing `before` with `after` would change, section by section. */
export function compareProbeTargets(before: ProbeTargets, after: ProbeTargets): SectionChange[] {
  const changes: Record<SectionKey, string | null> = {
    accounts: compareList(before.accounts, after.accounts, (a) => a.did),
    feeds: compareList(before.feeds, after.feeds, (f) => f.host),
    forYou: compareOne(before.forYou, after.forYou),
    cdnImages: compareList(before.cdnImages, after.cdnImages, (i) => `${i.did} ${i.cid}`),
    tangled: compareOne(before.tangled, after.tangled),
    leaflet: compareOne(before.apps.leaflet, after.apps.leaflet),
    offprint: compareOne(before.apps.offprint, after.apps.offprint)
  }
  return SECTIONS.map(({ key, label }) => ({ key, label, change: changes[key] }))
}
