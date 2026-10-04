import { describe, expect, it } from 'vitest'
import { makeAccount, makePost, makeSettings } from '../test/factories'
import { PROBE_SOURCE_DID, SERVICES, isCore } from './network'
import { DEFAULT_PROBE_TARGETS } from './probe-targets'
import {
  applyFollowUps,
  bannerSound,
  formatClock,
  incidentKey,
  inQuietHours,
  NOTIFY_PRESETS,
  presetOf,
  quietHoursEnd,
  snoozedUntil,
  snoozeEnd,
  wantsBanner
} from './notify'
import type { Account, Severity, StatusPost } from './types'

const account = makeAccount()

function update(severity: Severity, overrides: Partial<StatusPost> = {}): StatusPost {
  return makePost({ authorDid: account.did, severity, ...overrides })
}

const CORE = SERVICES.find((service) => isCore(service))!
const COMMUNITY = SERVICES.find((service) => service.tier === 'community')!
const probe = makeAccount({ did: PROBE_SOURCE_DID, kind: 'probe' })

function measured(serviceId: string, severity: Severity, at = 1): StatusPost {
  return makePost({
    authorDid: PROBE_SOURCE_DID,
    uri: `${PROBE_SOURCE_DID}/${serviceId}/${at}`,
    severity
  })
}

describe('presets', () => {
  it('recognises each preset whatever order its stages are in', () => {
    for (const preset of NOTIFY_PRESETS) {
      expect(presetOf(preset.severities.toReversed())).toBe(preset.value)
    }
  })

  it('calls a hand-picked set of stages custom', () => {
    expect(presetOf(['outage', 'maintenance'])).toBeNull()
  })

  it('makes the default settings the incidents preset', () => {
    expect(presetOf(makeSettings().notifySeverities)).toBe('incidents')
  })
})

