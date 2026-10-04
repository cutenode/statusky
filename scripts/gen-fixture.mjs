#!/usr/bin/env node
/**
 * Snapshots live status posts into a fixture so `preview.html` can render the real
 * UI in a browser without booting Electron. Re-run whenever the shape of the data
 * you want to design against changes.
 *
 * It also runs one real network sweep — the app's own checks, through Node's `fetch`
 * and `WebSocket` rather than Chromium's — and writes the dashboard it produced to
 * `fixtures/network.json`. A single sweep has a single observation per service, so a
 * plausible history is grown behind it for the uptime strips to draw.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NetworkMonitor } from '../src/main/network'
import { fetchAuthorPosts, fetchProfiles } from '../src/shared/bsky'
import { BUILTIN_ACCOUNTS, DEFAULT_SETTINGS, DEFAULT_WEBHOOK_PORT } from '../src/shared/defaults'
import {
  HISTORY_LENGTH,
  SERVICES,
  probeAccount,
  probePost,
  summarizeNetwork
} from '../src/shared/network'
import { parseWebhookDelivery, webhookAccount } from '../src/shared/webhook'
/** @import { Account, AppState, ProbeCheck, ProbeSample } from '../src/shared/types' */

/**
 * A delivery in the shape status pages actually send, so the preview has a pushed
 * source to design against. There is nothing to snapshot from the network here: a
 * webhook only arrives when something is broken.
 */
const SAMPLE_DELIVERY = {
  page: { id: 'preview-page', url: 'https://status.bsky.app', status_description: 'Degraded' },
  incident: {
    id: 'inc-preview',
    name: 'Elevated error rates on the AppView',
    status: 'MONITORING',
    url: 'https://status.bsky.app/incidents/inc-preview',
    created_at: '2026-01-01T09:00:00.000Z',
    incident_updates: [
      {
        id: 'upd-3',
        status: 'MONITORING',
        created_at: '2026-01-01T10:05:00.000Z',
        body: '<p>The fix is deployed and error rates are back to baseline. We are continuing to monitor.</p>'
      },
      {
        id: 'upd-2',
        status: 'IDENTIFIED',
        created_at: '2026-01-01T09:30:00.000Z',
        body: '<p>A bad deploy to the read path is the root cause. See the <a href="https://bsky.app">app</a> for live status.</p>'
      },
      {
        id: 'upd-1',
        status: 'INVESTIGATING',
        created_at: '2026-01-01T09:00:00.000Z',
        body: '<p>We are investigating elevated error rates affecting timelines.</p>'
      }
    ]
  }
}

// Run from the project root; the script is bundled before execution, so it
// cannot rely on its own file location.
const root = process.cwd()

const profiles = await fetchProfiles(BUILTIN_ACCOUNTS.map((a) => a.did))
const addedAt = new Date().toISOString()
/** @type {Account[]} */
const accounts = []
for (const account of BUILTIN_ACCOUNTS) {
  const profile = profiles.find((p) => p.did === account.did)
  const entry = { ...account, addedAt }
  if (profile) {
    entry.avatar = profile.avatar
    entry.handle = profile.handle
    entry.displayName = profile.displayName
  }
  accounts.push(entry)
}

const delivery = parseWebhookDelivery(SAMPLE_DELIVERY, addedAt)
if (!delivery) throw new Error('SAMPLE_DELIVERY no longer parses as a webhook delivery.')
accounts.push(webhookAccount(delivery.source, addedAt))

// ------------------------------------------------------------ network sweep

const monitor = new NetworkMonitor({
  transport: {
    fetch: (url, init) => fetch(url, init),
    openSocket: (url) => new WebSocket(url)
  },
  onSnapshot: () => {},
  onSummaryChange: () => {},
  onEvents: () => {}
})
monitor.configure({ enabled: true, intervalSec: 3600 })
await monitor.run()
const network = monitor.snapshot()
monitor.stop()

