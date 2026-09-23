import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app, autoUpdater, menus, nativeImage, openedExternally, trays } from '../test/electron'
import {
  justPosted,
  makeAccount,
  makeNetworkSummary,
  makePost,
  makeSettings,
  makeState
} from '../test/factories'
import { withPlatform } from '../test/harness'
import { PROBE_SOURCE_DID, probeAccount } from '../shared/network'
import { formatClock } from '../shared/notify'
import type { AppState, Settings } from '../shared/types'
import { PopoverWindow } from './window'
import { TrayController } from './tray'

/**
 * Every controller `build` made, so each one's heartbeat can be stopped afterwards.
 * Destroying only the icon double would leave a real-timer beat ticking into a tray that
 * belongs to a test that has already finished.
 */
const controllers: TrayController[] = []

/**
 * A tray, created, with the popover having already reported that the OS is not asking
 * for reduced motion.
 *
 * That report is the ordinary steady state — the popover is built at startup and reports
 * on mount — but it is not the *initial* state, because `TrayController` assumes reduced
 * motion until a page tells it otherwise. Saying so here rather than in each test keeps
 * every test that is about something else reading the way it did; the tests that are
 * about the assumption pass `reduceMotion: true` and say so.
 */
function build(options: { reduceMotion?: boolean } = {}): {
  tray: TrayController
  popover: PopoverWindow
  deps: {
    onRefresh: ReturnType<typeof vi.fn>
    onMarkAllRead: ReturnType<typeof vi.fn>
    onRunNetworkChecks: ReturnType<typeof vi.fn>
    onShowNetwork: ReturnType<typeof vi.fn>
    onDropText: ReturnType<typeof vi.fn>
    onSnooze: ReturnType<typeof vi.fn>
    onQuit: ReturnType<typeof vi.fn>
  }
} {
  const popover = new PopoverWindow()
  const deps = {
    onRefresh: vi.fn(),
    onMarkAllRead: vi.fn(),
    onRunNetworkChecks: vi.fn(),
    onShowNetwork: vi.fn(),
    onDropText: vi.fn(),
    onSnooze: vi.fn(),
    onQuit: vi.fn()
  }
  const tray = new TrayController({ popover, ...deps })
  tray.create()
  tray.setReducedMotion(options.reduceMotion ?? false)
  controllers.push(tray)
  return { tray, popover, deps }
}

/** Kept in step with the frame count and rate in `tray.ts`. */
const BEAT_FRAMES = 10
const BEAT_INTERVAL_MS = 40

/** The frame number of a beat icon path, so a cycle can be asserted in order. */
function frameOf(path: string): string {
  return /trayBeat(\d+)\.png$/.exec(path)?.[1] ?? path
}

/** A state whose newest post for `did` has the given severity. */
function stateWithSeverity(severity: AppState['posts'][number]['severity']): AppState {
  const account = makeAccount({ did: 'did:plc:a', handle: 'a.test' })
  return makeState({
    accounts: [account],
    // Stamped now: the icon reports what is happening, and a claim stops being what
    // is happening once its author has been quiet for long enough.
    posts: [makePost({ authorDid: account.did, severity, createdAt: justPosted() })]
  })
}

afterEach(() => {
  for (const tray of controllers.splice(0)) tray.destroy()
  for (const tray of trays) tray.destroy()
})

describe('create', () => {
  it('starts with the neutral template icon and a plain tooltip', () => {
    build()
    const tray = trays[0]!

    expect(tray.image.path).toMatch(/trayTemplate\.png$/)
    expect(tray.image.isTemplate).toBe(true)
    expect(tray.tooltip).toBe('Statusky')
    expect(tray.ignoresDoubleClick).toBe(true)
  })

  it('loads icons from the repo resources directory in development', () => {
    build()
    expect(nativeImage.createFromPath).toHaveBeenCalledWith(
      expect.stringContaining('/resources/trayTemplate.png')
    )
  })

  it('loads icons from the packaged resources directory when packaged', () => {
    app.isPackaged = true
    const original = process.resourcesPath
    Object.defineProperty(process, 'resourcesPath', {
      value: '/Applications/Statusky.app/Contents/Resources',
      configurable: true
    })
    try {
      build()
      expect(nativeImage.createFromPath).toHaveBeenCalledWith(
        '/Applications/Statusky.app/Contents/Resources/resources/trayTemplate.png'
      )
    } finally {
      Object.defineProperty(process, 'resourcesPath', { value: original, configurable: true })
    }
  })

  it('toggles the popover on click', () => {
    const { popover } = build()
    popover.create()

    trays[0]!.emit('click')
    expect(popover.isVisible()).toBe(true)

    trays[0]!.emit('click')
    expect(popover.isVisible()).toBe(false)
  })

  it('pops up the context menu on right click', () => {
    build()
    trays[0]!.emit('right-click')
    expect(trays[0]!.poppedUpMenus).toHaveLength(1)
  })
})

