/**
 * A stand-in for `electron/renderer`, which only exists inside a real renderer or
 * preload process.
 *
 * The generated preload wiring imports `webFrame` from here to answer "am I the top
 * frame?" before it exposes anything, so the double has to be able to say both yes and
 * no — see `subFrame()`.
 */
import type * as Real from 'electron/renderer'
import type { Conforms, Surface } from './electron'

export class FakeWebFrame {
  routingId = 1
  frameToken = 'main-frame'
  /** `null` means "I am the top frame". Set it to pretend to be an iframe. */
  parentFrame: FakeWebFrame | null = null

  /**
   * Typed as Electron types it, though the double never answers `null`: a real frame
   * whose top-level page lives in another renderer process — a cross-site iframe, under
   * site isolation — does, and anything reading this has to cope with that.
   */
  get top(): FakeWebFrame | null {
    return this.parentFrame ? this.parentFrame.top : this
  }
}

export const webFrame = new FakeWebFrame()

/** Make `webFrame` claim to be an iframe inside some other top-level page. */
export function subFrame(): void {
  const top = new FakeWebFrame()
  top.routingId = 99
  top.frameToken = 'top-frame'
  webFrame.parentFrame = top
}

export function resetWebFrame(): void {
  webFrame.routingId = 1
  webFrame.frameToken = 'main-frame'
  webFrame.parentFrame = null
}

export default { webFrame }

/** The frame identity the generated preload compares, held to Electron's. See electron.ts. */
export type _DriftGuards = [
  Conforms<FakeWebFrame, Surface<Real.WebFrame, 'routingId' | 'frameToken'>>
]