describe('wantsBanner', () => {
  it('follows the chosen stages', () => {
    const settings = makeSettings({ notifySeverities: ['outage'], notifyFollowUpsOnly: false })

    expect(wantsBanner(update('outage'), account, settings)).toBe(true)
    expect(wantsBanner(update('maintenance'), account, settings)).toBe(false)
    expect(wantsBanner(update('resolved'), account, settings)).toBe(false)
  })

  it('leaves follow-ups to applyFollowUps when they wait for their incident', () => {
    const settings = makeSettings({ notifySeverities: ['outage'], notifyFollowUpsOnly: true })
    expect(wantsBanner(update('resolved'), account, settings)).toBe(true)
  })

  it('lets a source hear everything, only outages, or nothing', () => {
    const settings = makeSettings({ notifySeverities: [], notifyFollowUpsOnly: false })

    expect(wantsBanner(update('update'), { ...account, notify: 'all' }, settings)).toBe(true)
    expect(wantsBanner(update('investigating'), { ...account, notify: 'outages' }, settings)).toBe(
      true
    )
    expect(wantsBanner(update('maintenance'), { ...account, notify: 'outages' }, settings)).toBe(
      false
    )
    expect(wantsBanner(update('outage'), { ...account, notify: 'off' }, settings)).toBe(false)
  })

  it('says nothing for a muted source', () => {
    expect(wantsBanner(update('outage'), { ...account, muted: true }, makeSettings())).toBe(false)
  })

  it('says nothing for a kind of source that is switched off', () => {
    const settings = makeSettings({ notifySources: ['webhook', 'probe'] })
    expect(wantsBanner(update('outage'), account, settings)).toBe(false)
  })

  describe('for the network checks', () => {
    it('keeps to core services by default', () => {
      const settings = makeSettings()
      expect(wantsBanner(measured(CORE.id, 'outage'), probe, settings)).toBe(true)
      expect(wantsBanner(measured(COMMUNITY.id, 'outage'), probe, settings)).toBe(false)
    })

    it('adds community services when asked', () => {
      const settings = makeSettings({ notifyProbeScope: 'all' })
      expect(wantsBanner(measured(COMMUNITY.id, 'outage'), probe, settings)).toBe(true)
    })

    /**
     * A feed listed in the user's own probe targets is a dashboard row the checked-in
     * catalogue has never heard of. Every feed is core, so it is announced like one.
     */
    it('counts a feed the user listed themselves as core', () => {
      const own = 'feed:feeds.example.test'
      expect(SERVICES.some((service) => service.id === own)).toBe(false)
      expect(wantsBanner(measured(own, 'outage'), probe, makeSettings())).toBe(true)
    })

    it('keeps core banners to the panels that count', () => {
      const spindle = SERVICES.find((service) => service.kind === 'spindle')!
      expect(wantsBanner(measured(spindle.id, 'outage'), probe, makeSettings())).toBe(false)
      const counted = makeSettings({ countedProbeGroups: ['tangled'] })
      expect(wantsBanner(measured(spindle.id, 'outage'), probe, counted)).toBe(true)
      expect(wantsBanner(measured(CORE.id, 'outage'), probe, counted)).toBe(false)
    })

    it('finds a PDS the user added in the panel it sits in', () => {
      const own = 'pds:mine.example.test'
      const probeTargets = {
        ...structuredClone(DEFAULT_PROBE_TARGETS),
        pdses: ['mine.example.test']
      }
      expect(wantsBanner(measured(own, 'outage'), probe, makeSettings({ probeTargets }))).toBe(true)
      const withoutPdses = makeSettings({ probeTargets, countedProbeGroups: ['relays'] })
      expect(wantsBanner(measured(own, 'outage'), probe, withoutPdses)).toBe(false)
    })

    // An entry whose URI names no service at all: nothing to judge it by but its source.
    it('gives an entry that names no service the benefit of the doubt', () => {
      const unnamed = makePost({
        authorDid: PROBE_SOURCE_DID,
        uri: 'elsewhere',
        severity: 'outage'
      })
      expect(wantsBanner(unnamed, probe, makeSettings())).toBe(true)
    })

    it('keeps to pinned services when asked', () => {
      const settings = makeSettings({ notifyProbeScope: 'pinned', pinnedServices: [COMMUNITY.id] })
      expect(wantsBanner(measured(COMMUNITY.id, 'outage'), probe, settings)).toBe(true)
      expect(wantsBanner(measured(CORE.id, 'outage'), probe, settings)).toBe(false)
    })

    it('can leave out partial failures and recoveries', () => {
      const settings = makeSettings({ notifyProbePartial: false, notifyProbeRecovery: false })
      expect(wantsBanner(measured(CORE.id, 'degraded'), probe, settings)).toBe(false)
      expect(wantsBanner(measured(CORE.id, 'resolved'), probe, settings)).toBe(false)
      expect(wantsBanner(measured(CORE.id, 'outage'), probe, settings)).toBe(true)
    })
  })
})

describe('applyFollowUps', () => {
  const settings = makeSettings({ notifyFollowUpsOnly: true })

  it('announces the all-clear for an incident whose start was announced', () => {
    const start = update('investigating', { createdAt: '2026-01-01T10:00:00Z' })
    const end = update('resolved', { createdAt: '2026-01-01T11:00:00Z' })

    const { posts, open } = applyFollowUps([start, end], [account], settings, [])

    expect(posts).toEqual([start, end])
    expect(open).toEqual([])
  })

  it('drops the all-clear for an incident nobody was told about', () => {
    const { posts } = applyFollowUps([update('resolved')], [account], settings, [])
    expect(posts).toEqual([])
  })

  it('remembers an open incident across refreshes', () => {
    const first = applyFollowUps([update('outage')], [account], settings, [])
    const second = applyFollowUps([update('monitoring')], [account], settings, first.open)

    expect(second.posts).toHaveLength(1)
    expect(second.open).toEqual(first.open)
  })

  it('lets every follow-up through when the setting is off', () => {
    const off = makeSettings({ notifyFollowUpsOnly: false })
    expect(applyFollowUps([update('resolved')], [account], off, []).posts).toHaveLength(1)
  })

  it('lets every follow-up through for a source set to hear everything', () => {
    const all: Account = { ...account, notify: 'all' }
    expect(applyFollowUps([update('resolved')], [all], settings, []).posts).toHaveLength(1)
  })

  it('keeps one service’s recovery from answering another’s outage', () => {
    const { posts } = applyFollowUps(
      [measured(CORE.id, 'outage'), measured(COMMUNITY.id, 'resolved', 2)],
      [probe],
      settings,
      []
    )
    expect(posts.map((post) => post.severity)).toEqual(['outage'])
  })

  /** It is persisted with the rest of the state, so it has to stop growing somewhere. */
  it('remembers only the most recent 200 open incidents', () => {
    const page = makeAccount({ did: 'webhook:pg', kind: 'webhook' })
    const opened = (n: number, severity: Severity): StatusPost =>
      makePost({ authorDid: page.did, uri: `webhook:pg/incident/inc_${n}/u1`, severity })
    const many = Array.from({ length: 201 }, (_, n) => opened(n, 'investigating'))

    const { open } = applyFollowUps(many, [page], settings, [])

    expect(open).toHaveLength(200)
    expect(open.at(-1)).toBe('webhook:pg/incident/inc_200')
    // The oldest is forgotten, and so is the right to announce how it ended.
    const late = applyFollowUps([opened(0, 'resolved')], [page], settings, open)
    expect(late.posts).toEqual([])
  })
})

