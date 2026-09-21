export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PositionInput {
  /** Bounds of the tray icon, in screen coordinates. */
  tray: Rect
  /** Usable area of the display holding the tray icon. */
  workArea: Rect
  window: { width: number; height: number }
  /** Gap between the tray icon and the popover. */
  gap?: number
  /** Minimum distance from the edge of the work area. */
  margin?: number
}

/**
 * Place the popover under (or above) the tray icon, horizontally centred on it,
 * clamped so it always stays fully inside the display's work area.
 *
 * On Windows and most Linux setups the tray sits at the bottom of the screen, so
 * we flip the popover above the icon when there is not enough room below.
 */
export function computePopoverPosition(input: PositionInput): { x: number; y: number } {
  const { tray, workArea, window: win } = input
  const gap = input.gap ?? 6
  const margin = input.margin ?? 8

  const centred = Math.round(tray.x + tray.width / 2 - win.width / 2)
  const minX = workArea.x + margin
  const maxX = workArea.x + workArea.width - win.width - margin
  const x = Math.round(Math.min(Math.max(centred, minX), maxX < minX ? minX : maxX))

  const below = tray.y + tray.height + gap
  const above = tray.y - win.height - gap
  const fitsBelow = below + win.height <= workArea.y + workArea.height - margin

  const preferred = fitsBelow ? below : above
  const minY = workArea.y + margin
  const maxY = workArea.y + workArea.height - win.height - margin
  const y = Math.round(Math.min(Math.max(preferred, minY), maxY < minY ? minY : maxY))

  return { x, y }
}
