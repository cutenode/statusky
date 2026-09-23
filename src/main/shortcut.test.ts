import { describe, expect, it, vi } from 'vitest'
import { globalShortcut } from '../test/electron'
import { withPlatform } from '../test/harness'
import { applyGlobalShortcut, releaseGlobalShortcut } from './shortcut'

const COMBINATION = 'CommandOrControl+Shift+S'

describe('applyGlobalShortcut', () => {
  it('claims the combination and reports that it holds it', () => {
    const summon = vi.fn()

    expect(applyGlobalShortcut(COMBINATION, summon)).toEqual({ registered: true, error: null })

    expect(globalShortcut.press(COMBINATION)).toBe(true)
    expect(summon).toHaveBeenCalledTimes(1)
  })

  /** Off is the default, and is not a failure: nothing is held and nothing is wrong. */
  it('holds nothing for the empty accelerator', () => {
    expect(applyGlobalShortcut('', vi.fn())).toEqual({ registered: false, error: null })
    expect(globalShortcut.registrations.size).toBe(0)
  })

  it('gives up the previous combination before asking for the next', () => {
    applyGlobalShortcut(COMBINATION, vi.fn())
    applyGlobalShortcut('Alt+Shift+S', vi.fn())

    expect(globalShortcut.press(COMBINATION)).toBe(false)
    expect(globalShortcut.isRegistered('Alt+Shift+S')).toBe(true)
  })

  it('lets go of everything when the setting is turned off again', () => {
    applyGlobalShortcut(COMBINATION, vi.fn())
    applyGlobalShortcut('', vi.fn())

    expect(globalShortcut.registrations.size).toBe(0)
  })

  /**
   * The failure this whole module exists for. A global shortcut belongs to whichever
   * application asked for it first, `register` answering false is the only notice there
   * is, and the symptom otherwise is a key that silently does somebody else's thing —
   * under a settings panel that says the shortcut is on. Exactly the shape of refusal
   * `LoginItemStatus` was introduced for, and it is surfaced the same way.
   */
  it('says so, in the platform’s own spelling, when another app already owns it', async () => {
    globalShortcut.taken.add(COMBINATION)

    const mac = await withPlatform('darwin', () => applyGlobalShortcut(COMBINATION, vi.fn()))
    expect(mac.registered).toBe(false)
    expect(mac.error).toContain('⌘⇧S')
    expect(mac.error).toContain('Another application')

    const windows = await withPlatform('win32', () => applyGlobalShortcut(COMBINATION, vi.fn()))
    expect(windows.error).toContain('Ctrl+Shift+S')
  })

  /**
   * `register` validates the accelerator as well as claiming it, and raises rather than
   * returning false for one the platform cannot express. Unreachable from the choices
   * the Settings panel offers; reachable from a config file somebody has edited.
   */
  it('survives an accelerator the platform cannot parse', () => {
    globalShortcut.registerThrows = new Error('Invalid accelerator')

    const status = applyGlobalShortcut('Ctrl+Nonsense', vi.fn())

    expect(status.registered).toBe(false)
    expect(status.error).toContain('Invalid accelerator')
  })

  /** A throw on its way out of native code is not obliged to be an `Error`. */
  it('survives a refusal that is not an Error at all', () => {
    globalShortcut.registerThrows = 'Invalid accelerator'

    expect(applyGlobalShortcut('Ctrl+Nonsense', vi.fn()).error).toContain('Invalid accelerator')
  })
})

describe('releaseGlobalShortcut', () => {
  /**
   * A global shortcut is held against the whole session rather than against a window, so
   * a registration that outlives the process can keep the combination dead for other
   * applications until the user logs out.
   */
  it('hands back whatever is held', () => {
    const summon = vi.fn()
    applyGlobalShortcut(COMBINATION, summon)

    releaseGlobalShortcut()

    expect(globalShortcut.registrations.size).toBe(0)
    expect(globalShortcut.press(COMBINATION)).toBe(false)
    expect(summon).not.toHaveBeenCalled()
  })
})