describe('incidentKey', () => {
  it('files a pushed update under its incident, whichever update it is', () => {
    const a = makePost({ uri: 'webhook:pg_1/incident/inc_9/u1' })
    const b = makePost({ uri: 'webhook:pg_1/incident/inc_9/u2' })
    expect(incidentKey(a)).toBe('webhook:pg_1/incident/inc_9')
    expect(incidentKey(b)).toBe(incidentKey(a))
  })

  it('files a maintenance window apart from an incident that shares its id', () => {
    const post = makePost({ uri: 'webhook:pg_1/maintenance/inc_9/u1' })
    expect(incidentKey(post)).toBe('webhook:pg_1/maintenance/inc_9')
  })

  /** A component change names no incident, so the page itself stands in, as an account does. */
  it('files a component change under the page it came from', () => {
    const post = makePost({
      authorDid: 'webhook:pg_1',
      uri: 'webhook:pg_1/component/cmp_1/2026-03-01T10:00:00.000Z'
    })
    expect(incidentKey(post)).toBe('webhook:pg_1')
  })

  it('files a measured change under its service', () => {
    expect(incidentKey(measured(CORE.id, 'outage'))).toBe(`${PROBE_SOURCE_DID}/${CORE.id}`)
  })

  it('files a status post under its account', () => {
    expect(incidentKey(update('outage'))).toBe(account.did)
  })
})

const at = (hours: number, minutes = 0): Date => new Date(2026, 0, 1, hours, minutes)

describe('quiet hours', () => {
  const overnight = makeSettings({
    quietHoursEnabled: true,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00'
  })

  it('spans midnight when the start is later than the end', () => {
    expect(inQuietHours(overnight, at(23))).toBe(true)
    expect(inQuietHours(overnight, at(3))).toBe(true)
    expect(inQuietHours(overnight, at(8))).toBe(false)
    expect(inQuietHours(overnight, at(12))).toBe(false)
  })

  it('handles a window inside one day', () => {
    const lunch = { ...overnight, quietHoursStart: '12:00', quietHoursEnd: '13:30' }
    expect(inQuietHours(lunch, at(12, 45))).toBe(true)
    expect(inQuietHours(lunch, at(13, 30))).toBe(false)
  })

  it('is empty when switched off or when start and end are the same', () => {
    expect(inQuietHours({ ...overnight, quietHoursEnabled: false }, at(23))).toBe(false)
    expect(inQuietHours({ ...overnight, quietHoursEnd: '22:00' }, at(22))).toBe(false)
  })

  it('knows when they next end', () => {
    expect(quietHoursEnd(overnight, at(23))).toEqual(new Date(2026, 0, 2, 8, 0))
    expect(quietHoursEnd(overnight, at(3))).toEqual(at(8))
  })

  /**
   * The IPC boundary only lets `HH:MM` through, but a config file edited by hand is read
   * as it is. A window that cannot be read is no window, rather than a guess at one.
   */
  it('holds nothing back, and ends nowhere, when switched off or unreadable', () => {
    const unreadable = { ...overnight, quietHoursStart: '10pm', quietHoursEnd: 'dawn' }
    expect(inQuietHours(unreadable, at(23))).toBe(false)
    expect(quietHoursEnd(unreadable, at(23))).toBeNull()
    expect(quietHoursEnd({ ...overnight, quietHoursEnabled: false }, at(23))).toBeNull()
  })
})