describe('update', () => {
  it('does nothing before the tray exists', () => {
    const popover = new PopoverWindow()
    const tray = new TrayController({
      popover,
      onRefresh: vi.fn(),
      onMarkAllRead: vi.fn(),
      onRunNetworkChecks: vi.fn(),
      onShowNetwork: vi.fn(),
      onDropText: vi.fn(),
      onSnooze: vi.fn(),
      onQuit: vi.fn()
    })
    expect(() => tray.update(makeState())).not.toThrow()
    expect(trays).toHaveLength(0)
  })

  it.each([
    ['investigating', 'trayIncident'],
    ['outage', 'trayIncident'],
    ['degraded', 'trayIncident'],
    ['identified', 'trayIncident'],
    ['monitoring', 'trayMonitoring'],
    ['maintenance', 'trayMonitoring'],
    ['resolved', 'trayTemplate'],
    ['update', 'trayTemplate']
  ] as const)('shows the %s icon variant', (severity, stem) => {
    const { tray } = build()
    tray.update(stateWithSeverity(severity))
    expect(trays[0]!.image.path).toContain(`${stem}.png`)
  })

  it('marks only the neutral icon as a template image', () => {
    const { tray } = build()
    tray.update(stateWithSeverity('outage'))
    expect(trays[0]!.image.isTemplate).toBe(false)

    tray.update(stateWithSeverity('resolved'))
    expect(trays[0]!.image.isTemplate).toBe(true)
  })

  it('does not reload the image when the health is unchanged', () => {
    const { tray } = build()
    tray.update(stateWithSeverity('outage'))
    const calls = nativeImage.createFromPath.mock.calls.length

    tray.update(stateWithSeverity('outage'))

    expect(nativeImage.createFromPath.mock.calls.length).toBe(calls)
  })

  it('ignores muted accounts when rolling up health', () => {
    const { tray } = build()
    const muted = makeAccount({ did: 'did:plc:muted', handle: 'muted.test', muted: true })
    const fine = makeAccount({ did: 'did:plc:fine', handle: 'fine.test' })

    tray.update(
      makeState({
        accounts: [muted, fine],
        posts: [
          makePost({ authorDid: muted.did, severity: 'outage' }),
          makePost({ authorDid: fine.did, severity: 'resolved' })
        ]
      })
    )

    expect(trays[0]!.image.path).toContain('trayTemplate.png')
  })

  it('falls back to the neutral icon when there is no data', () => {
    const { tray } = build()
    // Coloured first, since the neutral icon is also the one it starts on.
    tray.update(stateWithSeverity('outage'))

    tray.update(makeState({ accounts: [makeAccount()] }))

    expect(trays[0]!.image.path).toContain('trayTemplate.png')
    expect(trays[0]!.tooltip).toContain('No data yet')
  })

  describe('the heartbeat', () => {
    it('beats red while anything is unread, whatever the health is', () => {
      const { tray } = build()
      tray.update(makeState({ unread: ['a'] }))
      expect(trays[0]!.image.path).toMatch(/trayBeat\d+\.png$/)
      expect(trays[0]!.image.isTemplate).toBe(false)
    })

    it('plays one cardiac cycle on a loop', () => {
      vi.useFakeTimers()
      try {
        const { tray } = build()
        tray.update(makeState({ unread: ['a'] }))

        const played: string[] = []
        for (let tick = 0; tick < BEAT_FRAMES * 2; tick++) {
          played.push(frameOf(trays[0]!.image.path))
          vi.advanceTimersByTime(BEAT_INTERVAL_MS)
        }

        const cycle = Array.from({ length: BEAT_FRAMES }, (_, i) => String(i))
        expect(played).toEqual([...cycle, ...cycle])
      } finally {
        vi.useRealTimers()
      }
    })

    it('beats at 150 bpm', async () => {
      vi.useFakeTimers()
      try {
        const { tray } = build()
        tray.update(makeState({ unread: ['a'] }))
        expect(frameOf(trays[0]!.image.path)).toBe('0')

        // 150 beats a minute is one every 400ms: a millisecond short of that the last
        // frame is still showing, and on the dot the cycle is back where it started.
        await vi.advanceTimersByTimeAsync(60_000 / 150 - 1)
        expect(frameOf(trays[0]!.image.path)).toBe(String(BEAT_FRAMES - 1))

        await vi.advanceTimersByTimeAsync(1)
        expect(frameOf(trays[0]!.image.path)).toBe('0')
      } finally {
        vi.useRealTimers()
      }
    })

    it('ships every frame it plays', () => {
      const dir = join(import.meta.dirname, '../../resources')
      for (let frame = 0; frame < BEAT_FRAMES; frame++) {
        expect(existsSync(join(dir, `trayBeat${frame}.png`))).toBe(true)
        expect(existsSync(join(dir, `trayBeat${frame}@2x.png`))).toBe(true)
      }
    })

    it('stops on the health icon once everything is read', async () => {
      vi.useFakeTimers()
      try {
        const { tray } = build()
        tray.update(makeState({ unread: ['a'] }))

        tray.update(makeState({ unread: [] }))
        expect(trays[0]!.image.path).toContain('trayTemplate.png')

        // The timer is gone, so the icon stays put.
        await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS * BEAT_FRAMES)
        expect(trays[0]!.image.path).toContain('trayTemplate.png')
      } finally {
        vi.useRealTimers()
      }
    })

    it('restores the health colour it was covering', () => {
      const { tray } = build()
      const incident = stateWithSeverity('outage')

      tray.update({ ...incident, unread: ['a'] })
      expect(trays[0]!.image.path).toMatch(/trayBeat\d+\.png$/)

      tray.update({ ...incident, unread: [] })
      expect(trays[0]!.image.path).toContain('trayIncident.png')
    })

    it('keeps beating across updates rather than restarting the cycle', async () => {
      vi.useFakeTimers()
      try {
        const { tray } = build()
        tray.update(makeState({ unread: ['a'] }))
        await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS * 3)
        expect(frameOf(trays[0]!.image.path)).toBe('3')

        tray.update(makeState({ unread: ['a', 'b'] }))

        expect(frameOf(trays[0]!.image.path)).toBe('3')
      } finally {
        vi.useRealTimers()
      }
    })

    it('loads the frames once, however long it beats', async () => {
      vi.useFakeTimers()
      try {
        const { tray } = build()
        tray.update(makeState({ unread: ['a'] }))
        const loads = nativeImage.createFromPath.mock.calls.length

        await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS * BEAT_FRAMES * 3)
        tray.update(makeState({ unread: [] }))
        tray.update(makeState({ unread: ['a'] }))
        await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS * BEAT_FRAMES)

        // Only the neutral icon in between; the frames themselves are reused.
        expect(nativeImage.createFromPath.mock.calls.length).toBe(loads + 1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('never keeps the process alive on its own', () => {
      vi.useFakeTimers()
      try {
        const { tray } = build()
        tray.update(makeState({ unread: ['a'] }))
        expect(vi.getTimerCount()).toBe(1)

        tray.destroy()

        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('the unread styles', () => {
    /** State with one unread update, an active incident, and the given tray style. */
    function unread(trayUnreadStyle: Settings['trayUnreadStyle']): AppState {
      return {
        ...stateWithSeverity('outage'),
        unread: ['a'],
        settings: makeSettings({ trayUnreadStyle })
      }
    }

    it('badges the health icon for `dot`, rather than hiding it behind a beat', () => {
      const { tray } = build()
      tray.update(unread('dot'))

      expect(trays[0]!.image.path).toContain('trayIncidentDot.png')
      expect(trays[0]!.image.isTemplate).toBe(false)
      expect(trays[0]!.title).toBe('')
    })

    it('keeps the badged neutral icon a template image', () => {
      const { tray } = build()
      tray.update({
        ...stateWithSeverity('resolved'),
        unread: ['a'],
        settings: makeSettings({ trayUnreadStyle: 'dot' })
      })

      expect(trays[0]!.image.path).toContain('trayTemplateDot.png')
      expect(trays[0]!.image.isTemplate).toBe(true)
    })

    it('ships every badged variant it can ask for', () => {
      const dir = join(import.meta.dirname, '../../resources')
      for (const stem of ['trayTemplate', 'trayMonitoring', 'trayIncident']) {
        expect(existsSync(join(dir, `${stem}Dot.png`))).toBe(true)
        expect(existsSync(join(dir, `${stem}Dot@2x.png`))).toBe(true)
      }
    })

    it('writes the number beside the plain health icon for `count`', () => {
      const { tray } = build()
      tray.update({ ...unread('count'), unread: ['a', 'b', 'c'] })

      expect(trays[0]!.image.path).toContain('trayIncident.png')
      expect(trays[0]!.title).toBe('3')
    })

    /**
     * Item 23. Without `monospacedDigit` the count is set in the menu bar's proportional
     * font, so 9 and 10 are different widths and everything to the left of the icon —
     * including the clock — shuffles sideways as the number changes.
     */
    it('writes the count in digits that all take the same width', () => {
      const { tray } = build()
      tray.update(unread('count'))

      expect(trays[0]!.title).toBe('1')
      expect(trays[0]!.titleOptions).toEqual({ fontType: 'monospacedDigit' })
    })

    it('clears the count once everything is read', () => {
      const { tray } = build()
      tray.update(unread('count'))
      tray.update({ ...unread('count'), unread: [] })

      expect(trays[0]!.title).toBe('')
    })

    it('does not rewrite an unchanged count', () => {
      const { tray } = build()
      tray.update(unread('count'))
      const setTitle = vi.spyOn(trays[0]!, 'setTitle')

      tray.update(unread('count'))

      expect(setTitle).not.toHaveBeenCalled()
    })

    it('badges instead of counting where `setTitle` does nothing', () => {
      const original = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      try {
        const { tray } = build()
        tray.update(unread('count'))

        expect(trays[0]!.image.path).toContain('trayIncidentDot.png')
        expect(trays[0]!.title).toBe('')
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true })
      }
    })

    it('leaves the icon alone for `none`, whatever is unread', () => {
      const { tray } = build()
      tray.update(unread('none'))

      expect(trays[0]!.image.path).toContain('trayIncident.png')
      expect(trays[0]!.title).toBe('')
    })

    /**
     * Item 22. The heartbeat is ten icon swaps a second in peripheral vision for as long
     * as anything is unread, and it is this app's *default* — so most of the people it
     * reaches never chose it. `dot` says the same thing and holds still.
     */
    describe('reduced motion', () => {
      it('degrades the beat to a badge when the OS asks for less motion', () => {
        const { tray } = build({ reduceMotion: true })
        tray.update(unread('beat'))

        expect(trays[0]!.image.path).toContain('trayIncidentDot.png')
        expect(trays[0]!.image.path).not.toMatch(/trayBeat/)
      })

      /**
       * The safe default, and the one decision in this item that is not obvious. Nothing
       * in the main process can read `prefers-reduced-motion`, so the answer comes from
       * the popover — which has not loaded yet at startup, and never loads at all if its
       * renderer has died three times. Being wrong the optimistic way flashes an icon at
       * ten hertz at somebody who asked the whole system for that not to happen; being
       * wrong this way costs a heartbeat for the second before the page reports in.
       */
      it('assumes reduced motion until a page has said otherwise', () => {
        const popover = new PopoverWindow()
        const tray = new TrayController({
          popover,
          onRefresh: vi.fn(),
          onMarkAllRead: vi.fn(),
          onRunNetworkChecks: vi.fn(),
          onShowNetwork: vi.fn(),
          onDropText: vi.fn(),
          onSnooze: vi.fn(),
          onQuit: vi.fn()
        })
        tray.create()

        tray.update(unread('beat'))

        expect(trays[0]!.image.path).toContain('trayIncidentDot.png')
      })

      it('starts beating the moment the page says motion is fine', () => {
        const { tray } = build({ reduceMotion: true })
        tray.update(unread('beat'))
        expect(trays[0]!.image.path).toContain('trayIncidentDot.png')

        // Applied to the state already in hand rather than waiting for the next poll,
        // which is a whole interval away.
        tray.setReducedMotion(false)

        expect(trays[0]!.image.path).toMatch(/trayBeat\d+\.png$/)
      })

      it('stops an already-playing beat when the preference comes on', () => {
        vi.useFakeTimers()
        try {
          const { tray } = build()
          tray.update(unread('beat'))
          expect(vi.getTimerCount()).toBe(1)

          tray.setReducedMotion(true)

          expect(trays[0]!.image.path).toContain('trayIncidentDot.png')
          expect(vi.getTimerCount()).toBe(0)
        } finally {
          vi.useRealTimers()
        }
      })

      it('leaves the stored preference exactly where the user put it', () => {
        const { tray } = build({ reduceMotion: true })
        const state = unread('beat')
        tray.update(state)

        // The app declining to shout, not the app editing what was asked for: the very
        // same object goes back out, with `beat` still on it.
        expect(state.settings.trayUnreadStyle).toBe('beat')
      })

      it('does nothing with a report that has not changed', () => {
        const { tray } = build()
        tray.update(unread('beat'))
        const setImage = vi.spyOn(trays[0]!, 'setImage')

        tray.setReducedMotion(false)

        expect(setImage).not.toHaveBeenCalled()
      })

      it('survives a report arriving before anything has been drawn', () => {
        const { tray } = build()
        expect(() => tray.setReducedMotion(true)).not.toThrow()
      })

      // `count` is a number, not motion, so the preference has nothing to say about it.
      it('leaves the other styles alone', () => {
        const { tray } = build({ reduceMotion: true })

        tray.update(unread('count'))
        expect(trays[0]!.title).toBe('1')

        tray.update(unread('none'))
        expect(trays[0]!.image.path).toContain('trayIncident.png')
      })
    })

    it('says nothing at all when there is nothing unread', () => {
      const { tray } = build()
      for (const style of ['beat', 'dot', 'count'] as const) {
        tray.update({ ...unread(style), unread: [] })
        expect(trays[0]!.image.path).toContain('trayIncident.png')
        expect(trays[0]!.title).toBe('')
      }
    })
  })

  describe('the tooltip', () => {
    it('leads with the health label', () => {
      const { tray } = build()
      tray.update(stateWithSeverity('outage'))
      expect(trays[0]!.tooltip.split('\n')[0]).toBe('Statusky — Active incident')
    })

    it('pluralises the unread line', () => {
      const { tray } = build()
      tray.update(makeState({ unread: ['a'] }))
      expect(trays[0]!.tooltip).toContain('1 unread update')

      tray.update(makeState({ unread: ['a', 'b'] }))
      expect(trays[0]!.tooltip).toContain('2 unread updates')
    })

    it('reports the last check and a failed refresh', () => {
      const { tray } = build()
      tray.update(
        makeState({
          sync: { status: 'error', lastSyncedAt: '2026-01-01T12:00:00Z', error: 'boom' }
        })
      )
      expect(trays[0]!.tooltip).toContain('Last checked')
      expect(trays[0]!.tooltip).toContain('Last refresh failed')
    })

    it('omits the last-checked line before the first sync', () => {
      const { tray } = build()
      tray.update(makeState({ sync: { status: 'idle', lastSyncedAt: null, error: null } }))
      expect(trays[0]!.tooltip).not.toContain('Last checked')
    })
  })
})

describe('the network checks', () => {
  const calm = (): AppState => stateWithSeverity('resolved')

  it('turn the icon red when they confirm a service down', () => {
    const { tray } = build()
    tray.update({
      ...calm(),
      network: makeNetworkSummary({
        health: 'down',
        down: ['europe.firehose.network'],
        total: 26,
        reachable: 25
      })
    })
    expect(trays[0]!.image.path).toContain('trayIncident.png')
    expect(trays[0]!.tooltip.split('\n').slice(0, 2)).toEqual([
      'Statusky — europe.firehose.network is unreachable',
      'Network: 25 of 26 services reachable'
    ])
  })

  it('turn it amber for a partial failure', () => {
    const { tray } = build()
    tray.update({ ...calm(), network: makeNetworkSummary({ health: 'degraded', degraded: ['x'] }) })
    expect(trays[0]!.image.path).toContain('trayMonitoring.png')
  })

  it('leave it neutral while offline, and say so', () => {
    const { tray } = build()
    tray.update({
      ...stateWithSeverity('outage'),
      network: makeNetworkSummary({ health: 'offline' })
    })
    expect(trays[0]!.image.path).toContain('trayTemplate.png')
    expect(trays[0]!.tooltip.split('\n').slice(0, 2)).toEqual([
      'Statusky — You appear to be offline',
      'Network checks resume when you are back online'
    ])
  })

  it('say they are checking before the first sweep has finished', () => {
    const { tray } = build()
    tray.update({ ...calm(), network: makeNetworkSummary({ health: 'unknown', running: true }) })
    expect(trays[0]!.tooltip).toContain('Checking the network…')

    tray.update({ ...calm(), network: makeNetworkSummary({ health: 'unknown' }) })
    expect(trays[0]!.tooltip).not.toContain('Network')
  })

  it('say nothing at all when switched off', () => {
    const { tray } = build()
    tray.update({ ...calm(), network: makeNetworkSummary({ health: 'off' }) })
    expect(trays[0]!.tooltip).not.toContain('Network')
  })

  // A tooltip saying the network was last checked forty minutes ago under a ten-minute
  // setting reads as the app being broken, so the schedule says why it is behaving.
  it('say when the machine itself is what is holding the schedule back', () => {
    const { tray } = build()

    tray.update({
      ...calm(),
      network: makeNetworkSummary({ health: 'operational', total: 26, reachable: 26 }),
      settings: makeSettings()
    })
    expect(trays[0]!.tooltip).not.toContain('battery')

    tray.update({
      ...calm(),
      network: makeNetworkSummary({
        health: 'operational',
        total: 26,
        reachable: 26,
        restraint: 'battery'
      })
    })
    expect(trays[0]!.tooltip.split('\n').slice(1, 3)).toEqual([
      'Network: 26 of 26 services reachable',
      'Checking less often on battery'
    ])

    tray.update({
      ...calm(),
      network: makeNetworkSummary({ health: 'operational', restraint: 'thermal' })
    })
    expect(trays[0]!.tooltip).toContain('Checks paused while this machine is under load')
  })

  it('say nothing about the schedule when the checks are off entirely', () => {
    const { tray } = build()
    tray.update({
      ...calm(),
      network: makeNetworkSummary({ health: 'off', restraint: 'battery' })
    })
    expect(trays[0]!.tooltip).not.toContain('battery')
  })

  it('stop counting once their source is hidden', () => {
    const { tray } = build()
    const state = calm()
    tray.update({
      ...state,
      accounts: [...state.accounts, { ...probeAccount('2026-01-01T00:00:00Z'), muted: true }],
      network: makeNetworkSummary({ health: 'down', down: ['europe.firehose.network'] })
    })
    expect(trays[0]!.image.path).toContain('trayTemplate.png')
  })

  it('go by the live measurement, not by their newest feed entry', () => {
    const { tray } = build()
    const state = calm()
    tray.update({
      ...state,
      accounts: [...state.accounts, probeAccount('2026-01-01T00:00:00Z')],
      posts: [...state.posts, makePost({ authorDid: PROBE_SOURCE_DID, severity: 'outage' })],
      network: makeNetworkSummary({ health: 'operational', total: 26, reachable: 26 })
    })
    expect(trays[0]!.image.path).toContain('trayTemplate.png')
  })
})

describe('the context menu', () => {
  it('offers the expected entries', () => {
    build()
    trays[0]!.emit('right-click')
    const menu = menus[0]!

    expect(menu.template.map((entry) => entry.label ?? entry.type)).toEqual([
      'Open Statusky',
      'separator',
      'Refresh now',
      'Run network checks',
      'Mark all as read',
      'Pause notifications',
      'separator',
      'Show network status',
      'separator',
      'Bluesky status page',
      'Blacksky status page',
      'Northsky status page',
      'Atmosphere status (status.feeds.blue)',
      'separator',
      // No update entry: there is nothing to offer while `stage` is `current`.
      'About Statusky',
      'Quit Statusky'
    ])
  })

  it('offers to pause notifications for an hour or until tomorrow', () => {
    const { deps } = build()
    trays[0]!.emit('right-click')
    const menu = menus.at(-1)!

    const choices = menu.submenu('Pause notifications')!
    expect(choices.map((entry) => entry.label)).toEqual(['For 1 hour', 'Until tomorrow'])
    choices[1]!.click?.()

    expect(deps.onSnooze).toHaveBeenCalledWith('tomorrow')
  })

  it('offers to resume while paused, saying until when', () => {
    const { tray, deps } = build()
    const until = new Date(Date.now() + 30 * 60_000)
    tray.update(
      makeState({ settings: makeSettings({ notificationsSnoozedUntil: until.toISOString() }) })
    )
    trays[0]!.emit('right-click')
    const menu = menus.at(-1)!

    // The snooze's own end, in the clock format Settings uses for it.
    const label = `Resume notifications (paused until ${formatClock(until, new Date())})`
    expect(menu.item('Pause notifications')).toBeUndefined()
    menu.click(label)

    expect(deps.onSnooze).toHaveBeenCalledWith(null)
  })

  // A snooze that has run out reads as over the moment the menu is next opened, with no
  // state change in between to say so.
  it('offers to pause again once a snooze has run out', () => {
    vi.useFakeTimers()
    try {
      const { tray } = build()
      const until = new Date(Date.now() + 60_000).toISOString()
      tray.update(makeState({ settings: makeSettings({ notificationsSnoozedUntil: until }) }))

      vi.setSystemTime(Date.now() + 2 * 60_000)
      trays[0]!.emit('right-click')

      expect(menus.at(-1)!.submenu('Pause notifications')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers neither pause nor resume while notifications are off altogether', () => {
    const { tray } = build()
    const until = new Date(Date.now() + 30 * 60_000).toISOString()
    tray.update(
      makeState({
        settings: makeSettings({ notificationsEnabled: false, notificationsSnoozedUntil: until })
      })
    )
    trays[0]!.emit('right-click')

    const labels = menus.at(-1)!.template.map((entry) => entry.label ?? entry.type)
    expect(labels.filter((label) => /notifications/i.test(label ?? ''))).toEqual([])
  })

  it('shows the popover anchored to the tray icon', () => {
    const { popover } = build()
    popover.create()
    trays[0]!.emit('right-click')

    menus[0]!.click('Open Statusky')

    expect(popover.isVisible()).toBe(true)
  })

  it('wires refresh, mark-all-read and quit to their callbacks', () => {
    const { deps } = build()
    trays[0]!.emit('right-click')

    menus[0]!.click('Refresh now')
    menus[0]!.click('Mark all as read')
    menus[0]!.click('Quit Statusky')

    expect(deps.onRefresh).toHaveBeenCalledTimes(1)
    expect(deps.onMarkAllRead).toHaveBeenCalledTimes(1)
    expect(deps.onQuit).toHaveBeenCalledTimes(1)
  })

  it('opens every status page in the browser', () => {
    build()
    trays[0]!.emit('right-click')

    menus[0]!.click('Bluesky status page')
    menus[0]!.click('Blacksky status page')
    menus[0]!.click('Northsky status page')
    menus[0]!.click('Atmosphere status (status.feeds.blue)')

    expect(openedExternally).toEqual([
      'https://status.bsky.app',
      'https://status.blacksky.community',
      'https://status.northsky.social',
      'https://status.feeds.blue'
    ])
  })

  it('runs the network checks and shows their dashboard', () => {
    const { deps } = build()
    trays[0]!.emit('right-click')

    menus[0]!.click('Run network checks')
    menus[0]!.click('Show network status')

    expect(deps.onRunNetworkChecks).toHaveBeenCalledTimes(1)
    expect(deps.onShowNetwork).toHaveBeenCalledTimes(1)
  })

  it('offers to run the checks only while they are switched on', () => {
    const { tray } = build()
    trays[0]!.emit('right-click')
    expect(menus[0]!.item('Run network checks')?.enabled).toBe(true)

    tray.update(makeState({ settings: makeSettings({ networkChecks: false }) }))
    trays[0]!.emit('right-click')
    expect(menus[1]!.item('Run network checks')?.enabled).toBe(false)
  })

  // It used to say `Version 0.1.0` and refuse to be clicked. The panel it opens now
  // carries the version, the copyright and what the app is; see src/main/menu.ts.
  it('opens the native About panel rather than stating the version and stopping', () => {
    build()
    trays[0]!.emit('right-click')

    menus[0]!.click('About Statusky')

    expect(app.showAboutPanel).toHaveBeenCalledTimes(1)
    expect(menus[0]!.item('About Statusky')?.enabled).toBeUndefined()
  })

  it('gives quit an accelerator', () => {
    build()
    trays[0]!.emit('right-click')

    expect(menus[0]!.item('Quit Statusky')?.accelerator).toBe('CommandOrControl+Q')
  })
})

/** State whose only interesting feature is what the app has learned about itself. */
function withUpdate(stage: 'current' | 'available' | 'ready', version: string | null): AppState {
  return makeState({ update: { stage, version } })
}

/**
 * Item 27. The app's one piece of news about itself, and the one place it is allowed to
 * say it out loud. An OS notification from Statusky means the Atmosphere is broken, and
 * a version number is not that: put it through the same channel and the next real one
 * costs less to ignore. The menu is already where this app's verbs live.
 */
describe('the update entry', () => {
  it('is absent entirely while there is nothing to offer', () => {
    const { tray } = build()
    tray.update(withUpdate('current', null))
    trays[0]!.emit('right-click')

    // Nothing between the status pages and About — not an entry, not a separator.
    const labels = menus.at(-1)!.template.map((entry) => entry.label ?? entry.type)
    expect(labels.slice(labels.indexOf('Atmosphere status (status.feeds.blue)'))).toEqual([
      'Atmosphere status (status.feeds.blue)',
      'separator',
      'About Statusky',
      'Quit Statusky'
    ])
  })

  /**
   * macOS and Windows, where Squirrel has already fetched the build and the only thing
   * left is a restart. `quitAndInstall` does not return: the process is handed over.
   */
  it('restarts into a downloaded update, naming the version', () => {
    const { tray } = build()
    tray.update(withUpdate('ready', '0.5.0'))
    trays[0]!.emit('right-click')

    menus.at(-1)!.click('Restart to update 0.5.0')

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  /** Squirrel.Windows does not always say which version it has downloaded. */
  it('still offers the restart when the version is not known', () => {
    const { tray } = build()
    tray.update(withUpdate('ready', null))
    trays[0]!.emit('right-click')

    menus.at(-1)!.click('Restart to update')

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  /**
   * Everywhere Squirrel cannot help. The label says *Download* rather than *Update*
   * because nothing here updates anything: these builds come from a download page, not
   * from a package repository, so replacing the copy is the user's to do.
   */
  it('sends the user to the download page where nothing can install for them', () => {
    const { tray } = build()
    tray.update(withUpdate('available', '0.2.0'))
    trays[0]!.emit('right-click')

    menus.at(-1)!.click('Download Statusky 0.2.0')

    expect(openedExternally).toEqual(['https://github.com/cutenode/statusky/releases/latest'])
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('sits above About rather than at the top, because it is never why you opened this', () => {
    const { tray } = build()
    tray.update(withUpdate('available', '0.2.0'))
    trays[0]!.emit('right-click')

    const labels = menus.at(-1)!.template.map((entry) => entry.label ?? entry.type)
    expect(labels.indexOf('Download Statusky 0.2.0')).toBe(labels.indexOf('About Statusky') - 2)
    expect(labels[0]).toBe('Open Statusky')
  })

  it('goes away again if the news is withdrawn', () => {
    const { tray } = build()
    tray.update(withUpdate('available', '0.2.0'))
    tray.update(withUpdate('current', null))
    trays[0]!.emit('right-click')

    expect(menus.at(-1)!.item('Download Statusky 0.2.0')).toBeUndefined()
  })
})

/** The labels of the attached menu's entries about banners, and nothing else. */
function notificationEntries(): (string | undefined)[] {
  const labels = trays[0]!.contextMenu!.template.map((entry) => entry.label)
  return labels.filter((label) => /notifications/i.test(label ?? ''))
}

/**
 * Item 3. Most Linux desktops now speak StatusNotifierItem/AppIndicator rather than the
 * old XEmbed tray, and under it a left click is never delivered to the application — so
 * an item that has not set a menu through `setContextMenu` can end up with no way in at
 * all. None of this is reachable from macOS except through `process.platform`, which is
 * why the branch is written on it.
 */
describe('the Linux context menu', () => {
  it('attaches the menu to the icon, so there is always a way in', async () => {
    await withPlatform('linux', () => {
      build()
      const menu = trays[0]!.contextMenu
      expect(menu).not.toBeNull()
      expect(menu!.template.map((entry) => entry.label)).toContain('Open Statusky')
    })
  })

  it('opens the popover from the attached menu', async () => {
    await withPlatform('linux', () => {
      const { popover } = build()
      popover.create()

      trays[0]!.contextMenu!.click('Open Statusky')

      expect(popover.isVisible()).toBe(true)
    })
  })

  /**
   * The menu is built once here rather than per right-click, so it holds whatever
   * `networkChecks` was at the time — and *Run network checks* would stay greyed out
   * after the setting came back on, with no way to notice.
   */
  it('rebuilds the attached menu when the state it reads moves', async () => {
    await withPlatform('linux', () => {
      const { tray } = build()
      tray.update(makeState({ settings: makeSettings({ networkChecks: false }) }))

      const disabled = trays[0]!.contextMenu!.template.find(
        (entry) => entry.label === 'Run network checks'
      )
      expect(disabled?.enabled).toBe(false)

      tray.update(makeState({ settings: makeSettings({ networkChecks: true }) }))

      const enabled = trays[0]!.contextMenu!.template.find(
        (entry) => entry.label === 'Run network checks'
      )
      expect(enabled?.enabled).toBe(true)
    })
  })

  /**
   * The same hazard as the one above, for the other thing the menu now reads. A build
   * that learned about a new release and never rebuilt this menu would be the one
   * platform where the news never appears — and Linux is the platform that has nothing
   * else to tell it, since Linux never self-updates.
   */
  it('rebuilds the attached menu when there is an update to offer', async () => {
    await withPlatform('linux', () => {
      const { tray } = build()
      expect(trays[0]!.contextMenu!.item('Download Statusky 0.2.0')).toBeUndefined()

      tray.update(makeState({ update: { stage: 'available', version: '0.2.0' } }))

      expect(trays[0]!.contextMenu!.item('Download Statusky 0.2.0')).toBeDefined()
    })
  })

  /**
   * And again for the snooze, whose entry flips between *Pause* and *Resume*. Left
   * stale, a Linux menu would go on offering to pause banners that are already paused,
   * with no way to resume them short of Settings.
   */
  it('rebuilds the attached menu when notifications are paused, resumed or switched off', async () => {
    await withPlatform('linux', () => {
      const { tray } = build()
      const until = new Date(Date.now() + 30 * 60_000).toISOString()
      expect(notificationEntries()).toEqual(['Pause notifications'])

      tray.update(makeState({ settings: makeSettings({ notificationsSnoozedUntil: until }) }))
      expect(notificationEntries()).toEqual([expect.stringMatching(/^Resume notifications/)])

      tray.update(makeState())
      expect(notificationEntries()).toEqual(['Pause notifications'])

      tray.update(makeState({ settings: makeSettings({ notificationsEnabled: false }) }))
      expect(notificationEntries()).toEqual([])
    })
  })

  // A native menu object per state change, several times a minute while a sweep runs,
  // for a menu whose only input has not moved.
  it('does not rebuild it for a change the menu cannot see', async () => {
    await withPlatform('linux', () => {
      const { tray } = build()
      tray.update(makeState({ unread: ['a'] }))
      const built = trays[0]!.contextMenu

      tray.update(makeState({ unread: ['a', 'b'] }))

      expect(trays[0]!.contextMenu).toBe(built)
    })
  })

  /**
   * On macOS `setContextMenu` replaces the left-click toggle with a menu, and clicking
   * the icon to get the popover is this app's entire interaction. Windows has a working
   * right-click, so it keeps the pop-up-on-demand menu too.
   */
  it('is not attached on macOS or Windows', async () => {
    /** Build a tray on `platform` and report whether a menu was attached to the icon. */
    const attached = async (platform: NodeJS.Platform): Promise<unknown> => {
      trays.length = 0
      return withPlatform(platform, () => {
        const { tray } = build()
        // A state change too, since that is the other place the menu is set.
        tray.update(makeState({ settings: makeSettings({ networkChecks: false }) }))
        return trays[0]!.contextMenu
      })
    }

    expect(await attached('darwin')).toBeNull()
    expect(await attached('win32')).toBeNull()
  })

  // The old XEmbed trays still deliver both, and a session running one should still work.
  it('keeps the click handlers, which some sessions do deliver', async () => {
    await withPlatform('linux', () => {
      const { popover } = build()
      popover.create()

      trays[0]!.emit('click')
      expect(popover.isVisible()).toBe(true)

      trays[0]!.emit('right-click')
      expect(trays[0]!.poppedUpMenus).toHaveLength(1)
    })
  })
})

/**
 * Dragging a handle onto the menu bar icon: the shortest path there is from "I should
 * watch this" to watching it. Select `status.blacksky.community` in a browser, drag it
 * to the icon, let go — no popover, no Accounts panel, no typing a handle by hand.
 *
 * All three events are macOS-only in Electron and are never emitted anywhere else, which
 * is also why none of this is guarded by a platform check: there is nothing to guard.
 */
/** State whose only interesting feature is the number the icon is writing beside it. */
function counted(count: number): AppState {
  return makeState({
    unread: Array.from({ length: count }, (_, index) => String(index)),
    settings: makeSettings({ trayUnreadStyle: 'count' })
  })
}

describe('dropping text on the icon', () => {
  it('hands over whatever was dropped, exactly as it arrived', () => {
    const { deps } = build()

    trays[0]!.dropText('status.blacksky.community')

    expect(deps.onDropText).toHaveBeenCalledWith('status.blacksky.community')
  })

  /**
   * The icon itself is a health report, so it cannot be turned into a drop target for
   * the length of a drag without saying something untrue about the network. A `+` beside
   * it is what macOS uses everywhere else to mean "let go here and this gets added".
   */
  it('says the icon will take it, and puts the icon back afterwards', () => {
    const { tray } = build()
    tray.update(counted(1))
    expect(trays[0]!.title).toBe('1')

    trays[0]!.dragEnter()
    expect(trays[0]!.title).toBe('+')

    trays[0]!.dragLeave()
    expect(trays[0]!.title).toBe('1')
  })

  it('puts the icon back when the drag ends in a drop', () => {
    const { tray } = build()
    tray.update(counted(1))

    trays[0]!.dragEnter()
    trays[0]!.dropText('status.bsky.app')

    expect(trays[0]!.title).toBe('1')
  })

  /**
   * A poll can land in the second a drag is over the icon. The cue has to survive it,
   * and what comes back afterwards has to be the title the *new* state asked for rather
   * than the one from before the drag.
   */
  it('keeps the cue through an update, and restores what the update asked for', () => {
    const { tray } = build()
    tray.update(counted(1))

    trays[0]!.dragEnter()
    tray.update(counted(4))
    expect(trays[0]!.title).toBe('+')

    trays[0]!.dragLeave()
    expect(trays[0]!.title).toBe('4')
  })

  it('does not stack cues when the pointer moves around over the icon', () => {
    const { tray } = build()
    tray.update(counted(1))

    trays[0]!.dragEnter()
    trays[0]!.dragEnter()
    trays[0]!.dragLeave()

    expect(trays[0]!.title).toBe('1')
  })

  it('ignores a drag leaving that never entered', () => {
    const { tray } = build()
    tray.update(counted(1))

    trays[0]!.dragLeave()

    expect(trays[0]!.title).toBe('1')
  })
})

describe('bounds', () => {
  it('knows where the icon is, once there is one', () => {
    const popover = new PopoverWindow()
    const tray = new TrayController({
      popover,
      onRefresh: vi.fn(),
      onMarkAllRead: vi.fn(),
      onRunNetworkChecks: vi.fn(),
      onShowNetwork: vi.fn(),
      onDropText: vi.fn(),
      onSnooze: vi.fn(),
      onQuit: vi.fn()
    })
    expect(tray.bounds()).toBeUndefined()

    tray.create()
    expect(tray.bounds()).toEqual(trays[0]!.getBounds())
  })
})

describe('destroy', () => {
  it('destroys the icon and tolerates a second call', () => {
    const { tray } = build()
    tray.destroy()
    expect(trays[0]!.destroyed).toBe(true)
    expect(() => tray.destroy()).not.toThrow()
  })

  it('stops updating after being destroyed', () => {
    const { tray } = build()
    tray.destroy()
    expect(() => tray.update(stateWithSeverity('outage'))).not.toThrow()
    expect(trays[0]!.image.path).toContain('trayTemplate.png')
  })
})
