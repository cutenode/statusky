import { describe, expect, it } from 'vitest'
import { computePopoverPosition } from './position'

const workArea = { x: 0, y: 25, width: 1440, height: 875 }
const window = { width: 440, height: 640 }

describe('computePopoverPosition', () => {
  it('centres the popover under a macOS menu bar icon', () => {
    const { x, y } = computePopoverPosition({
      tray: { x: 700, y: 0, width: 24, height: 24 },
      workArea,
      window
    })
    expect(x).toBe(700 + 12 - 220)
    // Clamped to the work-area top plus the 8px margin, not the raw 30 below the icon.
    expect(y).toBe(33)
  })

  it('keeps the popover inside the right edge', () => {
    const { x } = computePopoverPosition({
      tray: { x: 1420, y: 0, width: 24, height: 24 },
      workArea,
      window
    })
    expect(x).toBe(1440 - 440 - 8)
  })

  it('keeps the popover inside the left edge', () => {
    const { x } = computePopoverPosition({
      tray: { x: 0, y: 0, width: 24, height: 24 },
      workArea,
      window
    })
    expect(x).toBe(8)
  })

  it('flips above the icon when the tray sits at the bottom of the screen', () => {
    const { y } = computePopoverPosition({
      tray: { x: 700, y: 880, width: 24, height: 24 },
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      window
    })
    // 880 - 640 - 6
    expect(y).toBe(234)
  })

  it('handles a second display with a non-zero origin', () => {
    const { x, y } = computePopoverPosition({
      tray: { x: 2200, y: 0, width: 24, height: 24 },
      workArea: { x: 1440, y: 25, width: 1920, height: 1055 },
      window
    })
    expect(x).toBe(2200 + 12 - 220)
    expect(y).toBe(33)
    expect(x).toBeGreaterThanOrEqual(1440 + 8)
  })

  it('never goes out of bounds when the window is taller than the work area', () => {
    const { y } = computePopoverPosition({
      tray: { x: 700, y: 0, width: 24, height: 24 },
      workArea: { x: 0, y: 0, width: 1440, height: 400 },
      window
    })
    expect(y).toBe(8)
  })
})

describe('a window larger than the display', () => {
  it('pins to the left margin rather than producing a negative x', () => {
    const { x } = computePopoverPosition({
      tray: { x: 500, y: 0, width: 24, height: 24 },
      workArea: { x: 0, y: 0, width: 300, height: 300 },
      window: { width: 440, height: 640 }
    })
    expect(x).toBe(8)
  })

  it('pins to the top margin rather than producing a negative y', () => {
    const { y } = computePopoverPosition({
      tray: { x: 100, y: 0, width: 24, height: 24 },
      workArea: { x: 0, y: 0, width: 1440, height: 200 },
      window: { width: 440, height: 640 }
    })
    expect(y).toBe(8)
  })
})
