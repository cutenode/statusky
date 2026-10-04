import { describe, expect, it, vi } from 'vitest'
import { mediaListenerCount, setMediaQuery } from '../test/setup'
import { motion, scrolling, startReducedMotionSync, transitionMs } from './motion.svelte'

const REDUCE = '(prefers-reduced-motion: reduce)'

describe('startReducedMotionSync', () => {
  /**
   * The main process assumes reduced motion until a page says otherwise, so this first
   * call is not an optimisation — it is what gives their heartbeat back to everybody
   * who never asked for it to stop.
   */
  it('reports the current preference immediately', () => {
    setMediaQuery(REDUCE, true)
    const report = vi.fn()

    const stop = startReducedMotionSync(report)

    expect(report).toHaveBeenCalledWith(true)
    stop()
  })

  it('reports the ordinary case too, rather than only the exception', () => {
    setMediaQuery(REDUCE, false)
    const report = vi.fn()

    const stop = startReducedMotionSync(report)

    expect(report).toHaveBeenCalledWith(false)
    stop()
  })

  it('follows the setting being changed while the popover is open', () => {
    setMediaQuery(REDUCE, false)
    const report = vi.fn()
    const stop = startReducedMotionSync(report)
    report.mockClear()

    setMediaQuery(REDUCE, true)
    expect(report).toHaveBeenLastCalledWith(true)

    setMediaQuery(REDUCE, false)
    expect(report).toHaveBeenLastCalledWith(false)

    stop()
  })

  // The popover is closed and rebuilt over an app's lifetime; a listener per window
  // would pile up on a query that outlives all of them.
  it('unsubscribes when stopped, and stops reporting', () => {
    setMediaQuery(REDUCE, false)
    const report = vi.fn()
    const stop = startReducedMotionSync(report)
    expect(mediaListenerCount(REDUCE)).toBe(1)

    stop()
    expect(mediaListenerCount(REDUCE)).toBe(0)

    report.mockClear()
    setMediaQuery(REDUCE, true)
    expect(report).not.toHaveBeenCalled()
  })
})

describe('the page’s own motion', () => {
  it('follows the preference as it is reported', () => {
    setMediaQuery(REDUCE, true)
    const stop = startReducedMotionSync(vi.fn())
    expect(motion.reduced).toBe(true)
    expect(transitionMs(180)).toBe(0)
    expect(scrolling()).toBe('auto')

    setMediaQuery(REDUCE, false)
    expect(motion.reduced).toBe(false)
    expect(transitionMs(180)).toBe(180)
    expect(scrolling()).toBe('smooth')
    stop()
  })
})
