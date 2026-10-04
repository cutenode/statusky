/**
 * What the services' answers are compared against, word for word.
 *
 * `expectedResponses.json` is the one place every exact-match literal the network checks
 * hold a response to lives: a greeting, a health status, a marker in a page, a record
 * type. Keeping them out of `src/main/probes.ts` means a service rewording its greeting
 * is a one-line data change rather than a hunt through request code. The fake Internet
 * in src/test/network.ts deliberately does *not* read this file: it answers in the
 * services' own words, as captured from them, so a typo here fails the tests instead of
 * being agreed with.
 *
 * Unlike `probeTargets.json` this is not something a user can override. These strings
 * are what the services say about *themselves*, not which of somebody's posts or
 * repositories to read, and nothing a person could type would make a greeting more
 * correct. Structural checks — "this is a string", "this is an array" — stay in the
 * code, because they are about the shape of an answer rather than its words.
 *
 * Each value's reason for being what it is is written against its field below, since
 * JSON cannot carry the comment itself.
 */
import raw from './expectedResponses.json'
import { z } from './zod'

const text = z.string().min(1)

export const expectedResponsesSchema = z.object({
  relay: z.object({
    /** A relay's `/xrpc/_health` says `{"status":"ok"}` and nothing else. */
    healthStatus: text,
    /**
     * The `com.atproto.sync.getHostStatus` statuses that mean a relay is subscribed to a
     * host. `idle` is a small PDS with nothing to say lately, which is not a problem;
     * `offline`, `throttled` and `banned` are the relay no longer taking its commits.
     */
    carriedHostStatuses: z.array(text).min(1),
    /** The XRPC error a relay names a host it has never crawled with. */
    hostNotFound: text
  }),
  /**
   * The framing of `com.atproto.sync.subscribeRepos`: a CBOR header whose `op` is 1 for
   * an event and -1 for an error, and whose `t` names the event type. Only commits carry
   * the timestamp the firehose check reads; every other event type is skipped.
   */
  firehose: z.object({
    eventOp: z.number().int(),
    errorOp: z.number().int(),
    commitType: text
  }),
  jetstream: z.object({
    /**
     * Twenty bytes on `/`, and worth almost nothing on its own: a Jetstream with a dead
     * upstream greets you just as warmly. It tells a stalled stream apart from a host
     * that is not answering at all.
     */
    greeting: text,
    /** The `kind` of a Jetstream event that carries a commit and its `time_us`. */
    commitKind: text,
    /**
     * The `commit.operation` of a record being written for the first time. A sample of
     * those is what the AppViews are asked for, since an update or a delete names a
     * record an AppView may already have or no longer serve.
     */
    createOperation: text
  }),
  spacedust: z.object({
    /**
     * The link source to subscribe to. It fires many times a second on purpose: a narrow
     * filter can legitimately go minutes without firing, and would read as an outage.
     */
    source: text,
    /** The `kind` of a frame that carries a link, as opposed to anything else. */
    linkKind: text,
    /**
     * The `origin` of a link seen as it happened. Only those count — a replayed one would
     * date from whenever it was first seen.
     */
    liveOrigin: text
  }),
  appView: z.object({
    /** AppViews that answer their health check with an empty object rather than a version. */
    versionlessHealth: z.array(text),
    /**
     * AppViews that index only part of the network by design. W Social's takes its own
     * PDS's users and accounts `bsky.app` has verified, so a sample of posts from the
     * whole firehose would find it missing nearly all of them every time, and say nothing
     * about whether it is keeping up.
     */
    partialIndex: z.array(text)
  }),
  dns: z.object({
    /**
     * The `Status` of a DNS-over-HTTPS JSON answer that succeeded (`NOERROR`). An answer
     * with no records but this status is still a resolver doing its job.
     */
    noError: z.number().int()
  }),
  ufos: z.object({
    /**
     * The collection whose statistics are asked for, and so the key the answer is filed
     * under. The busiest one, so it is never legitimately empty.
     */
    statsCollection: text
  }),
  slingshot: z.object({
    /** The `$type` of the profile record Slingshot is asked for, and must hand back. */
    profileType: text
  }),
  forYou: z.object({
    /** A structural line of the site's `<head>`, rather than the copy around it. */
    siteMarker: text,
    /**
     * What the site says, in plain text under a 503, when it is shedding load. That is a
     * feed at its limit, not a broken one, and it deserves better words than its status.
     */
    busy: text,
    /** The `type` of the service entry a feed generator's DID document must declare. */
    generatorServiceType: text
  }),
  tangled: z.object({
    /** The `<meta name="go-import">` a Go vanity route answers `?go-get=1` with. */
    goImportMarker: text,
    /** What a repository page's `<title>` says instead of its name when it did not resolve. */
    notFoundTitle: text
  }),
  hydrant: z.object({
    /**
     * How Bobbin's upstream identifies itself on `/health`. Worth its own row because it
     * is what tells "the index has stalled" apart from "the thing feeding it has died".
     */
    name: text,
    mode: text
  }),
  knot: z.object({
    /**
     * The capability only knot 2 names on its version route. `/xrpc/_health` exists only
     * there, and most knots in the wild run knot 1, where a 404 on it is perfectly
     * healthy — so the extra checks are asked for only once this has been named. Version
     * strings are no use for the same decision: knot 2 hardcodes `v1.15.0` on that route
     * while reporting its real build on `_health`.
     */
    healthCapability: text
  }),
  spindle: z.object({
    /** A spindle's bare `/_health` says `{"status":"ok"}`. */
    healthStatus: text
  }),
  pckt: z.object({
    /** The top-level `status` of pckt's `/up` when the application considers itself well. */
    status: text
  }),
  standardSite: z.object({
    /**
     * The standard.site publication record's collection. A publication's well-known route
     * answers with that record's AT-URI, so the collection is part of the exact answer,
     * and it names the route itself.
     */
    publicationCollection: text
  }),
  offprint: z.object({
    /**
     * Laravel's own health page on `/up` says this. It does not touch the database —
     * process liveness only.
     */
    upMarker: text
  })
})

export type ExpectedResponses = z.infer<typeof expectedResponsesSchema>

/** `expectedResponses.json`, validated. A malformed file fails at import, and in the tests. */
export const EXPECTED_RESPONSES: ExpectedResponses = expectedResponsesSchema.parse(raw)