describe('snoozing', () => {
  const now = new Date(2026, 0, 1, 15, 30)

  it('pauses for an hour', () => {
    expect(snoozeEnd('hour', makeSettings(), now)).toEqual(new Date(2026, 0, 1, 16, 30))
  })

  it('pauses until the morning quiet hours end', () => {
    const settings = makeSettings({ quietHoursEnabled: true, quietHoursEnd: '07:15' })
    expect(snoozeEnd('tomorrow', settings, now)).toEqual(new Date(2026, 0, 2, 7, 15))
  })

  it('pauses until eight when the quiet hours give no time to wake at', () => {
    const settings = makeSettings({ quietHoursEnabled: true, quietHoursEnd: 'dawn' })
    expect(snoozeEnd('tomorrow', settings, now)).toEqual(new Date(2026, 0, 2, 8, 0))
  })

  // Quiet hours that are off are not an answer to when the day starts, whatever end
  // time they were last left with.
  it('pauses until eight when quiet hours are off', () => {
    const settings = makeSettings({ quietHoursEnabled: false, quietHoursEnd: '10:00' })
    expect(snoozeEnd('tomorrow', settings, now)).toEqual(new Date(2026, 0, 2, 8, 0))
  })

  it('pauses until this morning, not the next, when chosen after midnight', () => {
    const late = new Date(2026, 0, 2, 0, 30)
    expect(snoozeEnd('tomorrow', makeSettings(), late)).toEqual(new Date(2026, 0, 2, 8, 0))
  })

  it('pauses until the next morning when chosen on the stroke of this one', () => {
    const eight = new Date(2026, 0, 2, 8, 0)
    expect(snoozeEnd('tomorrow', makeSettings(), eight)).toEqual(new Date(2026, 0, 3, 8, 0))
  })

  it('reads a snooze that has run out as none', () => {
    const past = makeSettings({ notificationsSnoozedUntil: new Date(2026, 0, 1, 15).toISOString() })
    const future = makeSettings({
      notificationsSnoozedUntil: new Date(2026, 0, 1, 16).toISOString()
    })
    expect(snoozedUntil(past, now)).toBeNull()
    expect(snoozedUntil(future, now)).toEqual(new Date(2026, 0, 1, 16))
  })

  it('reads no snooze, or one it cannot date, as none', () => {
    expect(snoozedUntil(makeSettings({ notificationsSnoozedUntil: null }), now)).toBeNull()
    expect(snoozedUntil(makeSettings({ notificationsSnoozedUntil: 'later' }), now)).toBeNull()
  })
})

describe('formatClock', () => {
  const now = new Date(2026, 0, 1, 9, 0)

  /** Worded by the locale, so what is pinned is the shape rather than the spelling. */
  it('says only the time for today, and names the day for any other', () => {
    const today = formatClock(new Date(2026, 0, 1, 14, 5), now)
    const tomorrow = formatClock(new Date(2026, 0, 2, 14, 5), now)

    expect(today).toContain('05')
    expect(tomorrow).not.toBe(today)
    expect(tomorrow.endsWith(` ${today}`)).toBe(true)
  })
})

describe('bannerSound', () => {
  it('sounds for outages only, for everything, or never', () => {
    expect(bannerSound(makeSettings({ notificationSound: 'urgent' }), ['degraded'])).toBe(true)
    expect(bannerSound(makeSettings({ notificationSound: 'urgent' }), ['monitoring'])).toBe(false)
    expect(bannerSound(makeSettings({ notificationSound: 'all' }), ['update'])).toBe(true)
    expect(bannerSound(makeSettings({ notificationSound: 'never' }), ['outage'])).toBe(false)
  })
})
