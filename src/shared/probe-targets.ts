/**
 * What the network checks read, and whose choice it is.
 *
 * A check has to ask a service about *something*: a profile, a post feed, an image, a
 * repository, a published document. Those somethings belong to other people, who can
 * delete or edit them at any time, and when one goes the check that read it starts
 * failing for a reason that has nothing to do with the service. So they are data rather
 * than code: `probeTargets.json` holds the checked-in defaults, and a user who finds one
 * gone can replace the whole document from Settings rather than wait for a release.
 *
 * `Settings.probeTargets` is that replacement, or null for none. It is always a whole
 * document, never a patch over the defaults, which is what lets "export" be exactly
 * what is in force and "reset" be nothing more than null. `effectiveProbeTargets` is the
 * one place that decides between the two, and everything that probes asks it — per
 * sweep, through `NetworkMonitor.retarget`, rather than once at import.
 *
 * Both processes import this: main to probe with it, the renderer for the defaults a
 * "reset" goes back to and to check a document before sending it. Validation is the
 * same Zod schema the IPC boundary runs, `probeTargetsSchema` in src/shared/schemas.ts.
 */
import raw from './probeTargets.json'
import { PROBE_TARGET_LIMITS, probeTargetsSchema } from './schemas'
import type { ProbeTargets } from './types'

export { PROBE_TARGET_LIMITS, probeTargetsSchema }
export type { ProbeAccount, ProbeFeed, ProbeImage, ProbeRecord, ProbeTargets } from './types'

/** Freeze an object and everything inside it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * `probeTargets.json`, validated. A malformed file fails at import, and in the tests.
 *
 * Frozen, because it is shared by everything that falls back to it: copy it
 * (`structuredClone`) before editing it into an override.
 */
export const DEFAULT_PROBE_TARGETS: ProbeTargets = deepFreeze(probeTargetsSchema.parse(raw))

/** One thing wrong with a document, at the field it is about. */
export interface ProbeTargetIssue {
  /** Where, as keys and indices from the document root: `['accounts', 2, 'did']`. */
  path: (string | number)[]
  message: string
}

export type ProbeTargetsValidation =
  { ok: true; targets: ProbeTargets } | { ok: false; issues: ProbeTargetIssue[] }

/**
 * Check a document against the schema, and say what is wrong with it field by field.
 *
 * On success, `targets` is the *normalised* document — handles and hosts lower-cased,
 * whitespace trimmed, unknown keys dropped — and that is what should be saved.
 */
export function validateProbeTargets(input: unknown): ProbeTargetsValidation {
  const result = probeTargetsSchema.safeParse(input)
  if (result.success) return { ok: true, targets: result.data }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.filter((key): key is string | number => typeof key !== 'symbol'),
      message: issue.message
    }))
  }
}

/** Issues as one line each, `accounts[2].did: Must be a DID…`, for a log or a dialog. */
export function describeProbeTargetIssues(issues: ProbeTargetIssue[]): string[] {
  return issues.map(({ path, message }) => {
    const where = path.reduce<string>(
      (text, key) => (typeof key === 'number' ? `${text}[${key}]` : text ? `${text}.${key}` : key),
      ''
    )
    return where ? `${where}: ${message}` : message
  })
}

/** JSON with every object's keys sorted, so two documents compare by content alone. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? // An object's keys are unique, so no two ever compare equal.
        Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : 1)))
      : inner
  )
}

/** Whether two overrides say the same thing. Null only ever equals null. */
export function sameProbeTargets(
  a: ProbeTargets | null | undefined,
  b: ProbeTargets | null | undefined
): boolean {
  if (a == null || b == null) return a == null && b == null
  return canonical(a) === canonical(b)
}

function warnInvalid(issues: ProbeTargetIssue[]): void {
  console.warn(
    'The saved probe targets are not valid, so the checked-in defaults are in use instead:\n' +
      describeProbeTargetIssues(issues)
        .map((line) => `  ${line}`)
        .join('\n')
  )
}

/**
 * What `Settings.probeTargets` should hold, given whatever was offered for it.
 *
 * Run on the way in from disk and on every settings change, so the field only ever
 * holds a valid override or null — which matters beyond the checks themselves, since
 * `AppState.settings` is validated at the IPC boundary on every push and one bad field
 * would take the whole popover's state with it. Something invalid is dropped with a
 * warning rather than thrown about: a hand-edited config file should cost the user their
 * override, not the app. An override identical to the defaults is stored as none, so it
 * follows the defaults when a later release changes them.
 */
export function sanitizeProbeTargets(value: unknown): ProbeTargets | null {
  if (value === null || value === undefined) return null
  const result = validateProbeTargets(value)
  if (!result.ok) {
    warnInvalid(result.issues)
    return null
  }
  return sameProbeTargets(result.targets, DEFAULT_PROBE_TARGETS) ? null : result.targets
}

/**
 * The targets in force: the user's override when there is a valid one, the checked-in
 * defaults otherwise. The only thing that should read `Settings.probeTargets`, and what
 * an export writes out.
 *
 * Checked again here even though the field is sanitised on the way into the store, so
 * that nothing which reaches it some other way can put a malformed document in front of
 * the probes. An invalid one falls back to the defaults with a warning, never a throw.
 */
export function effectiveProbeTargets(override: ProbeTargets | null | undefined): ProbeTargets {
  if (override === null || override === undefined) return DEFAULT_PROBE_TARGETS
  const result = validateProbeTargets(override)
  if (result.ok) return result.targets
  warnInvalid(result.issues)
  return DEFAULT_PROBE_TARGETS
}
