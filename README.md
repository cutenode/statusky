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
  for a popover; press `Esc` to dismiss it — after closing whatever menu or edit it would
  close first.
- **Opens on what you have not read.** The popover has three tabs — **Timeline**,
  **Feed** and **Network** — and lands on Timeline: every source merged into
  one one-line-per-update chronology, with everything outstanding above the line and
  everything you have already seen continuing below it. The top is read the moment it is
  shown. Feed is what the AT Protocol status accounts posted, at the length they posted
  it; what a machine filed — a hosted status page's pushed delivery, a network check's
  own finding — is terse enough that the Timeline is the whole of it. See
  [The three tabs](#the-three-tabs).
- **Classifies posts** as `investigating` → `identified` → `monitoring` → `resolved`,
  plus `outage`, `degraded`, `maintenance` and plain `update`. Status accounts announce
  the stage in prose rather than a structured field, so Statusky recovers it from the
  text. Each post gets a coloured rail and badge.
- **Rolls that up into a single health state** shown in the header and reflected in the
  tray icon, which turns amber while recovering and red during an active incident — and
  says whose report it is and how long ago they filed it, because a claim nobody has
  renewed for three days is not the present tense. See
  [Claims have an age](#claims-have-an-age).
- **Per-account notification toggles**, with a master switch, an optional sound, and a
  test button — a notification the OS refuses is invisible otherwise.
- **Says nothing to an empty chair.** Banners raised while the screen is locked, the
  machine is asleep or nobody has touched the keyboard for five minutes are held, and
  arrive as a single summary when you come back — with anything you dealt with in the
  meantime dropped from it. See [Reading and unreading](#reading-and-unreading).
- **Tracks any AT Protocol account** — paste a handle, a DID, or a `bsky.app` profile
  link. The two accounts above ship built in and can be muted but not removed.
- **Unread updates get the menu bar's attention**, in whichever of four ways you ask
  for under Settings › Menu bar: the icon beats red at 150 bpm — the rate of a heart in
  trouble — over the top of the health colour, or wears a quiet badge, or shows the
  number beside it, or does nothing at all and goes on reporting only health. The beat
  stands down to the badge when the OS has been asked for reduced motion, without
  touching what you chose. What counts as read is a cursor per source, so trimming the
  post cache can never bring back an incident you have already dealt with. Feed has an
  unread filter and per-account filter chips, every update there offers
  **mark this and everything older as read**, and opening the tab catches you up — or, if
  you would rather it did not, nothing is read there until you say so. See
  [Reading and unreading](#reading-and-unreading).
- Renders post rich text properly: facet-accurate links, mentions and tags, plus link
  cards, images and quoted posts.
- **Accepts pushed updates from hosted status pages** as well as polled AT Protocol
  accounts. See [Pushed status updates](#pushed-status-updates).
- **Has the ways in and out a desktop app should have**: notification buttons that deal
  with an update where it stands, `statusky://` links that open a particular view, a
  handle dragged onto the menu bar icon to start watching it, a native right-click menu
  in the popover with the macOS share sheet behind it, an optional global shortcut that
  summons the popover from anywhere, and a login item that says so when the OS refuses
  it. See [Ways in and out](#ways-in-and-out).
- **Keeps itself current, or says plainly that it cannot.** macOS and Windows update
  themselves in the background and offer the restart in the menu bar; Linux, and any
  build Squirrel will not touch, are told that a newer release exists and where to get
  it. See [Staying up to date](#staying-up-to-date).
- **Measures the network itself**, rather than only reading what operators say about it:
  relays, Jetstreams, PDSes, AppViews, Tangled, the publishing apps and the infrastructure
  around them are probed from your own machine, on a schedule — including asking the
  services that publish a consumer cursor how far behind they are. See
  [Network checks](#network-checks).

## The three tabs

| Tab          | What is in it                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Timeline** | Every source merged into one chronology, one line each, **Unread** above the line and **Read** below it. The tab the popover opens on. Showing it reads the top. |
| **Feed**     | What the tracked AT Protocol status accounts posted: full cards, rich text, link cards, images, quoted posts.                                                    |
| **Network**  | The dashboard: every service in the catalogue, measured from this machine. See [Network checks](#network-checks).                                                |

`Cmd`/`Ctrl`-`1` through `-3` select them in that order.

**Why Bluesky's posts are on their own.** A status account writing a post and a status
page pushing an incident are the same kind of thing — somebody telling you what they
have noticed. A relay that stopped answering our own requests is not: nobody said it, we
measured it. Feed is where you go to read what people wrote, at the length they wrote
it, so the machine-filed sources — terse, about a named service, arriving in pairs as
things break and recover — stay out of it rather than drowning out the prose. They are
not hidden: the Timeline lists everything, and one line is the whole of what a
measurement has to say.

**Why Timeline is first, and why unread is at the top of it.** You clicked the tray icon
because it was beating at you. What you want first is the thing that was beating, not an
archive with the new items scattered through it — so it sits above the line, under its
own heading, with nothing to filter or decide. What you often want next is context for
it, so the same list reads on downwards into what you had already seen. Either way the
rows stay austere: no filters, no avatars, no embeds, two lines of text per update and a
colour down the side.

## Claims have an age

A status account writes that it is working on something and then, very often, writes
nothing else. The window's end was in the sentence that opened it; the resolution went to
a hosted status page instead of back to the feed; the work simply finished and saying so
did not seem worth a post. None of that makes the post wrong. It makes it old.

**So a claim stops being the present tense.** Twelve hours after an active incident or a
recovery, and a day after a maintenance window, the post stops counting towards the
header and the tray goes back to neutral. The thresholds are per state and fixed —
deliberately not calibrated from each source's own cadence, because the history that
would calibrate it is the same history that contains the silences, so it would calibrate
towards tolerating them. Twelve hours is already longer than `status.bsky.app` has ever
taken to follow up on an active post.

**Nothing is deleted, and nothing flips to green.** A withdrawn claim is not replaced by
its opposite: saying "all clear" on a timer would swap a claim the app cannot support for
one it cannot support either. It is moved out of the verdict and into the line underneath
it, with its age on it — `Blacksky Status reported maintenance 3 days ago` — so the reader
can weigh it, which is the judgement the app used to make badly on their behalf. The
header above it goes back to reporting what this machine has actually measured. In the
feed and on the timeline the post keeps its colour and its badge, because there it is a
post rather than a verdict, and the accounts list goes on showing what each source last
said however long ago it said it.

**The line underneath names the source either way.** While a claim is current it reads
`Bluesky Status · 6 minutes ago`, because the headline above it already names the stage
and what it was missing was who and when. Several sources saying the same thing get a
`+1`. When nobody is being quoted — everything calm, or the verdict coming from the
network checks — the line goes back to saying when the feed was last checked.

**The one new wording** is `Nothing reported recently`, for the case where the only thing
on file has gone stale and the network checks are off as well. `No data yet` would be
false: there is data, it is just old, and the line underneath says how old.

Over the fifty days to 22 September 2026, the two built-in accounts between them left the
header reporting something other than "All systems operational" 63% of the time — nearly
all of it maintenance, including one four-hour window that stayed the app's present tense
for eighteen days. Replaying the same posts through the current code puts that at 15%,
with a source named under the headline for 63% of the window, so none of it is hidden.

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

**A cursor is a moment that has happened.** An update's date is whatever its author
wrote, and an author's clock can be wrong or deliberately in the future; taken at its
word, a post dated 2099 would sit at the top of the feed for good, silence every real
post under it, and — read through — move the cursor somewhere nothing will ever reach
again. So an AT Protocol post is dated no later than the moment the AppView indexed it,
a pushed update no later than five minutes after it arrived (or by its arrival if it
claims more), and no read cursor ever moves past the present. A cursor stored by an
earlier version that already points into the future is brought back to now on launch.

**Opening the Timeline catches you up.** That is what the icon is beating for: you click
it because something is unread, and having looked, you have read it. It counts the
popover being brought back to the front as well as the tab being opened, since for a menu
bar app those are the same gesture. This one is unconditional — the tab exists to be
opened, read and left — so what was unread when it appeared stays above the line for as
long as the tab does rather than dropping into **Read** out from under you, and anything
that lands while you are watching joins it wearing an unread dot.

Leaving for another tab and coming back drops that batch into **Read** and leaves the top
saying you are caught up, because by then you have read it. **Mark all as read** in the header is still there, and so is the
per-update **mark this and everything older as read** on every card in Feed.

**Nothing is announced to an empty chair.** A banner raised while the screen is locked,
the machine is asleep, another user is switched in, or nobody has touched the keyboard for
five minutes is held rather than shown, and everything held arrives as one summary when
you come back. Holding changes nothing about what an update _is_: no cursor moves, nothing
is marked read, and the icon goes on beating the whole time — so the incident is still
unread when you sit back down, and opening the Timeline still catches you up on it in the
ordinary way. That is also what makes the summary safe to filter: anything you already
dealt with in the popover while its banner waited is dropped from it, because a
notification that resurrects something you have finished with is worse than no
notification at all. A single held update is shown as itself rather than summarised —
"1 update from Bluesky" throws away the sentence the operator wrote, and the ordinary
banner already opens the right thing.

**Feed does what you tell it.** Under Settings › Feed, _Mark as read_ governs that tab:
showing it reads the posts in it and leaves everything else alone, or it can be set to
_Only when I say_, which leaves the count meaning exactly what you have clicked — or to
mark each update once it has actually been on screen, watched with an
`IntersectionObserver`, because a popover is short and an update below the fold has not
been read however long the window was open.

Changing the default does not change anybody's existing setting: every install that has
run before has its choice on disk, and keeps it.

**The menu bar has four voices**, under Settings › Menu bar:

| Style          | What the icon does                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Beat the icon  | One cardiac cycle on a loop, in red, over the top of the health colour. The default, and the one that stands down under reduced motion. |
| Badge the icon | A dot on whichever health icon is showing — the same statement, quietly.                                                                |
| Show a count   | The number beside the plain health icon. macOS only; `Tray.setTitle` does nothing elsewhere, so it badges instead.                      |
| Leave it alone | The icon reports health and nothing else.                                                                                               |

Health is reported either way: neutral when everything is operational, amber while
recovering, red during an active incident. The setting only decides how the icon asks
you to look at something.

**The styles degrade rather than fail.** _Show a count_ needs `Tray.setTitle`, which
exists on macOS and nowhere else, so elsewhere it badges the icon instead. _Beat the icon_
becomes _Badge the icon_ whenever the OS has been asked for reduced motion: ten icon swaps
a second, in the corner of the screen, all day, is close to the top of the list of things
that setting exists to stop — an accessibility and photosensitivity concern rather than a
matter of taste — and since beating is the _default_, most of the people it would reach
never chose it. The popover is the only part of Statusky that can read that preference;
`nativeTheme` covers dark mode and high contrast and stops there. So the answer arrives
over IPC, and until some page has reported in the app assumes reduced motion. Being wrong
in that direction costs somebody a badge for the second before the page loads; being wrong
in the other flashes an icon at ten hertz at somebody who asked the entire system not to.
Neither degradation edits your setting, which starts working again the moment the machine
can honour it. The popover honours the preference too: lights that pulse or ping stay
still, and panels change and scroll without animating.

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

**The secret is sealed in the OS credential store**, rather than written into
`statusky.json` beside everything else, where anything running as you could read the one
string protecting the endpoint. It goes through Electron's `safeStorage` — Keychain on
macOS, libsecret or KWallet on Linux, DPAPI on Windows — and is held as base64, because
the config file is JSON and the ciphertext is bytes; exactly one of the two keys ever
holds the value. A Linux desktop with no secret service running is a real configuration
rather than a mistake, so there is an explicit plaintext fallback instead of a refusal to
start. A secret already in the clear from an older version is re-sealed carrying its value
across rather than regenerated, because regenerating would silently break whatever tunnel
you had already pointed at your endpoint, with nothing to tell you why. The read is
deliberately lazy, so the default settings — where pushed updates are off — never open the
credential store at all.

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

| Service       | What it is asked                                                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay         | `_health`, `com.atproto.sync.listHosts`, and a live `subscribeRepos` connection that must deliver a commit stamped within the last minute                                                                            |
| Jetstream     | Its greeting, and a live `subscribe` connection whose newest event must be stamped within the last minute; Bluesky's two and microcosm's two                                                                         |
| Spacedust     | A live link stream, each link dated by the TID of the record that made it                                                                                                                                            |
| PDS           | `_health`, `describeServer`, `listRepos`, a real `listRecords` read of the first active repository it names, and whether Bluesky's relay still carries it                                                            |
| bsky.social   | `_health`, `describeServer`, and the OAuth metadata every app reads before sending someone there to sign in                                                                                                          |
| AppView       | `_health`; for each of six accounts a `getProfile`, a `resolveHandle` that must return that account's own DID, and a `getAuthorFeed`; how far its index lags its peers; and whether it has indexed posts seconds old |
| Tangled       | The appview's static route and a real repository page; Bobbin's coverage, its event cursor and a record lookup; Hydrant; `tngl.sh` as a PDS; each knot's version and owner; each spindle's health                    |
| pckt          | `/up`: the application, its database and its cache, and how far its consumer has fallen behind; and a blog's publication lookup                                                                                      |
| Leaflet       | A published document's well-known route, a full-text search, and hourly, the newest document in a busy publication                                                                                                   |
| Offprint      | `/up`, and a custom-domain publication lookup                                                                                                                                                                        |
| UFOs          | `/meta`, which is its own consumer cursor against the clock, and one collection's statistics                                                                                                                         |
| Constellation | `blue.microcosm.links.getBacklinks`, and whether the number of links it holds is still climbing                                                                                                                      |
| Slingshot     | `resolveHandle`, `getRecord` and `resolveMiniDoc`                                                                                                                                                                    |
| PLC directory | `_health`, one DID document, and whether an operation has been written in the last five minutes                                                                                                                      |
| Discover feed | `getFeedSkeleton`                                                                                                                                                                                                    |
| For You       | Its `did:web` document, `getFeedSkeleton`, the site itself, and what Bluesky's AppView makes of the generator                                                                                                        |
| CDN           | Three real images, of which the first chunk is read                                                                                                                                                                  |
| Internet      | GitHub's API, Cloudflare and Google DNS, and Amazon's echo endpoint                                                                                                                                                  |

Each service reads as **live**, **slow**, **partial** or **down**, as the page grades them,
with the failing request's own words against it; what counts as slow is the one place
Statusky departs from it, below. Every request leaves from this machine and goes through
Chromium's network stack, so it takes the same route a browser tab would — system proxy,
certificate store and all — and measures your connection to each service rather than
somebody else's.

What each service is asked _about_ — the accounts, the feeds, the CDN's images, the Tangled
repository, the pckt, Leaflet and Offprint documents — is other people's content, and any
of it can be deleted out from under a check that then fails for reasons that have nothing
to do with the service. So it is data rather than code: the defaults are
`src/shared/probeTargets.json`, and a user can replace the whole document
(`Settings.probeTargets`) without waiting for a release. The exact words each answer is held
to live beside it, in `src/shared/expectedResponses.json`. A replacement pckt or Offprint
publication is looked up in its own record, through Slingshot, to find where it is served;
only an `https` URL on a public hostname is followed, and if Slingshot cannot answer the
check is left out rather than failed. A Tangled `goGetPath` is a path on `tangled.org` and
nowhere else: one that would resolve to another host is refused.

The same document is where somebody running their own PDS adds it. **Your PDSes**, under
Settings › Check targets, takes up to five hosts; each gets a row of its own at the top of
the PDS panel, is asked everything the catalogue's PDSes are, and counts towards the tray
like any core service, because it is the one the person who listed it cares about most.
Edits in progress there are kept when you switch tabs or a notification opens the
dashboard, until you save or discard them.

Ten things make that fit a program that runs all day rather than a page you open:

**The Internet group is a control.** When every one of those checks fails too, the
problem is this machine's connection: Statusky says you are offline, judges nothing,
records nothing, and retries the control checks every couple of minutes until they
answer — and hears about it sooner than that whenever a popover is open, because a page is
told the instant the interface comes back where a timer would sit out its wait first.
Then it measures everything again.

**A failure has to be seen twice.** The first sighting books a re-check of that service
alone twenty seconds later, so a real outage is confirmed in seconds while a single
dropped request never reaches the tray or a notification. A recovery is believed at once.
A sweep that starts while a re-check is waiting takes it along rather than cancelling it.

**An AppView is judged against its peers, not the clock.** The page fails an AppView
whose newest post from a few busy accounts is over fifteen minutes old; overnight, that
fails all of them at once. Statusky compares each AppView with the freshest post any of
them returned, which is what actually shows an indexer falling behind. The comparison is
made on the accounts that AppView has: one that has not indexed an account says so on its
lookups, and is not also marked hours behind for missing posts it was never going to have.

The accounts are the page's, bar three. It reads three prolific bot accounts that
between them post every minute; W Social's AppView will not index them, because it takes
accounts from elsewhere only once `bsky.app` has verified them. Statusky reads Reuters,
The Guardian and Al Jazeera instead: verified, on every AppView, and spread across time
zones. With the page's other three, a day measured in September 2026 never went twenty
minutes without a post from one of them, and 95% of the time went less than ten. That is
coarser than the bots: in a quiet stretch, a lag just past the fifteen minutes the check
allows can go unseen for a sweep, where before it could not.

So the finer measurement does not wait on anybody to post. Each sweep takes ten posts off
Bluesky's Jetstream the moment they are created, gives every AppView ten seconds, and asks
each for all ten in one `getPosts`. On 30 September 2026 Bluesky's, Blacksky's and
Eurosky's AppViews had all but one or two of a sample within three seconds; the one or two
never turned up, because some posts are deleted or taken down before anybody asks. So an
AppView passes with half the sample, and one that finds fewer is behind by more than a
hiccup. W Social's is left out of this one, since a sample of the whole network is mostly
accounts it does not index by design. When no sample can be had — the Jetstream is down,
or quiet — the AppViews go without the check rather than being blamed for a stream they
do not own; the Jetstream's own row says what happened.

**Where a service will tell you how far behind it is, that is the check.** A stalled
index answers every request correctly from what it has already indexed, so a health
endpoint cannot see it. A few services publish their own consumer cursor, and those are
worth more than everything else on the row: UFOs' `/meta` names the microsecond it has
reached, pckt's `/up` names the seconds it is behind, and Bobbin says whether it has
finished backfilling. pckt's `/up` reports its search index and failed jobs as well, and
those are left alone: they read as unwell while pckt serves pages and keeps current. The
PLC directory has no cursor, but its export will say whether anything has been written in
the last five minutes, which is the difference between a directory that is resolving and
one that is also still accepting new accounts and handle changes. Where there is no cursor
but there is a counter — Constellation's link count — Statusky watches it move instead,
and only calls it stopped after three sweeps standing still, because one quiet ten minutes
proves nothing.

**A PDS is asked about from the outside too.** A PDS can answer every request perfectly
while nobody is listening to it: a relay that has throttled, banned or lost track of a host
stops passing its commits on, and its users' posts stop appearing anywhere else. So each
PDS row also asks Bluesky's relay, `bsky.network`, for `getHostStatus` on that host.
`active` and `idle` pass; anything else, or never having heard of the host, fails the row
as partial. It is the relay's opinion, though, and when the relay itself cannot answer, the
check is left off the row entirely rather than failed — otherwise one relay outage would
be filed as eighteen PDS outages, when the relay's own row already says what is wrong.

**Hobby infrastructure does not get a vote.** Some of what is measured here publishes no
uptime promise at all; `pds.rip` says "uptime: no guarantee, backups: none" on its own
homepage. Those services are probed, shown and filed in the feed like any other, marked
**community** on the dashboard — and left out of the header and the tray, because one
abandoned sandbox should not speak for the network. The For You feed is one too: it is a
single program on its author's PC at home behind a small rented VPS, which the author
documents, and it promises no more than `pds.rip` does. W Social's AppView is graded the same
way for now: it is in public beta and indexes only its own users and accounts verified by
`bsky.app`, so an account you add to the checks may simply not be there — worth seeing,
but not worth an amber tray.

**You choose which panels speak for the network.** Everything is measured and filed in the
feed, but only the panels ticked under Settings › Network checks › **Count in the menu
bar** can turn the icon amber or red, or raise a banner when banners are set to core
services. Relays, streams, AppViews, PDSes and the other infrastructure count by default;
Tangled and the publishing apps do not, because an outage there says nothing to somebody
who never uses them, and whoever does can tick them. A panel left out says **not counted**
beside its title, and so does any row in it that is failing. The Network tab's summary
names such a failure as not counted, rather than as something being re-checked.

**A check target that has gone is not an outage.** The accounts the AppViews are asked
about belong to other people, and when one is deleted, deactivated or suspended every
AppView says so at once — which used to read as every AppView partly failing at once. Now
the AppViews compare notes in each sweep. When at least two say plainly that an account
is not there (a 4xx about it, never a timeout or a 5xx) and none says it is, its lookups
are shown with their failure and a line saying why they are not held against anybody, and
left out of each row's verdict. A handle the account no longer uses is caught the same
way, and only that lookup excused. Settings marks the account as gone beside it, and the
Network tab says so above the panels, with a link that opens the account list in
Settings, until it is replaced. `api.bsky.app` and
`public.api.bsky.app` are one index under two names, so they count as one witness, and W
Social's AppView, which leaves most accounts out by design, has no say in what is missing.
One AppView on its own — a re-check — never concludes anything new, and what an earlier
comparison concluded stands until an AppView has the account again. When every listed
account has gone, the newest-post comparison is excused too.

**A service is slow for itself.** The page calls a service slow when something takes
fifteen seconds, which against a thirty-second timeout almost never happens: a relay that
answers in 300 ms and starts taking 4 s is something people feel, and fifteen seconds
never sees it. So each service is also compared with its own recent history. Once it has
answered six times, a sweep whose median latency is four times its usual one, and at least
two seconds, reads as slow, and the row says on hover what it usually takes. Slow is still
answering: it colours the dashboard and the uptime strip, and files nothing. When the
whole machine's connection is slow, the Internet control rows turn slow along with
everything else, which is the tell.

**The dashboard shows the same rows every sweep.** Bluesky's PDS fleet is eighty-nine
hosts and growing. Rather than rank that list and probe whoever is on top, the catalogue
names a fixed sample, which is what lets an uptime strip mean something: it always
measures the same service. The PDSes you add yourself are fixed in the same way, for as long
as you list them.

**The machine itself gets a say in the schedule.** A sweep is defensible every ten minutes
on a desk and indefensible on a laptop at 9%, so the OS is asked rather than assumed. On
battery, scheduled sweeps take a floor of thirty minutes — a floor rather than a
multiplier, and deliberately: the interval you chose is a preference about how current you
want the dashboard, not a promise about how much battery the app may spend, and
multiplying would punish the considerate, turning somebody's hourly sweeps into
three-hourly ones while leaving the eager where they were. Under thermal pressure, or with
the CPU ceiling cut below half, scheduled sweeps stand aside entirely — which is a
correctness argument before it is a polite one, since latency measured through a machine
that is being throttled reads as latency the services do not have, and measuring honestly
is the whole of what this tab claims to do. Both schedules go down with the lid and come
back with it. And a dashboard older than the setting says why, in the tray tooltip and in
the header, because a sweep that never ran is otherwise indistinguishable from the app
being broken.

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

A sweep is about two hundred and fifty small requests and fourteen brief stream
connections, across fifty-odd services. No more than sixteen services are in flight at
once — the cost of that ceiling is wall clock in the worst case, and what it buys is not
opening a couple of hundred sockets in the same instant, which is hard on a laptop and
rude to the small operators on the other end; one of the indexes here runs on a Raspberry
Pi in its author's house. It runs every ten minutes by default (2 minutes to an hour,
under Settings); when the machine wakes or the screen unlocks, if the last sweep is more
than five minutes old (or older than the interval, if that is shorter) — on battery not
until the battery's own interval has passed, and never under thermal pressure; and when
the popover is opened on a dashboard older than two minutes.

## Ways in and out

The tray icon is not the only way into the app, and a notification is not the only way
out of it. Everything here is a route a native app of this shape has and this one did
not.

### The banner can finish the job

An OS notification carries two buttons rather than being a thing you can only click or
ignore: **Mark as read**, which deals with the update and opens nothing at all, and
**Show on dashboard**, which is offered for the entries the network checks filed and
takes you to that service's row. Clicking the banner itself still opens the status page
behind the update, as it always did.

On macOS, `NSUserNotificationAlertStyle: 'alert'` in `forge.config.ts` is what makes the
buttons visible outright rather than hidden under a hover-revealed chevron. A development
run uses Electron.app's own Info.plist, which does not set it, so there they sit behind
the chevron.

The one summary banner raised for everything that happened while nobody was at the
machine carries no buttons, deliberately: its body is a count and a list of sources, so
_Mark as read_ there would be answering for updates it has shown nobody.

On Windows, the checks' own entries take one Action Center slot per service rather than
one per transition — a relay that flaps nine times in an afternoon leaves nine rows, and
eight of them are already wrong. The banner carries the service id as the toast's `Tag`
and a shared `Group`, and Windows replaces rather than stacks a toast whose pair matches
one already showing. A status page posting _investigating_, then _identified_, then
_resolved_ is telling a story, so those are left to stack.

### `statusky://` deep links

Statusky registers an OS-level URL scheme. Opening one of these — from a browser, a
script, `open` on macOS, `xdg-open` on Linux — brings the popover up on what it names:

| Link                                     | What it opens                             |
| ---------------------------------------- | ----------------------------------------- |
| `statusky://open`, or bare `statusky://` | The popover, wherever it was left         |
| `statusky://timeline`                    | The Timeline, the tab that catches you up |
| `statusky://network`                     | The network dashboard                     |
| `statusky://service/<id>`                | The dashboard, scrolled to one service    |

`<id>` is a probe id — `relay:bsky.network`, `entryway:bsky.social`, `appview:api.bsky.app` —
and is checked against the services this build actually measures before it reaches the
popover; an unknown one opens the dashboard itself.

**`statusky://` is not `app://statusky`.** The similarity of the names is the one thing
to be careful about here. `app://statusky` is the private scheme the popover's own page
is served from, and `origin is "app://statusky"` in `schemas/statusky.eipc` is what tells
the IPC layer that a call came from our own UI. A `statusky://` link is the opposite: it
is an external, untrusted string that anything on the machine can hand to the OS. Nothing
arriving through it is ever loaded, navigated to, or forwarded to the renderer as a URL —
it is parsed into one of the four intentions above and nothing else crosses. See
`src/main/deep-link.ts`.

Registration differs per platform, which is why it appears in three places:
`packagerConfig.protocols` writes the macOS `Info.plist` entry Launch Services reads;
`MimeType=x-scheme-handler/statusky` in the `.desktop` file is what `xdg-open` uses; and
on Windows the running app claims the scheme itself on every launch, because Forge writes
no registry entries and a Squirrel installer has nowhere to put them. That last call
passes a trailing `--`, which is the documented mitigation for the Electron
protocol-handler command-line injection class of bug (CVE-2018-1000006 and its bypass):
Windows appends the clicked URL to the registered command line verbatim, and without a
terminator a crafted link is read as Chromium switches rather than as a URL.

### Dragging a handle onto the icon

Select `status.blacksky.community` in a browser and drag it to the menu bar icon. A `+`
appears beside the icon while the text is over it, and letting go watches that source —
the same three things the Accounts panel accepts (a handle, a DID, a `bsky.app` profile
link), parsed by the same code. The popover opens on success; a drop that cannot be
resolved says why in a dialog rather than doing nothing, which would be
indistinguishable from the feature not existing. macOS only: `drop-text` is not emitted
anywhere else.

### Right-click in the popover

Every update has a context menu, built in the main process with `Menu.buildFromTemplate`
rather than drawn in HTML: **Copy link**, **Open in browser**, **Show on the network
dashboard** for a measured entry, **Mark as read**, **Mark this and everything older as
read**, **Mute <source>**, and — on macOS — **Share…**, which opens the system share
sheet with the incident's text and link in it, so "the relay is down, here" is one
gesture rather than copy, switch app, paste.

The page sends the update's URI and nothing else; every label is built from the state the
main process already holds. The popover is pinned open for as long as the menu (or the
share sheet opened from it) is up, because it otherwise hides the moment it loses focus.

### Links go to the browser, and only web links go anywhere

Whatever opens a link — a click or middle-click in a post, **Open in browser**, a clicked
banner, or the popover itself trying to open a window or navigate — ends at one check in
`src/main/external.ts`: `http` and `https` are handed to your browser, and nothing else is
handed to the OS at all. `shell.openExternal` is the system's "open this with whatever
handles it", and a `file:`, `smb:` or `search-ms:` link, or any installed app's own scheme,
would otherwise be one click away in a post written by somebody you do not know. A link
in a post that is not a web link is shown as plain text from the moment the post is read.

### A shortcut that summons the popover

Under Settings › Menu bar, and **off by default** — a global shortcut is taken from every
other application on the machine for as long as this one runs. The combinations offered
are written the way the platform writes them (`⌘⇧S` on macOS, `Ctrl+Shift+S` elsewhere).
Pressing it opens the popover from whatever you are in; pressing it again puts it away.

A global shortcut belongs to whichever application asked for it first, and losing that
race is otherwise completely silent — the key simply does somebody else's thing. When the
OS refuses the registration, the panel says so underneath the control, the same way a
refused login item does.

### The menu bar icon on Linux

On macOS and Windows the icon is a toggle — click for the popover, right-click for the
menu — and on most Linux desktops neither of those is guaranteed to happen. GNOME through
the AppIndicator extension, KDE natively and most of the rest now speak
StatusNotifierItem rather than the old XEmbed tray, and under it a left click is never
delivered to the application at all; an item that has never set a menu through
`setContextMenu` may show nothing on right-click either, because the host asks the item
for its menu rather than waiting to be told to pop one up. Between the two, the app can
end up in the menu bar with no way in. So on Linux the menu is attached to the icon, which
makes **Open Statusky** always reachable — the one thing that must never stop working. It
is deliberately not done on macOS, where attaching a menu replaces the left-click toggle
that is this app's entire interaction. The click handlers stay registered on Linux
regardless, because a session still running an XEmbed tray does deliver them.

### The application menu

Statusky is `LSUIElement`, so it draws no menu bar of its own. That never meant it had no
menu: nothing was calling `Menu.setApplicationMenu`, so Electron installed its own default
one — and a menu does not have to be drawn for its key equivalents to fire. That default
claims `Cmd+R` for View → Reload, which was silently eating the popover's own `Cmd+R`:
refresh the feed, or run the network checks when the Network tab is showing. Owning the
menu is how that key comes back.

What is left in it is small on purpose: the app roles, and an Edit submenu that is
load-bearing rather than decorative, because on macOS the editing key equivalents live in
the menu and nowhere else. Without it `Cmd+V` does nothing at all, and the Add-account
field exists to have a handle pasted into it. A frameless, always-on-top popover has no
business being minimised, zoomed, closed or taken fullscreen, so none of those entries
exist to be triggered by accident. Windows and Linux get no application menu whatsoever,
since there it would be drawn _inside_ the window and a frameless popover must not
suddenly grow a menu bar — and nothing is lost, because Chromium handles the editing keys
in the renderer on those platforms anyway.

### Opening at login

Off by default, under Settings › Application. A status monitor that does not come back
after a reboot has failed at the one thing it is for, and it fails silently: there is no
moment at which you find out, because the app that would have told you is the one that did
not start. So nothing here reports success merely because a call returned.

On macOS and Windows `app.setLoginItemSettings` is the documented path, and the setting is
read straight back out of the OS afterwards. Since macOS 13 this goes through
`SMAppService`, which registers a _bundle_ and refuses one that is not properly code
signed or is not in the Applications folder — and refuses it quietly. The call returns,
nothing throws, and only reading it back reveals that nothing was registered.

On Linux that API is documented `darwin,win32` and does nothing at all, which is why the
toggle used to report success for something that was never going to happen. Statusky
writes an XDG autostart entry into `~/.config/autostart`, or wherever `$XDG_CONFIG_HOME`
points, instead. It names the AppImage through `$APPIMAGE` — the path you actually
launched, since an AppImage runs from a mount that is gone by the next login — or an
installed build through an absolute `execPath`. A source checkout cannot honestly name a
command for the session to run, and says so rather than guessing at one.

Whichever of them refuses, the toggle goes on showing what you asked for — that is your
intention and it stays yours — and a line underneath says what the machine did about it,
which is the same arrangement a refused global shortcut gets.

## Staying up to date

A menu bar app with no window and no dock icon, whose whole design goal is being forgotten
about until something breaks, is the worst possible candidate for updates you are expected
to go and fetch. Nobody opens it. Nobody has a reason to wonder what version it is. And it
is the app whose job is telling you the network broke, so a build left behind long enough
stops being able to answer that question at all: the catalogue of measured services, the
requests each is measured with and the status accounts being watched all move. A stale
probe catalogue is a correctness problem wearing a staleness problem's clothes.

There are two mechanisms, and exactly one of them is ever running.

**macOS and Windows update themselves.** `update-electron-app` points Electron's
`autoUpdater` at `update.electronjs.org`, which serves a Squirrel feed straight from this
repository's GitHub releases — it is public, so there is no server to run and no
credentials involved. The download happens in the background, and the restart is offered
in the menu bar as **Restart to update**. A menu entry rather than the package's own
default, which is a modal dialog: this app has no parent window to put one on, so a
message box here runs application-modal over whatever you were actually doing, to say
something that could not be less urgent. The menu entry waits as long as you like.

macOS takes the update from the `.zip` and never from the `.dmg` — Squirrel.Mac reads the
zip, which is why `maker-zip` is in the matrix at all — and **it only works on a properly
signed build**. Squirrel.Mac refuses to apply an update whose code signature does not
match the running application, so the ad-hoc signed build a certificate-less checkout
produces can fetch an update and then decline to install it, every time.

**Everywhere else is told, and nothing more.** Linux never self-updates: Electron's
`autoUpdater` is a wrapper around Squirrel.Mac and Squirrel.Windows and there is no third
implementation, so `update-electron-app` no-ops there by design. Those installs — and any
macOS or Windows one Squirrel turns out not to be able to help — ask GitHub's API what the
newest release is instead, at launch and every six hours after, and compare its tag with
this build's version.

**The switch between the two is not a guess** about whether this build is signed, or
installed the way Squirrel expects. It is Squirrel saying so: the self-updater is started,
and the first time it reports an error — a signature mismatch, a missing `Update.exe`, an
unreachable feed — the release check takes over and starts saying what the app cannot do
for you.

Four things about that check are deliberate:

- **It goes through `net.fetch`**, not Node's, so it takes the system proxy and the system
  certificate store with it. Same reason the network checks do, and on a corporate laptop
  it is the difference between a request that works and one that fails somewhere nobody
  will ever look.
- **It is slow on purpose.** Unauthenticated GitHub API calls are capped at 60 an hour for
  the whole IP address, shared with everything else on it. Four requests a day is a
  reasonable neighbour on a shared connection, and this app ships occasionally — checking
  more often than it ships only finds out the same thing more times. One check is
  abandoned after fifteen seconds, so a stalled request cannot pile up behind the next.
- **Anything that goes wrong is silence.** Rate limited, no releases published yet, a body
  that is not JSON, a tag that is not a version, a connection that never completes: none
  of those are evidence about what version is current, and reporting a state we do not
  know is the one thing worth avoiding. A wrong "you are out of date" sends somebody to a
  download page to look for a build that is not there.
- **The comparison is a few lines rather than a dependency**, and it is written down where
  those lines stop. They handle a `v` prefix, a dotted run of numbers compared as numbers,
  a missing component as zero, and a pre-release suffix that correctly precedes the
  release it led up to. They do not understand build metadata after a `+`, they order two
  pre-releases as plain text, and a tag that does not begin with digits is passed over
  entirely.

**It surfaces in the menu bar and in Settings, and never as a notification.** Every banner
this app raises means _the Atmosphere is broken_. Spend that channel on a version number
and you have taught people that the thing which pages them is sometimes routine, and that
is the one channel here worth protecting.

**The wording is careful about what it is asking for.** These builds are a dmg, a zip, a
Squirrel installer, a `.deb` and an AppImage from a download page — none of them served
from a package repository. There is no `apt upgrade` that will do this, so the panel says
to download the new one and replace this copy, because that is the only true instruction
available. Nothing here downloads or installs anything on Linux; an AppImage that updates
itself is possible and is not done, because it would need releases to be signed and they
are not yet.

## What does not work where

Everything above argues its own case. This is the index.

| Thing                                    | Where it does not work                                                                                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-update                              | Never on Linux: Electron's `autoUpdater` is Squirrel, and there is no Linux Squirrel. Never on an ad-hoc signed macOS build either, since Squirrel.Mac needs the update's signature to match the running app. Both get a notice instead. |
| Notifications in development             | Development runs on macOS, until allowed: they are listed under System Settings › Notifications as Electron, not Statusky.                                                                                                               |
| A count beside the menu bar icon         | macOS only. `Tray.setTitle` does nothing elsewhere, so the setting badges the icon there instead.                                                                                                                                        |
| The beating icon                         | Stands down to the badge wherever the OS has been asked for reduced motion.                                                                                                                                                              |
| Dragging a handle onto the icon          | macOS only. Electron emits `drop-text` nowhere else.                                                                                                                                                                                     |
| The share sheet                          | macOS only. The rest of the right-click menu works everywhere.                                                                                                                                                                           |
| The application menu                     | macOS only, deliberately: elsewhere it would draw a menu bar inside a frameless popover.                                                                                                                                                 |
| Clicking the tray icon                   | Not delivered at all on StatusNotifierItem desktops, which is most of Linux now — hence the menu attached to the icon there.                                                                                                             |
| A setup wizard, or a chosen install path | Squirrel.Windows has neither. The installer is one-click and always installs to `%LOCALAPPDATA%`.                                                                                                                                        |
| Launch at login                          | Needs a packaged build on every platform. A source checkout cannot name a command for the session to run, and says so rather than guessing.                                                                                              |
| A signed Linux package                   | The `.deb` and the AppImage are not signed.                                                                                                                                                                                              |

## Running it

```bash
npm install && npm run dev
```

Node 22.22.2+, 24.15+ or 26+ is required — the narrowest range any of the tooling
declares, which is jsdom's, and the one `engines` in `package.json` repeats. Odd-numbered
releases in between are outside it. `.tool-versions` pins 24.18.0, and CI runs that.
If Electron's binary did not download during install, run
`node node_modules/electron/install.js`.

On macOS the first notification asks for permission as **Electron**, not Statusky: a
development run is `node_modules/electron/dist/Electron.app`, and allowing Statusky in
System Settings allows only a packaged build. `npm run dev` also ad-hoc signs that
Electron.app on the way in (`scripts/seal-dev-electron.mjs`). As npm installs it, the
bundle is only linker-signed, with no seal binding its Info.plist, and
`usernotificationsd` refuses every request from it — `UNErrorDomain error 1` — before
any permission prompt, whatever System Settings says.

## Building a distributable

```bash
npm run dist:mac
```

`dist:win` and `dist:linux` are also available, and `npm run dist` builds for whatever
platform you are on. Output lands in `release/`: the app bundle under
`release/Statusky-<platform>-<arch>/`, the installers under `release/make/`. Each of
these runs `npm run build` first, which regenerates production IPC wiring, type-checks,
lints, checks formatting and runs the whole test suite before it rebuilds `out/`. A
release is the one build that leaves your machine and nothing reviews it on the way out,
so none of that is skippable from a script: `src/test/scripts.test.ts` fails any script
that reaches `electron-forge package`, `make` or `release` without svelte-check, tsc,
oxlint, `prettier --check` and an unfiltered `vitest run` all passing earlier in the same
run. The same checks run in CI (`.github/workflows/ci.yml`) on every push to `main` and
every pull request.

`npm run package` stops at the app bundle and makes no installers. `npm run release`
makes them and uploads them to a **draft** GitHub release, so a mistaken release is
retractable rather than already downloaded. A draft is also invisible to
`update.electronjs.org` and to the release check, both of which ask only for the latest
_published_ release — so nothing in the field updates itself, or is told to, until the
release is deliberately published. See [Staying up to date](#staying-up-to-date).

Packaging is Electron Forge; building is still electron-vite. Forge compiles nothing
here — it packs `out/` exactly as `npm run build` left it, signs it, and turns it into
installers. Configuration lives in `forge.config.ts` (the name matters — that is what
Forge discovers), and `electron.vite.config.ts` is untouched by any of it. Before the
bundle is sealed, a hook re-reads the copied `out/` and refuses to go on if it holds
development IPC wiring; see "Packaging refuses development wiring" below.

This is Forge 8, which is ESM throughout and needs Node 22.13 or newer — inside the
range above. It renamed `electron-forge publish` to `electron-forge release` (the old
name still works, with a deprecation warning, and is why the npm script is `release`
too), renamed `make --skip-package` to `make --from-package`, and writes each DMG to
`release/make/dmg/<arch>/`. Its config loader still reads `forge.config.ts` through jiti,
so the file can use any TypeScript it likes. `@reforged/maker-appimage` is the one maker
that is not Forge's own, and it still declares Forge 7's `@electron-forge/maker-base` as
a dependency — which pulled a second, older and audit-failing Forge tree in beside this
one. The `overrides` entry in `package.json` hands it Forge 8's instead. What it takes
from the base class — its config, `ensureFile`, the external-binary check — is all still
there, and it loads and constructs under Forge 8, but no AppImage has been built with it
yet: that needs Linux.

`npm audit` has one advisory left, and it is not fixable from here. The DMG maker uses
`electron-installer-dmg`, which uses `appdmg`, which pins `image-size@^0.7` to read the
DMG's background picture, and image-size before 2.0.3 can be sent into an infinite loop
by a crafted ICNS file. The fixed 2.x line no longer reads a file path, which is all
appdmg ever hands it, so forcing it in would break every DMG. The input is the PNG that
ships inside `electron-installer-dmg` itself, read on the machine doing the build, so
nothing an attacker controls ever reaches the parser. `npm audit --omit=dev` is clean.

| Platform | Targets                                              |
| -------- | ---------------------------------------------------- |
| macOS    | `.dmg`, `.zip`                                       |
| Windows  | Squirrel.Windows (`Setup.exe`, `.nupkg`, `RELEASES`) |
| Linux    | `.deb`, `.AppImage`                                  |

Only the host architecture is built by default; pass `--arch` for the rest, as in
`npx electron-forge make --platform=darwin --arch=x64,arm64`. electron-builder used to
build both macOS architectures without being asked.

Each maker needs its own tools, and says so when they are missing:

| Maker            | Needs                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dmg              | `appdmg`, an optional dependency of `electron-installer-dmg` that compiles a native module — so macOS with the Xcode command line tools installed and their licence agreed to |
| Squirrel.Windows | Windows, or mono and wine elsewhere                                                                                                                                           |
| deb              | `dpkg` and `fakeroot`                                                                                                                                                         |
| AppImage         | `mksquashfs`, plus network access to fetch the AppImage runtime                                                                                                               |

### What the app is called

Two files decide, and they decide different things.

`forge.config.ts` sets `packagerConfig.name`, which names the bundle: `Statusky.app`, the
executable inside it, `CFBundleName`, `Statusky.exe`. `package.json` sets `productName`,
which is what Electron answers from `app.getName()` while the app is running, and which
the application menu, the About panel and `app.getPath('userData')` are built out of.
Electron prefers `productName` over the lowercase `name` beside it, and falls back to
that `name` when there is no `productName` — which is how a bundle called Statusky came
to label its own menu `statusky` and write `~/Library/Application Support/statusky`. The
two are held together by a test in `src/test/packaging.test.ts`, along with the third
copy of the name in `src/main/login-item.ts`.

A development run is still called Electron, and nothing in this repository can change
that: `npm run dev` runs `node_modules/electron/dist/Electron.app`, and the bundle's own
name is what macOS shows for anything it registers — notifications, and the login item
above all. That last one used to be registered anyway, which produced a real "Electron
will open automatically when you log in" entry pointing inside `node_modules`; the login
item now declines a source checkout on macOS and Windows as it always has on Linux. See
[What does not work where](#what-does-not-work-where).

### What the move off electron-builder cost

Two NSIS options have no Squirrel.Windows equivalent and are simply gone: the installer
is one-click, and it always installs to `%LOCALAPPDATA%`. The old config asked for the
opposite of both; nothing here pretends it still does.

The third — `createDesktopShortcut: false` — is honoured after all, but not by
configuration: `MakerSquirrel` has no shortcut options at all. Squirrel installs by
running the application itself with `--squirrel-install`, `--squirrel-updated`,
`--squirrel-uninstall` or `--squirrel-obsolete`, and `src/main/squirrel.ts` answers those
by asking Squirrel's `Update.exe` for a Start Menu shortcut and only a Start Menu
shortcut, then quitting before anything reaches the menu bar. That shortcut is not
optional in the other direction: Windows refuses to show a toast from an application that
has no Start Menu shortcut carrying its AppUserModelID, so it is the prerequisite for
every notification the app raises there. It is hand-rolled rather than taken from
`electron-squirrel-startup`, which is two years stale, CommonJS inside an ESM package,
and pulls in `debug@^2` from 2016.

The `.desktop` entry's `StartupNotify=false` did survive, but only by vendoring
`electron-installer-debian`'s template into `build/desktop.ejs` — `maker-deb` has no
per-key override of the desktop entry. That copy has to be re-checked against upstream
whenever the dependency moves.

The app icon had to be rebuilt. electron-builder rendered `.icns` and `.ico` from
`build/icon.png`; `@electron/packager` only swaps the extension on the path it is given
and converts nothing, so a build found neither file, warned, and shipped Electron's own
icon. `scripts/gen-icons.mjs` now writes both containers itself — it already has the
icon as pixels, and an `.icns` and an `.ico` are each little more than an index in front
of PNG data. Nothing shells out to `iconutil`, so `npm run icons` still runs on Linux
and Windows CI. The Linux makers take the PNG and were never affected.

Note that `@electron/packager` copies the `.icns` over the bundle's existing
`Contents/Resources/electron.icns` rather than renaming it — that name is
`CFBundleIconFile` and packager never rewrites it, so the stock filename with our bytes
inside it is the expected result, not a sign the icon was ignored.

`resources/` is also packaged under its own name now rather than as `assets/`, because
`@electron/packager` copies each extra resource to its basename and offers no way to
rename it. `src/main/tray.ts` looks for it there; the two have to agree or the menu bar
comes up empty.

### Code signing

Signing is decided at build time in `forge.config.ts`, so a checkout with no
certificates still builds.

**macOS.** With no certificate available the build signs itself ad-hoc, the way
electron-builder's `identity: '-'` did. `@electron/osx-sign` documents no ad-hoc mode,
but that same `-` with `identityValidation: false` skips the keychain lookup and reaches
`codesign --sign` unchanged. An ad-hoc signature is not enough for Gatekeeper on another
machine, and not enough for macOS to grant notification permission — which is why
notifications are refused in local builds — but it is a valid seal, and that turns out
to matter.

It is tempting to leave `osxSign` off entirely instead and let something later in the
pipeline seal the bundle. Nothing does, and anything that tried would be signing too
early: `@electron/packager` renames the bundle and writes `ElectronAsarIntegrity` into
`Info.plist` near the end of packaging, and a signature applied before that comes out
stale — a bundle reporting `Identifier=com.github.Electron` and `Info.plist=not bound`,
failing `codesign --verify --strict` with
`invalid Info.plist (plist or signature have been modified)`.

Which would break more than appearances. macOS refuses Keychain access to a bundle whose
signature does not verify, so `safeStorage.isEncryptionAvailable()` was false in every
locally packaged build, and `src/main/store.ts` took its documented fallback of writing
the webhook endpoint secret to `statusky.json` in the clear. packager runs `osxSign`
last, after every rewrite it makes, so signing from `forge.config.ts` is the placement
that survives packaging — and the secret is sealed in a local build again.

One consequence to expect: the Keychain item Chromium creates for `safeStorage` is
bound to the signature that created it, and an ad-hoc signature changes with every
build. macOS therefore asks for permission the first time each freshly packaged build
reads it. A Developer ID build has a stable identity and does not.

That prompt is why `EnableCookieEncryption` must stay off — see "Electron fuses" below.

With a Developer ID Application certificate the build signs and notarizes instead. The
certificate has to already be in a keychain:

| Variable                                                | Purpose                                              |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                          | taken only as "a signed build is wanted" — see below |
| `CSC_NAME` or `CSC_IDENTITY`                            | sign with this identity instead of searching         |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect key used to notarize               |
| `APPLE_TEAM_ID`                                         | pins the designated requirement to the team          |

electron-builder imported `CSC_LINK` into a throwaway keychain itself. Nothing in the
Forge stack does, and there is no equivalent to reach for, so a release job has to import
the certificate before the build — `apple-actions/import-codesign-certs`, or a `security
import` into a keychain of its own. There is no such job yet: `.github/workflows/ci.yml`
checks and tests, and packages nothing. `CSC_LINK` is still read, but only as a statement of
intent: if the keychain has not been prepared, signing fails loudly rather than quietly
producing an ad-hoc build and calling it a release.

`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` notarizes too, as does
`APPLE_KEYCHAIN` + `APPLE_KEYCHAIN_PROFILE`, but an API key is preferred.

Entitlements are chosen by how the build is signed, not by which file is being signed,
and every one of them is an exception to the hardened runtime — one more thing a signed
process will put up with. So there are as few as the build can start with:

| File                                 | Signed             | Grants                                    |
| ------------------------------------ | ------------------ | ----------------------------------------- |
| `build/entitlements.mac.plist`       | Developer ID       | `allow-jit`                               |
| `build/entitlements.mac.adhoc.plist` | ad hoc, no Team ID | `allow-jit`, `disable-library-validation` |

`allow-jit` is what V8 needs to compile JavaScript as it runs, in the app and in every
helper, and it is the only exception Electron asks for — `@electron/osx-sign`'s own
default entitlements are the same. The electron-builder-era files also granted unsigned
executable memory, which V8 has not needed since `allow-jit` existed;
`allow-dyld-environment-variables` on the helpers, which let anything that could set the
process's environment load its own code into them through `DYLD_INSERT_LIBRARIES`; and
`disable-library-validation` everywhere.

That last one survives in exactly one place. Library validation admits a library signed
by Apple or by the process's own Team ID, and an ad-hoc signature has no Team ID — so
under the hardened runtime dyld refuses to map Electron Framework into an ad-hoc build
("mapped file has no Team ID and is not a platform binary") and the app dies before it
reaches the menu bar. A local build keeps the exception so that it starts at all; a
Developer ID build, whose every binary carries the same Team ID, never has it.

Check what a build actually produced with:

```bash
codesign -dv --verbose=4 release/Statusky-darwin-arm64/Statusky.app
```

A local build should report `flags=0x10002(adhoc,runtime)` and the bundle's own
`Identifier=community.statusky.app`, and pass:

```bash
codesign --verify --deep --strict release/Statusky-darwin-arm64/Statusky.app
```

**Windows.** Signing goes through Azure Trusted Signing when all five of
`AZURE_CODE_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT_NAME`,
`AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_CODE_SIGNING_DLIB` and
`WINDOWS_SIGNTOOL_PATH` are set; setting only some of them is an error rather than a
silently unsigned build.

The last two are new, and they are the price of Forge reaching `@electron/windows-sign`
1.x instead of electron-builder's own Trusted Signing module. windows-sign only knows how
to drive `signtool.exe`, and the copy vendored inside it predates `/dlib` — so point
`WINDOWS_SIGNTOOL_PATH` at one from Windows SDK 10.0.22621.755 or newer, and
`AZURE_CODE_SIGNING_DLIB` at `Azure.CodeSigning.Dlib.dll` from the
`Microsoft.Trusted.Signing.Client` NuGet package. There is no `publisherName` any more,
so `AZURE_CODE_SIGNING_PUBLISHER_NAME` is no longer read.

Authentication is separate, and unchanged: the dlib reads an Entra ID service principal
from `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. Signing runs
`signtool.exe`, so it only works on a Windows runner.

**Linux.** AppImage and deb are not signed.

### Electron fuses

A fuse is a byte in the Electron binary that switches a feature off before any of the
app's own code runs, so it holds against things that code never gets the chance to
refuse. Electron ships them set for compatibility, and `forge.config.ts` flips them on
every packaged build:

| Fuse                                    | Electron 44 ships | Statusky ships        |
| --------------------------------------- | ----------------- | --------------------- |
| `RunAsNode`                             | on                | **off**               |
| `EnableCookieEncryption`                | off               | off                   |
| `EnableNodeOptionsEnvironmentVariable`  | on                | **off**               |
| `EnableNodeCliInspectArguments`         | on                | **off**               |
| `EnableEmbeddedAsarIntegrityValidation` | off               | **on** (off on Linux) |
| `OnlyLoadAppFromAsar`                   | off               | **on**                |
| `LoadBrowserProcessSpecificV8Snapshot`  | off               | off                   |
| `GrantFileProtocolExtraPrivileges`      | on                | **off**               |
| `WasmTrapHandlers`                      | on                | on                    |

**What the defaults would cost.** With `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`
and `EnableNodeCliInspectArguments` on, anyone who can set environment variables for the
process — `ELECTRON_RUN_AS_NODE=1`, `NODE_OPTIONS=--require …`, or `--inspect` and a
debugger — can run arbitrary code inside a bundle macOS has already identified as
Statusky, including code that asks `safeStorage` to hand back the webhook secret.
`GrantFileProtocolExtraPrivileges` gives `file://` pages powers no browser gives them,
and the popover is never a `file://` page — it is served over `app://statusky` — so those
powers could only ever help somebody else's. Nothing in the app needs any of the four: it
forks no Node child, reads no `NODE_OPTIONS`, and reaches its own renderer bundle with
`net.fetch(pathToFileURL(…))` inside `protocol.handle`, which is Electron's own recipe
for serving files once that last fuse is off. A development run is untouched: it runs the
Electron in `node_modules`, and only the copy packager unzips is flipped.

**The two that are switched on** work as a pair. `OnlyLoadAppFromAsar` makes `app.asar`
the only app Electron will run, and `EnableEmbeddedAsarIntegrityValidation` checks that
asar's header at boot against the hash packager records — `ElectronAsarIntegrity` in
`Info.plist` on macOS, a resource in the executable on Windows — so an edited `app.asar`
stops the app starting instead of running. The code signature already seals the asar on
macOS; this is the second, Electron-level check, and it still holds after something has
been let past Gatekeeper. Electron only validates on macOS and Windows, and packager
records no hash for Linux, so on Linux the fuse is left off rather than trusted to do
nothing.

**When they are flipped.** Rewriting bytes in the binary invalidates the code signature
it shipped with, and Apple silicon will not run a binary whose signature does not verify.
`@electron-forge/plugin-fuses` deals with that by re-signing ad hoc in `packageAfterCopy`
— in the middle of packaging, before `@electron/packager` renames the bundle and writes
`ElectronAsarIntegrity` into `Info.plist` — which is how a build ends up reporting
`Info.plist=not bound` and losing the Keychain access that keeps the webhook secret
sealed. So the plugin is not used. `forge.config.ts` flips the wire itself in
`packageAfterExtract`, on the Electron packager has only just unzipped, before anything
of packager's has happened to it, and re-signs nothing: `osxSign` runs last of all and
replaces every signature in the bundle, so the stale one never leaves the build, and
`codesign --verify --strict --deep` passes as it did before. The one place that cannot
work is packaging for macOS from Linux or Windows, where there is no `codesign` to sign
with afterwards; the hook refuses that outright rather than produce a bundle that cannot
start.

**`EnableCookieEncryption` stays off**, and is written into the config as off rather
than inherited, because it is the one that has actually cost this project something.
With it on, Chromium will not open the cookie store until the browser process has
fetched a Safe Storage key from the Keychain, and it will not send anything that consults
a cookie until the store is open. A menu bar app has no window for a modal SecurityAgent
prompt to belong to, and an ad-hoc signature changes with every package, so the prompt is
raised, never answered, and the wait has no timeout. Measured on one packaged build with
the fuse on: 171 of 181 checks passed and all ten stream checks timed out, because a
WebSocket handshake reads cookies before it sends and the HTTP checks send
`credentials: 'omit'`. With the fuse off, 181 of 181.

**`WasmTrapHandlers` stays on.** It lets V8 bounds-check WebAssembly memory with guard
pages and a signal handler instead of a comparison on every access. Nothing here runs
untrusted WebAssembly, and turning it off would only make whatever WebAssembly Chromium
runs slower.

**Every fuse is decided.** The config sets all nine and passes `@electron/fuses` its
`strictlyRequireAllFuses` flag, so the day an Electron upgrade adds a tenth, packaging
stops and names it rather than shipping whatever default Electron picked.
`src/test/packaging.test.ts` holds all of this in place: it checks the wire the config
asks for on every platform, runs the hook against a copy of the wire cut out of the
installed Electron and reads back what it wrote, hands it the same wire with a tenth fuse
added and checks that nothing is written, and checks that a macOS package is refused where
nothing will re-sign it.

To see what a packaged build actually carries:

```bash
npx @electron/fuses read --app release/Statusky-darwin-arm64/Statusky.app
```

## Development

| Command                 | Purpose                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `npm run dev`           | Electron + Vite with hot reload                                           |
| `npm test`              | Vitest suite: all three projects — `node`, `node-development`, `renderer` |
| `npm run test:node`     | Main process, preload bridge and shared logic, under both wiring branches |
| `npm run test:renderer` | Svelte components and renderer state only                                 |
| `npm run test:coverage` | Coverage, with a floor the suite must not fall below                      |
| `npm run check`         | `svelte-check` + `tsc` + `oxlint` + `prettier --check`                    |
| `npm run build`         | `check`, then `npm test`, then `electron-vite build` into `out/`          |
| `npm run format`        | Prettier                                                                  |
| `npm run icons`         | Regenerate every icon from `scripts/gen-icons.mjs`                        |
| `npm run fixture`       | Re-snapshot live status posts into the UI preview fixture, then format it |
| `npm run generate:ipc`  | Regenerate `src/ipc/` from `schemas/statusky.eipc`                        |

`generate:ipc` runs automatically before `dev`, `start`, `build`, `check` and every test script, so you
should never need it by hand. It matters that it does: which branch of the origin
validator gets compiled in is decided at generation time, not at runtime.

`ELECTRON_RENDERER_URL`, which electron-vite sets to point the popover at its dev server,
is honoured only by an unpackaged run: a packaged build always serves its own bundle over
`app://statusky`, whatever the environment says.

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
│   ├── probe-targets.ts  What the checks read (probeTargets.json), and a user's override of it
│   ├── expected-responses.ts  The exact words answers are held to (expectedResponses.json)
│   ├── cbor.ts       Just enough DAG-CBOR to read a relay's firehose frames
│   ├── types.ts      The structured-cloneable types that cross IPC
│   ├── schemas.ts    Those types as Zod schemas, for validating them at the boundary
│   └── bridge.ts     Reaching `window.statusky`, and reading errors back off it
├── main/       Electron main process: the only place that touches network or disk
│   ├── index.ts      The startup sequence, read top to bottom
│   ├── model.ts      Owns all state; polls, merges, decides what to notify about
│   ├── state.ts      Pure state transitions (dedupe, notification cursors, read cursors)
│   ├── store.ts      Persistence, config migration, and the sealed webhook secret
│   ├── ipc.ts        The behaviour behind each method the schema declares
│   ├── webhook.ts    The loopback HTTP receiver for pushed updates
│   ├── probes.ts     The requests each kind of service is measured with
│   ├── network.ts    Sweeping, debouncing failures, and noticing being offline
│   ├── notifications.ts  Banners, their buttons, and the waiting room in front of them
│   ├── power.ts      What the OS says about the machine, and what to do about it
│   ├── tray.ts       Tray icon, tooltip and menu
│   ├── menu.ts       The application menu and the native About panel
│   ├── context-menu.ts   The right-click menu on an update, and the share sheet
│   ├── window.ts     The popover window
│   ├── position.ts   Where the popover goes relative to the tray icon
│   ├── protocol.ts   Serves the packaged renderer over app://statusky
│   ├── deep-link.ts  The statusky:// scheme, in both directions it arrives from
│   ├── shortcut.ts   The global shortcut, and reporting one the OS refused
│   ├── login-item.ts Opening at login, per platform, and reporting a refusal
│   ├── update.ts     Self-update where it works, and a notice where it cannot
│   ├── squirrel.ts   The four install-time launches Squirrel.Windows makes
│   └── packed-wiring.ts   Reads the IPC wiring out of a staged build, for packaging
├── preload/    The context-isolated bridge — three lines; the rest is generated
├── renderer/   Svelte 5 + shadcn-svelte UI
├── ipc/        Generated from schemas/statusky.eipc. Not checked in; do not edit
└── test/       The harness: doubles for Electron, the store, the AppView and the network
```

Three decisions shape everything else:

**All network and disk access lives in the main process.** The renderer runs sandboxed
with context isolation and no Node integration; it receives whole `AppState` snapshots
over IPC and sends back narrow, individually-typed requests. There is no generic
`invoke` escape hatch, and the renderer cannot drift from what is persisted: a request
main refuses is said beside the control that asked, and the control goes on showing what
main has. It is also
refused every permission Chromium can be asked for — camera, microphone, geolocation,
renderer-side notifications — before the first page exists, because Chromium decides for
itself when nothing says otherwise, and the popover has no business asking for any of
them. Anything that reaches that handler is either a bug or a page that is not ours, which
is worth a line in the log and not worth a prompt.

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
incident" says more than a probe's. A claim only counts while it is current, though:
the header reports what Statusky knows, and what somebody posted three days ago and
never mentioned again is attributed and dated rather than repeated as a fact. Both
processes build that line through one function, `reportHeadline`, because the popover
and the tray drawing different sentences from the same snapshot would be a bug. See
[Claims have an age](#claims-have-an-age).

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
- **Packaging refuses development wiring.** Forge's `packageAfterCopy` hook reads the
  compiled validator in the staged copy of `out/`, which is what actually gets packed
  and can be older than `src/ipc`. It stops unless it finds production wiring and
  nothing else. `electron-forge make --from-package` and `release --from-make` reuse an
  existing bundle without packaging, so they skip this check too — and the fuses with it,
  though the bundle they reuse had both when it was packaged.

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

CI (`.github/workflows/ci.yml`) runs `npm run check` and `npm test` on every push to
`main` and every pull request. It runs on macOS, because some tests still assume the
platform they were written on rather than pinning `process.platform` the way the tray's
Linux tests do — the menu bar count, which only exists on macOS, is one.

### The harness

`src/test/` stands in for the three things a test cannot have: Electron, a config file
on disk, and the network. Vitest aliases `electron`, `electron/renderer` and
`electron-store` to the doubles, so importing any main- or preload-process module
transparently gets them.

`update-electron-app` is aliased too, for a narrower and more annoying reason: the real
package is CommonJS inside `node_modules`, so Vitest loads it through Node rather than
through Vite, and its own `require('electron')` escapes that first alias and reaches the
real `electron` package — which outside an Electron process is a module exporting the path
to a binary. There is no way to hand it the doubles, so the package itself is the seam.
What is lost is the package's own feed-URL construction and option validation, none of
which is this app's to test; what is kept is the whole of the boundary `src/main/update.ts`
owns — whether it is called, on which platforms, with which options, and what it does when
the download it is waiting for finally lands.

| Module                   | Stands in for                                                                     |
| ------------------------ | --------------------------------------------------------------------------------- |
| `electron.ts`            | `app`, `ipcMain`/`ipcRenderer`, `BrowserWindow`, `Tray`, `Menu`, `protocol`, …    |
| `electron-renderer.ts`   | `webFrame`, so the preload can be asked whether it is a top-level frame           |
| `page.ts`                | `window.location`, so a test can serve the preload any origin it likes            |
| `electron-store.ts`      | The persisted config, in memory, copying on read and write like the real one      |
| `appview.ts`             | The public AppView: three XRPC methods, per-actor failures, hangs and rate limits |
| `bridge.ts`              | `window.statusky`, for component tests that do not need a main process            |
| `update-electron-app.ts` | The self-updater, so a finished download can be delivered on demand               |
| `factories.ts`           | Total builders for `Account`, `StatusPost`, `Settings`, `AppState`                |
| `harness.ts`             | All of the above, wired into a running app                                        |

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

Nothing else reaches a real socket, and `src/test/setup.ts` makes sure of it rather than
trusting every test to remember. It wraps the global `fetch` and `WebSocket` in ones that
refuse any http(s) or ws(s) address off the machine — loopback is let through, for the
webhook receiver — and fails the test that tried, in `afterEach`, even when the app code
under test caught the refusal and carried on. A test that wants the network has to install
the fake AppView or hand the code a transport; `src/test/closed-network.test.ts` pins the
guard itself.

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

MIT. See [`LICENSE`](LICENSE).
