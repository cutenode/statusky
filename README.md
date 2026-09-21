# Statusky

A menu bar app that watches AT Protocol infrastructure status accounts and tells you
when the network breaks.

Statusky reads the public `app.bsky.feed.post` records of accounts like
[`status.bsky.app`](https://bsky.app/profile/status.bsky.app) and
[`status.blacksky.community`](https://bsky.app/profile/status.blacksky.community),
classifies each post into an incident lifecycle stage, and surfaces the result as a
colour-coded feed with optional per-account notifications.

No account, no login, no API key: everything comes from the public AppView.

## What it does

- **Lives in the menu bar.** No dock icon, no window management. Click the tray icon
  for a popover; press `Esc` to dismiss it.
- **Opens on what you have not read.** The popover has four tabs — **Timeline**,
  **Feed**, **Alerts** and **Network** — and lands on Timeline: every source merged into
  one one-line-per-update chronology, with everything outstanding above the line and
  everything you have already seen continuing below it. The top is read the moment it is
  shown. Feed is what the AT Protocol status accounts posted; Alerts is what arrived on
  its own, pushed by a hosted status page or filed by the network checks. See
  [The four tabs](#the-four-tabs).
- **Classifies posts** as `investigating` → `identified` → `monitoring` → `resolved`,
  plus `outage`, `degraded`, `maintenance` and plain `update`. Status accounts announce
  the stage in prose rather than a structured field, so Statusky recovers it from the
  text. Each post gets a coloured rail and badge.
- **Rolls that up into a single health state** shown in the header and reflected in the
  tray icon, which turns amber while recovering and red during an active incident.
- **Per-account notification toggles**, with a master switch, an optional sound, and a
  test button — a notification the OS refuses is invisible otherwise.
- **Tracks any AT Protocol account** — paste a handle, a DID, or a `bsky.app` profile
  link. The two accounts above ship built in and can be muted but not removed.
- **Unread updates get the menu bar's attention**, in whichever of four ways you ask
  for under Settings › Menu bar: the icon beats red at 150 bpm — the rate of a heart in
  trouble — over the top of the health colour, or wears a quiet badge, or shows the
  number beside it, or does nothing at all and goes on reporting only health. What
  counts as read is a cursor per source, so trimming the post cache can never bring
  back an incident you have already dealt with. Feed and Alerts each have an unread
  filter and per-account filter chips, every update offers **mark this and everything
  older as read**, and opening a tab catches you up — or, if you would rather it did
  not, nothing is read there until you say so. See
  [Reading and unreading](#reading-and-unreading).
- Renders post rich text properly: facet-accurate links, mentions and tags, plus link
  cards, images and quoted posts.
- **Accepts pushed updates from hosted status pages** as well as polled AT Protocol
  accounts. See [Pushed status updates](#pushed-status-updates).
- **Measures the network itself**, rather than only reading what operators say about it:
  relays, Jetstreams, PDSes, AppViews, Tangled, the publishing apps and the infrastructure
  around them are probed from your own machine, on a schedule — including asking the
  services that publish a consumer cursor how far behind they are. See
  [Network checks](#network-checks).

## The four tabs

| Tab          | What is in it                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Timeline** | Every source merged into one chronology, one line each, **Unread** above the line and **Read** below it. The tab the popover opens on. Showing it reads the top. |
| **Feed**     | What the tracked AT Protocol status accounts posted: full cards, rich text, link cards, images, quoted posts.                                                    |
| **Alerts**   | What arrived without being asked for — a hosted status page's pushed deliveries, and the entries the network checks file when a service moves.                   |
| **Network**  | The dashboard: every service in the catalogue, measured from this machine. See [Network checks](#network-checks).                                                |

`Cmd`/`Ctrl`-`1` through `-4` select them in that order.

**Why Bluesky's posts are on their own.** A status account writing a post and a status
page pushing an incident are the same kind of thing — somebody telling you what they
have noticed. A relay that stopped answering our own requests is not: nobody said it, we
measured it. Merged into one list, scanning for any of the three meant reading all of
them, and the two machine-filed sources — terse, about a named service, arriving in
pairs as things break and recover — drowned out the prose. Split, each tab is scannable
for what it is.

**Why Timeline is first, and why unread is at the top of it.** You clicked the tray icon
because it was beating at you. What you want first is the thing that was beating, not an
archive with the new items scattered through it — so it sits above the line, under its
own heading, with nothing to filter or decide. What you often want next is context for
it, so the same list reads on downwards into what you had already seen. Either way the
rows stay austere: no filters, no avatars, no embeds, two lines of text per update and a
colour down the side.

## Reading and unreading

An update is unread until you deal with it, and how loudly the menu bar says so is a
setting rather than a decision the app makes for you.

**What is read is a timestamp per source, not a list of posts.** Each source carries a
cursor: everything of theirs at or before it has been read. That is the same shape the
notification gate has always used, and for the same reason — a list of unread URIs has
to be pruned as the 500-post cache is trimmed, and anything pruned out of it comes back
as unread the next time that post is fetched. A cursor cannot resurrect last week's
incident. It is also what makes **mark this and everything older as read** possible on
any update in the feed: the merged timeline is one chronology, so "I have read back to
here" is a statement about a moment.

A pure cursor would mean reading one update also read everything older from that source,
which is wrong for a feed you dip into, so updates read on their own are remembered by
URI until the run below them is contiguous — at which point they fold into the cursor
and are forgotten. The exceptions only ever cover the ragged edge above each cursor.

**Opening the Timeline catches you up.** That is what the icon is beating for: you click
it because something is unread, and having looked, you have read it. It counts the
popover being brought back to the front as well as the tab being opened, since for a menu
bar app those are the same gesture. This one is unconditional — the tab exists to be
opened, read and left — so what was unread when it appeared stays above the line for as
long as the tab does rather than dropping into **Read** out from under you, and anything
that lands while you are watching joins it wearing an unread dot.

Leaving for another tab and coming back drops that batch into **Read** and leaves the top
saying you are caught up, because by then you have read it. **Mark all as read** in the header is still there, and so is the
per-update **mark this and everything older as read** on every card in Feed and Alerts.

**Feed and Alerts do what you tell them.** Under Settings › Feed, _Mark as read_ governs
those two: showing a tab reads that tab's own updates and leaves the other's alone, or it
can be set to _Only when I say_, which leaves the count meaning exactly what you have
clicked — or to mark each update once it has actually been on screen, watched with an
`IntersectionObserver`, because a popover is short and an update below the fold has not
been read however long the window was open.

Changing the default does not change anybody's existing setting: every install that has
run before has its choice on disk, and keeps it.

**The menu bar has four voices**, under Settings › Menu bar:

| Style          | What the icon does                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Beat the icon  | One cardiac cycle on a loop, in red, over the top of the health colour. The default.                               |
| Badge the icon | A dot on whichever health icon is showing — the same statement, quietly.                                           |
| Show a count   | The number beside the plain health icon. macOS only; `Tray.setTitle` does nothing elsewhere, so it badges instead. |
| Leave it alone | The icon reports health and nothing else.                                                                          |

Health is reported either way: neutral when everything is operational, amber while
recovering, red during an active incident. The setting only decides how the icon asks
you to look at something.

## Pushed status updates

Not every status page is on AT Protocol. The ones that are not — `status.bsky.app`
itself runs on [Instatus](https://instatus.com), and Atlassian Statuspage is close
enough to share the code — will POST every incident to a URL you register with them, so
Statusky can listen for those instead of polling for them.

Turn on **Pushed updates** in settings and it starts an HTTP receiver, giving you an
endpoint to paste into a page's webhook subscription form — for Bluesky that is
[status.bsky.app/subscribe/webhook](https://status.bsky.app/subscribe/webhook). Incidents,
maintenance windows and component status changes then arrive as feed entries with the same
severity rail, unread badge and notifications as posts.

**It listens on loopback only.** A menu bar app has no business holding a port open on a
network interface, and a hosted status page cannot reach a laptop directly in any case, so
reaching it from the internet is a decision you take outside Statusky — point a tunnel
(`cloudflared`, `ngrok`, an SSH forward) at the port, which is also where TLS comes from.
The port defaults to 7385 and is fixed rather than ephemeral so a tunnel survives a
restart. `GET` the endpoint to check the whole path works: it answers
`{"ok":true,"app":"statusky"}`.

**The path is the credential.** Neither Instatus nor Statuspage lets a _subscriber_ choose
a signing key, so there is no signature to verify. The endpoint is instead
`/webhook/<secret>` with a 192-bit random secret compared in constant time, and everything
else — wrong path, wrong secret, wrong method — gets the same flat `404`. **New secret**
mints another one and invalidates the URL already handed out. Bodies are capped at 256 KB,
must be declared as JSON, and are never trusted: unknown shapes are accepted and ignored,
because a provider that sees failures eventually stops delivering.

A page registers itself the first time it delivers, appearing in the accounts panel as an
ordinary source that can be muted, silenced or removed — the only thing its `kind` changes
is that nothing tries to poll it. Registration is capped at 25 pages. Each update becomes
one entry keyed by the update's own id, so the redelivery of an incident's whole history
merges onto what is already stored rather than duplicating it, and the first delivery from
a new page announces its newest update while the backlog behind it stays quiet. Severity
comes from the payload's `status` field where there is one, which is better data than the
classifier gets from an AT Protocol post, and falls back to classifying the prose where
there is not.

## Network checks

A status account tells you what its operator has noticed. The **Network** tab tells you
what your computer can actually reach. Statusky asks each service in the catalogue the
same real questions [status.feeds.blue](https://status.feeds.blue) asks — Kuba Suder's
page, which this is a port of, down to the checks and their wording:

| Service        | What it is asked                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay          | `_health`, `com.atproto.sync.listHosts`, and a live `subscribeRepos` connection that must deliver a commit stamped within the last minute                                     |
| Jetstream      | Its greeting, and a live `subscribe` connection whose newest event must be stamped within the last minute                                                                     |
| Spacedust      | A live link stream, each link dated by the TID of the record that made it                                                                                                     |
| PDS            | `_health`, `describeServer`, `listRepos`, and a real `listRecords` read of the first active repository it names                                                               |
| Host directory | One page of the relay's `listHosts`, which checks Bluesky's whole PDS fleet at once, and `getHostStatus` for seven more hosts this machine never touches                      |
| AppView        | `_health`, two `getProfile`s, three `resolveHandle`s, four `getAuthorFeed`s, and how far its index lags                                                                       |
| Tangled        | The appview's static route and a real repository page; Bobbin's coverage, its event cursor and a record lookup; Hydrant; each knot's version and owner; each spindle's health |
| pckt           | `/up`: database, cache, search index, queue worker, failed jobs, nine queue depths, and how far its consumer has fallen behind                                                |
| Leaflet        | A published document's well-known route, a full-text search, and hourly, the newest document in a busy publication                                                            |
| Offprint       | `/up`, a custom-domain publication lookup, and hourly, the newest article published anywhere on the platform                                                                  |
| UFOs           | `/meta`, which is its own consumer cursor against the clock, and one collection's statistics                                                                                  |
| Constellation  | `blue.microcosm.links.getBacklinks`, and whether the number of links it holds is still climbing                                                                               |
| Slingshot      | `resolveHandle`, `getRecord` and `resolveMiniDoc`                                                                                                                             |
| Discover feed  | `getFeedSkeleton`                                                                                                                                                             |
| For You        | Its `did:web` document, `getFeedSkeleton`, the site itself, and what Bluesky's AppView makes of the generator                                                                 |
| CDN            | Three real images, of which the first chunk is read                                                                                                                           |
| Internet       | GitHub's API, Cloudflare and Google DNS, and Amazon's echo endpoint                                                                                                           |

Each service reads as **live**, **slow** (something took 15 seconds or more), **partial**
or **down**, exactly as the page grades them, with the failing request's own words
against it. Every request leaves from this machine and goes through Chromium's network
stack, so it takes the same route a browser tab would — system proxy, certificate store
and all — and measures your connection to each service rather than somebody else's.

Six things make that fit a program that runs all day rather than a page you open:

**The Internet group is a control.** When every one of those checks fails too, the
problem is this machine's connection: Statusky says you are offline, judges nothing,
records nothing, and retries the control checks every thirty seconds until they answer —
then measures everything again.

**A failure has to be seen twice.** The first sighting books a re-check of that service
alone twenty seconds later, so a real outage is confirmed in seconds while a single
dropped request never reaches the tray or a notification. A recovery is believed at once.

**An AppView is judged against its peers, not the clock.** The page fails an AppView
whose newest post from a few busy accounts is over fifteen minutes old; overnight, that
fails all of them at once. Statusky compares each AppView with the freshest post any of
them returned, which is what actually shows an indexer falling behind.

**Where a service will tell you how far behind it is, that is the check.** A stalled
index answers every request correctly from what it has already indexed, so a health
endpoint cannot see it. A few services publish their own consumer cursor, and those are
worth more than everything else on the row: UFOs' `/meta` names the microsecond it has
reached, pckt's `/up` names the seconds it is behind, and Bobbin says whether it has
finished backfilling. Where there is no cursor but there is a counter — Constellation's
link count — Statusky watches it move instead, and only calls it stopped after three
sweeps standing still, because one quiet ten minutes proves nothing.

**Hobby infrastructure does not get a vote.** Some of what is measured here publishes no
uptime promise at all; `pds.rip` says "uptime: no guarantee, backups: none" on its own
homepage. Those services are probed, shown and filed in the feed like any other, marked
**community** on the dashboard — and left out of the header and the tray, because one
abandoned sandbox should not speak for the network.

**The dashboard shows the same rows every sweep.** Bluesky's PDS fleet is eighty-nine
hosts and growing, and the relay's `com.atproto.sync.listHosts` is the only authoritative
enumeration of anything in the Atmosphere — 6,312 hosts, just under half a megabyte of
them. Rather than rank that list and probe whoever is on top, the **Host directory** row
reads one page of it and grades Bluesky's whole fleet at once, second-hand and for a
single request. Every row beside it is named in the catalogue, which is what lets an
uptime strip mean something: it always measures the same service.

Confirmed outages and recoveries are filed in the feed under a source called **Network
checks**, so they sit in the timeline beside what the status accounts posted — often
before it — and carry the same severity rail, unread badge and notifications. Click one
and the dashboard opens at that service. The source can be silenced or hidden under
Accounts like any other, and hiding it takes the checks out of the header and tray
rollup as muting any account does.

Nothing waits for the sweep to finish. Each request appears on the dashboard as it is
made, each service is settled, recorded and judged the moment its own checks are in —
so a relay that answered in 200 ms is never shown as still being checked because a PDS
is spending thirty seconds timing out — and a confirmed outage is filed as soon as the
control checks vouch for the connection, rather than at the end.

A sweep is about a hundred and eighty small requests and eleven brief stream
connections, across fifty-odd services. No more than sixteen services are in flight at
once — the cost of that ceiling is wall clock in the worst case, and what it buys is not
opening a couple of hundred sockets in the same instant, which is hard on a laptop and
rude to the small operators on the other end; one of the indexes here runs on a Raspberry
Pi in its author's house. It runs every ten minutes by default (2 minutes to an hour,
under Settings), when the machine wakes, and when the popover is opened on a dashboard
older than two minutes.

## Running it

```bash
npm install && npm run dev
```

Node 22.12+ (or 20.19+) is required. If Electron's binary did not download during
install, run `node node_modules/electron/install.js`.

## Building a distributable

```bash
npm run dist:mac
```

`dist:win` and `dist:linux` are also available. Output lands in `release/`. The build
runs typechecking and linting first via `npm run check`.

Build configuration lives in `electron-builder.ts` (the name matters — that is what
electron-builder discovers automatically; `electron-builder.config.ts` is not).

### Code signing

Signing is decided at build time in `electron-builder.ts`, so a checkout with no
certificates still builds.

**macOS.** With no certificate available the app is ad-hoc signed (`identity: '-'`)
under the hardened runtime. That is enough to launch on Apple silicon but not enough
for Gatekeeper on any other machine — and not enough for macOS to grant notification
permission, which is why notifications are refused in local builds.

With a Developer ID Application certificate the build signs and notarizes instead.
The certificate can come from the login keychain, or from the environment:

| Variable                                                | Purpose                                     |
| ------------------------------------------------------- | ------------------------------------------- |
| `CSC_LINK`                                              | base64 of the `.p12`, or a path to it       |
| `CSC_KEY_PASSWORD`                                      | its passphrase                              |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect key used to notarize      |
| `APPLE_TEAM_ID`                                         | pins the designated requirement to the team |

electron-builder imports `CSC_LINK` into a throwaway keychain itself, so no keychain
setup script is needed in CI. `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` +
`APPLE_TEAM_ID` works for notarization as well, but an API key is preferred.

Entitlements are `build/entitlements.mac.plist` (app) and
`build/entitlements.mac.inherit.plist` (helpers). Both allow JIT and unsigned
executable memory, which V8 needs under the hardened runtime.

Check what a build actually produced with:

```bash
codesign -dv --verbose=4 release/mac-arm64/Statusky.app
```

**Windows.** Signing goes through Azure Trusted Signing when all four of
`AZURE_CODE_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT_NAME`,
`AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME` and `AZURE_CODE_SIGNING_PUBLISHER_NAME`
are set; setting only some of them is an error rather than a silently unsigned build.
Authentication is separate — electron-builder's TrustedSigning module reads
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. Signing runs through
PowerShell, so it only works on a Windows runner.

**Linux.** AppImage and deb are not signed.

## Development

| Command                 | Purpose                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `npm run dev`           | Electron + Vite with hot reload                                           |
| `npm test`              | Vitest suite (both projects)                                              |
| `npm run test:node`     | Main process, preload bridge and shared logic, under both wiring branches |
| `npm run test:renderer` | Svelte components and renderer state only                                 |
| `npm run test:coverage` | Coverage, with a floor the suite must not fall below                      |
| `npm run check`         | `svelte-check` + `tsc` + `oxlint`                                         |
| `npm run format`        | Prettier                                                                  |
| `npm run icons`         | Regenerate every icon from `scripts/gen-icons.mjs`                        |
| `npm run fixture`       | Re-snapshot live status posts into the UI preview fixture                 |
| `npm run generate:ipc`  | Regenerate `src/ipc/` from `schemas/statusky.eipc`                        |

`generate:ipc` runs automatically before `dev`, `start`, `build`, `check` and every test script, so you
should never need it by hand. It matters that it does: which branch of the origin
validator gets compiled in is decided at generation time, not at runtime.

### Previewing the UI in a browser

The renderer is a plain Svelte app behind a narrow IPC bridge, so it can run without
Electron. With `npm run dev` going, open:

```
http://localhost:5173/preview.html
```

`preview.html` stubs `window.statusky` with a fixture of real status posts, which makes
design iteration fast and lets you diff both themes (`?theme=light`, `?theme=dark`).
It is dev-server only and is never a build input. Its shape has to match the interfaces
in `schemas/statusky.eipc`, since that is what the real preload exposes.

## How it is put together

```
src/
├── shared/     Domain logic used by both processes — pure, and where the tests live
│   ├── bsky.ts       AppView client and post normalisation
│   ├── status.ts     Incident-stage classification and health rollups
│   ├── richtext.ts   Byte-offset facet segmentation
│   ├── webhook.ts    Status-page payloads, normalised into the same posts
│   ├── network.ts    The catalogue of measured services, and how their checks are judged
│   ├── cbor.ts       Just enough DAG-CBOR to read a relay's firehose frames
│   ├── types.ts      The structured-cloneable types that cross IPC
│   ├── schemas.ts    Those types as Zod schemas, for validating them at the boundary
│   └── bridge.ts     Reaching `window.statusky`, and reading errors back off it
├── main/       Electron main process: the only place that touches network or disk
│   ├── model.ts      Owns all state; polls, merges, decides what to notify about
│   ├── state.ts      Pure state transitions (dedupe, notification cursors, read cursors)
│   ├── store.ts      Persistence and config migration
│   ├── webhook.ts    The loopback HTTP receiver for pushed updates
│   ├── probes.ts     The requests each kind of service is measured with
│   ├── network.ts    Sweeping, debouncing failures, and noticing being offline
│   ├── tray.ts       Tray icon, tooltip and menu
│   ├── window.ts     The popover window
│   └── position.ts   Where the popover goes relative to the tray icon
│   └── protocol.ts   Serves the packaged renderer over app://statusky
├── preload/    The context-isolated bridge — three lines; the rest is generated
├── renderer/   Svelte 5 + shadcn-svelte UI
├── ipc/        Generated from schemas/statusky.eipc. Not checked in; do not edit
└── test/       The harness: doubles for Electron, the store, the AppView and the network
```

Three decisions shape everything else:

**All network and disk access lives in the main process.** The renderer runs sandboxed
with context isolation and no Node integration; it receives whole `AppState` snapshots
over IPC and sends back narrow, individually-typed requests. There is no generic
`invoke` escape hatch, and the renderer cannot drift from what is persisted.

**The IPC boundary is declared once and generated.** See [The IPC boundary](#the-ipc-boundary).

**Notifications and unread are both gated on per-source timestamp cursors**, not on a
set of seen post URIs. A source's first sync seeds both silently, so adding an account
never fires a burst of historical notifications or badges, and trimming the post cache
can never re-notify you about an incident from last week. `AppState.unread` is derived
from the read cursors on every push rather than stored, so there is no second copy to
keep in step. See [Reading and unreading](#reading-and-unreading).

**What is measured and what is claimed are kept apart.** The network checks' feed
entries record what _changed_; the header, the tray and the dashboard show what is
_true now_, straight from the live measurement. The worse of the two verdicts wins the
headline, and when they agree the operators' wording is kept — an operator's "Active
incident" says more than a probe's.

**A pushed source is an `Account` like any other.** Its `did` is `webhook:<page id>`
rather than a real DID, and its `kind` keeps it out of the polling loop — but muting,
per-source notification toggles, unread counts, the feed's filter chips and the health
rollup all work through the same code as they do for a tracked handle, with no second
path to keep in step.

## The IPC boundary

`schemas/statusky.eipc` is the single description of what the renderer may ask the main
process to do. [EIPC](https://electron-ipc.com/) turns it into `src/ipc/`: the handler
registrations, the argument and return-value validation, the `contextBridge` exposure
and a typed client for the renderer. None of that is written by hand, so the two sides
cannot drift, and `src/ipc/` is generated rather than checked in.

`src/main/ipc.ts` supplies the behaviour behind each declared method and nothing else.
The payload types stay in `src/shared/types.ts`; `src/shared/schemas.ts` mirrors them as
Zod schemas, which the schema references through `zod_reference` and which the generated
wiring runs on every argument and every return value. A pair of compile-time assertions
at the bottom of `schemas.ts` fails the build the moment the two definitions disagree.

### Validating the origin

Every interface carries `[Validator=PopoverOnly]`, which runs twice: in the preload, to
decide whether to expose the API to this frame at all, and again in the main process on
every individual call.

A packaged build only accepts `app://statusky`, in the top-level frame, from a packaged
app. That origin is real rather than nominal: `src/main/protocol.ts` registers `app:` as
a standard, secure scheme and serves the built renderer over it, so nothing else on the
machine can claim it. Loading the renderer from `file://` — as the app used to — would
have made the check meaningless, because every local page on disk shares that one opaque
origin.

Running from source takes a second branch, which covers the two ways of doing it:
`npm run dev`, where the popover comes from electron-vite's server on loopback, and
`npm start`, which previews the built renderer over `app://statusky` but unpackaged — the
one thing the production branch refuses. Which branch is compiled in is fixed when
`generate:ipc` runs, not at runtime, so each of those scripts generates the development
wiring first and `npm run build` generates the production wiring: a production build does
not contain the loopback rule, or the unpackaged allowance, at all.

A page that fails the check gets no `window.statusky` whatsoever, and a call that somehow
reaches main anyway is refused before any handler sees it. `src/main/ipc.test.ts` and
`src/preload/index.test.ts` exercise both halves, including sub-frames, `file://` pages
and unpackaged builds.

### Keeping the wiring and the launch mode together

The branch is chosen when the wiring is generated, but whether the app is packaged is
only known once it runs. When the two disagree, every call from the popover is refused
with an error that blames the origin, which is how `npm start` once broke. Four things
now stop that from happening quietly:

- **Every script regenerates first.** Each script that runs the app, builds it or runs
  Vitest has its own `pre` hook or chains `npm run build`. `src/test/scripts.test.ts`
  walks `package.json` the way npm does, following exact-name hooks, `npm run` chains and
  `&&`, and fails on any script that would run against wiring it did not generate. A
  script added without a hook fails that test.
- **The wiring records which branch it holds.** `generate:ipc` writes
  `src/ipc/environment.ts`, exporting `IPC_ENVIRONMENT`, and notes the environment in
  `src/ipc/.eipc-generated`.
- **Startup names a mismatch.** `bootstrap()` compares `IPC_ENVIRONMENT` with
  `app.isPackaged`. Production wiring running unpackaged logs what to run instead.
  Development wiring in a packaged app logs the problem and shows a dialog, because a
  menu bar app has no console to read.
- **Packaging refuses development wiring.** electron-builder's `beforePack` hook reads the
  compiled validator in `out/`, which is what actually gets packed and can be older than
  `src/ipc`. It stops unless it finds production wiring and nothing else. Packaging with
  `--prepackaged` skips `beforePack`, so it skips this check too.

To see which branch is compiled in right now:

```bash
grep -oE "isPackaged\)? === (true|false)" src/ipc/_internal/browser/statusky.ts out/main/index.js
```

`true` means production and `false` means development.

## Testing

```bash
npm test              # everything
npm run test:coverage # with the coverage floor enforced
```

Every layer is covered — main process, preload bridge, shared logic, renderer state and
every Svelte component — by running the real code against a harness of behavioural
doubles rather than by mocking the module under test.

### The harness

`src/test/` stands in for the three things a test cannot have: Electron, a config file
on disk, and the network. Vitest aliases `electron`, `electron/renderer` and
`electron-store` to the doubles, so importing any main- or preload-process module
transparently gets them.

| Module                 | Stands in for                                                                     |
| ---------------------- | --------------------------------------------------------------------------------- |
| `electron.ts`          | `app`, `ipcMain`/`ipcRenderer`, `BrowserWindow`, `Tray`, `Menu`, `protocol`, …    |
| `electron-renderer.ts` | `webFrame`, so the preload can be asked whether it is a top-level frame           |
| `page.ts`              | `window.location`, so a test can serve the preload any origin it likes            |
| `electron-store.ts`    | The persisted config, in memory, copying on read and write like the real one      |
| `appview.ts`           | The public AppView: three XRPC methods, per-actor failures, hangs and rate limits |
| `bridge.ts`            | `window.statusky`, for component tests that do not need a main process            |
| `factories.ts`         | Total builders for `Account`, `StatusPost`, `Settings`, `AppState`                |
| `harness.ts`           | All of the above, wired into a running app                                        |

The doubles are behavioural, not inert. `ipcRenderer.invoke` really reaches the handler
registered on that page's `WebContents`, carrying a `senderFrame` the origin validator
can inspect; `webContents.send` really reaches `ipcRenderer.on`; windows track their own
visibility. So `createHarness()` boots the actual store, `Model`, generated IPC wiring,
tray and popover, and hands back the preload bridge the renderer would call:

```ts
const app = await createHarness()
seedFeed(app.appview, BUILTIN_PROFILES.bsky, [{ text: 'Investigating…' }])

await app.api.Feed.refresh() // through the real bridge, origin check included

expect(app.state().posts[0].severity).toBe('investigating')
expect(app.trayIcon()?.image.path).toContain('trayIncident.png')
```

Because those calls go through the generated wiring, a harness test also proves the
boundary itself: point the popover's frame at another origin and the same call is
refused.

`src/test/app.e2e.test.ts` uses that to walk whole journeys — a first launch, an
incident arriving and being read, the network dropping and recovering — and
`src/renderer/src/journeys.test.ts` does the same through the rendered UI.

`src/test/doubles.test.ts` pins the doubles themselves, including a contract test that
fails if the bridge double drifts from the real preload surface.

The webhook receiver is the one thing not run against a double: `src/main/webhook.test.ts`
binds a real socket on an ephemeral port and makes real HTTP requests to it, because what
matters there is what an actual request gets back. The AppView double passes any request
that is not an XRPC call straight through to the real `fetch`, so a harness test can post
a delivery to the app's own endpoint and watch it come out as a feed entry.

### Both validator branches

`npm test` generates production wiring, so on its own the suite would only ever meet
the production branch of `PopoverOnly`. A second Node project, `node-development`, runs
the `*.development.test.ts` files against development wiring. Its global setup generates
that wiring into `src/ipc-development/` on every run, using the same `generate:ipc`
script with `EIPC_WIRING_FOLDER` pointing elsewhere. That way the wiring `npm run dev` and
`npm start` use is tested too, without replacing the production wiring the rest of the
suite reads.

### Notable cases

The severity classifier is asserted against real post text from both status accounts —
including a genuine typo (`"We are investigate connectivity issue"`) and the `Resolved:`
prefix convention, where the prefix restates the original incident text and must win
over the body. Elsewhere the suite pins the things that are easy to regress silently:
`shell.openExternal` refusing non-http(s) schemes, facet segmentation surviving
malformed byte offsets, the notification cursor never re-firing for old incidents, and
the popover clamping itself inside the work area on every screen edge. The IPC boundary
gets the same treatment: a call from the wrong origin, from a sub-frame, from a
`file://` page or from an unpackaged build is refused, an argument of the wrong shape
never reaches an implementation, and a path that tries to climb out of the renderer
bundle over `app://` is never read from disk. The read cursors get it too: reading one
update out of order does not read the older ones under it, a cursor never advances onto
a timestamp an unread post also carries, and a config written by the previous schema is
rebuilt into cursors that badge exactly the posts its unread list badged.

## Licence

MIT
