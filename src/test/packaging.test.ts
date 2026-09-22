/**
 * The fuse wire a packaged build ships with.
 *
 * Nothing else in the suite can see this: every test here runs unpackaged, against a
 * doubled Electron, where a fuse is a byte in a binary nobody built. So the two things
 * that can be checked are that `forge.config.ts` still flips nothing — leaving every
 * fuse at whatever Electron shipped — and that what Electron ships is still what the
 * comments in `forge.config.ts` were reasoned against. Worth a test, because the cost of
 * getting one wrong is only ever paid by a real package on a real machine, and the last
 * time it was paid it looked like a protocol bug in the firehose decoder.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { describe, expect, it } from 'vitest'
import config from '../../forge.config'

/**
 * The Electron this project builds against, as an unpacked binary with its fuse wire
 * still in it. Read from `path.txt` rather than by importing `electron`, which Vitest
 * aliases to the double in src/test/electron.ts.
 */
const ELECTRON_DIST = join(process.cwd(), 'node_modules', 'electron')
const ELECTRON_BINARY = join(
  ELECTRON_DIST,
  'dist',
  readFileSync(join(ELECTRON_DIST, 'path.txt'), 'utf8').trim()
)

/**
 * A fuse in the wire is stored as an ASCII digit — `'1'` on, `'0'` off. `@electron/fuses`
 * names these in a `FuseState` enum that its entry point does not re-export, so the
 * comparison is made on the character instead.
 */
function isOn(state: number | undefined): boolean {
  return state !== undefined && String.fromCharCode(state) === '1'
}

/** This project's own package.json, which is also the one that ends up in the asar. */
const PACKAGE_JSON = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8')
) as Record<string, unknown>

describe('the packaged build', () => {
  /**
   * Two names decide what the app is called, and they are set in different files.
   * `packagerConfig.name` names the bundle — `Statusky.app`, its executable, its
   * `CFBundleName` — and `productName` in package.json is what Electron hands back from
   * `app.getName()` at runtime, which the application menu and the About panel are built
   * out of. Electron prefers `productName` over the lowercase `name` beside it; with no
   * `productName` at all it falls back to that lowercase `name`, which is how a bundle
   * called Statusky ended up writing `~/Library/Application Support/statusky` and
   * labelling its own menu `statusky`.
   *
   * They have to agree, and nothing but this test makes them.
   */
  it('calls the bundle and the running app the same thing', () => {
    expect(PACKAGE_JSON.productName).toBe('Statusky')
    expect(config.packagerConfig?.name).toBe(PACKAGE_JSON.productName)
  })

  /**
   * And the third place the name is written down: the XDG autostart entry's `Name=`,
   * which is what a Linux session's startup-applications list shows. It cannot be
   * imported from src/main/login-item.ts — that module reaches for `electron` — so it is
   * read as text, which is enough to catch the rename that only changes two of the three.
   */
  it('names itself the same thing in the Linux autostart entry', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'login-item.ts'), 'utf8')

    expect(source).toContain(`const PRODUCT_NAME = '${String(PACKAGE_JSON.productName)}'`)
  })

  /**
   * Flipping a fuse means rewriting bytes inside the Electron binary, and on macOS that
   * invalidates whatever code signature is on it. Anything doing the flipping therefore
   * has to be sequenced against `osxSign` and against @electron/packager's own late
   * rewrites of `Info.plist` — the ordering problem that left local builds reporting
   * `Info.plist=not bound` and losing Keychain access with it. Shipping the wire
   * untouched removes the problem rather than sequencing it.
   */
  it('flips no fuses, so every one of them is whatever Electron shipped', () => {
    expect(config.plugins ?? []).toEqual([])
  })

  /**
   * The incident the fuse wire is watched for: with cookie encryption on, Chromium will
   * not open the cookie store until the browser process has fetched a Safe Storage key
   * from the macOS Keychain, which an ad-hoc-signed bundle cannot do without a modal
   * prompt nobody answers. Every WebSocket handshake reads cookies before it sends, so
   * all ten stream checks timed out in a packaged build while the HTTP checks —
   * `credentials: 'omit'`, so never near the cookie store — passed.
   *
   * Electron ships this fuse off, so there is nothing to turn off. This test is here for
   * the upgrade that changes that default: it fails on the `npm install` that introduces
   * it rather than on somebody's Mac a release later.
   */
  it('leaves cookie encryption off, so nothing waits on the Keychain to reach the network', async () => {
    const wire = await getCurrentFuseWire(ELECTRON_BINARY)
    expect(isOn(wire[FuseV1Options.EnableCookieEncryption])).toBe(false)
  })
})
