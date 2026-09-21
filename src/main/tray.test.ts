import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app, menus, nativeImage, openedExternally, trays } from '../test/electron'
import {
  makeAccount,
  makeNetworkSummary,
  makePost,
  makeSettings,
  makeState
} from '../test/factories'
import { PROBE_SOURCE_DID, probeAccount } from '../shared/network'
import type { AppState, Settings } from '../shared/types'
import { PopoverWindow } from './window'
import { TrayController } from './tray'

function build(): {
  tray: TrayController
  popover: PopoverWindow
  deps: {
    onRefresh: ReturnType<typeof vi.fn>
    onMarkAllRead: ReturnType<typeof vi.fn>
    onRunNetworkChecks: ReturnType<typeof vi.fn>
    onShowNetwork: ReturnType<typeof vi.fn>
    onQuit: ReturnType<typeof vi.fn>
  }
} {
  const popover = new PopoverWindow()
  const deps = {
    onRefresh: vi.fn(),
    onMarkAllRead: vi.fn(),
    onRunNetworkChecks: vi.fn(),
    onShowNetwork: vi.fn(),
    onQuit: vi.fn()
  }
  const tray = new TrayController({ popover, ...deps })
  tray.create()
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
    posts: [makePost({ authorDid: account.did, severity })]
  })
}

afterEach(() => {
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
        '/Applications/Statusky.app/Contents/Resources/assets/trayTemplate.png'
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
    tray.update(makeState({ accounts: [makeAccount()] }))
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

        // One beat later the cycle is back where it started.
        await vi.advanceTimersByTimeAsync(BEAT_INTERVAL_MS * BEAT_FRAMES)

        expect(frameOf(trays[0]!.image.path)).toBe('0')
        expect(BEAT_INTERVAL_MS * BEAT_FRAMES).toBe(400)
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

    it('is switched off by the `none` tray style', () => {
      const { tray } = build()
      tray.update(makeState({ unread: ['a'], settings: makeSettings({ trayUnreadStyle: 'none' }) }))
      expect(trays[0]!.image.path).toContain('trayTemplate.png')
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
      'separator',
      'Show network status',
      'separator',
      'Bluesky status page',
      'Blacksky status page',
      'Atmosphere status (status.feeds.blue)',
      'separator',
      `Version ${app.getVersion()}`,
      'Quit Statusky'
    ])
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
    menus[0]!.click('Atmosphere status (status.feeds.blue)')

    expect(openedExternally).toEqual([
      'https://status.bsky.app',
      'https://status.blacksky.community',
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

  it('disables the version entry and gives quit an accelerator', () => {
    build()
    trays[0]!.emit('right-click')

    expect(menus[0]!.item(`Version ${app.getVersion()}`)?.enabled).toBe(false)
    expect(menus[0]!.item('Quit Statusky')?.accelerator).toBe('CommandOrControl+Q')
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