/** A seeded generator, so re-running the script does not churn the whole history. */
let seed = 7
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

const sweepEvery = DEFAULT_SETTINGS.networkIntervalSec * 1000
if (network.finishedAt === null) throw new Error('The network sweep did not finish.')
const finished = Date.parse(network.finishedAt)
for (const service of network.services) {
  const base = service.latencyMs ?? 400
  /** @type {ProbeSample[]} */
  const earlier = Array.from({ length: HISTORY_LENGTH - 1 }, (_, index) => {
    const roll = random()
    const state = roll > 0.985 ? 'partial' : roll > 0.97 ? 'slow' : 'live'
    return {
      at: new Date(finished - (HISTORY_LENGTH - 1 - index) * sweepEvery).toISOString(),
      state,
      latencyMs: Math.round(base * (0.6 + random() * 0.9) * (state === 'slow' ? 4 : 1))
    }
  })
  service.history = [...earlier, ...service.history]
}

// Something for the feed to show from the checks' own source: a relay outage earlier today.
const relay = SERVICES.find((service) => service.id === 'relay:europe.firehose.network')
if (!relay) throw new Error('The sample outage names a relay that is no longer built in.')
const outageAt = new Date(finished - 3 * 3600_000).toISOString()
const recoveryAt = new Date(finished - 2.6 * 3600_000).toISOString()
/** @type {ProbeCheck[]} */
const failed = [
  {
    label: 'firehose',
    target: null,
    kind: 'stream',
    ok: false,
    error: 'Firehose connection closed (1006)',
    durationMs: 412
  },
  {
    label: '_health',
    target: null,
    kind: 'http',
    ok: false,
    error: 'Connection refused',
    durationMs: 88
  },
  {
    label: 'listHosts',
    target: null,
    kind: 'http',
    ok: false,
    error: 'Connection refused',
    durationMs: 91
  }
]
const probePosts = [
  probePost({ service: relay, from: 'up', to: 'down', at: outageAt, since: null, checks: failed }),
  probePost({ service: relay, from: 'down', to: 'up', at: recoveryAt, since: outageAt, checks: [] })
]
accounts.push(probeAccount(addedAt))

const posts = (
  await Promise.all(
    accounts.filter((a) => a.kind === 'atproto').map((a) => fetchAuthorPosts(a.did, 30))
  )
)
  .flat()
  .concat(delivery.posts, probePosts)
  .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

/** @type {AppState} */
const state = {
  accounts,
  posts,
  settings: { ...DEFAULT_SETTINGS, webhookEnabled: true },
  unread: posts.slice(0, 3).map((p) => p.uri),
  sync: { status: 'idle', lastSyncedAt: new Date().toISOString(), error: null },
  webhook: {
    state: 'listening',
    url: `http://127.0.0.1:${DEFAULT_WEBHOOK_PORT}/webhook/preview-secret-not-a-real-one`,
    port: DEFAULT_WEBHOOK_PORT,
    error: null,
    deliveries: 3,
    lastDeliveryAt: new Date().toISOString()
  },
  network: summarizeNetwork(network, true, DEFAULT_SETTINGS.countedProbeGroups),
  version: '0.1.0-preview',
  loginItem: { registered: false, error: null },
  shortcut: { registered: false, error: null },
  update: { stage: 'current', version: null }
}

const out = join(root, 'src/renderer/fixtures/state.json')
writeFileSync(out, JSON.stringify(state, null, 2))
console.log(`Wrote ${posts.length} posts from ${accounts.length} accounts to ${out}`)

const networkOut = join(root, 'src/renderer/fixtures/network.json')
writeFileSync(networkOut, JSON.stringify(network, null, 2))
const answering = network.services.filter((s) => s.state === 'live' || s.state === 'slow').length
console.log(`Wrote ${answering}/${network.services.length} answering services to ${networkOut}`)

// The sweep's sockets and timers are closed, but Node's fetch keeps idle connections
// alive for a while; there is nothing left to wait for.
process.exit(0)
