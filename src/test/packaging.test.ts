/**
 * What a packaged build ships with that no other test can see.
 *
 * Every test here runs unpackaged, against a doubled Electron, where a fuse is a byte in a
 * binary nobody built. So this checks the things that can be checked from here: that
 * `forge.config.ts` asks for the fuse wire it means to, that its hook really writes that
 * wire into the Electron this project builds against, that it refuses a macOS package it
 * could not re-sign, and that it refuses a wire with a fuse nobody has decided about.
 * Worth it, because the cost of getting a fuse wrong is only ever paid by a real package on
 * a real machine, and the last time it was paid it looked like a protocol bug in the
 * firehose decoder.
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { describe, expect, it } from 'vitest'
import config, { flipPackagedFuses, packagedFuses } from '../../forge.config'

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

/** On macOS the wire is in the framework, not the executable that `path.txt` names. */
const FRAMEWORK = ['Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework']
const INSTALLED_WIRE_FILE =
  process.platform === 'darwin'
    ? join(ELECTRON_DIST, 'dist', 'Electron.app', ...FRAMEWORK)
    : ELECTRON_BINARY

/**
 * An Electron that packager has just unzipped, as the `packageAfterExtract` hook is handed
 * it: nothing has been renamed yet, so the names are still Electron's own.
 */
function unzippedElectron(buildPath: string): string {
  if (process.platform === 'darwin') return join(buildPath, 'Electron.app')
  return join(buildPath, process.platform === 'win32' ? 'electron.exe' : 'electron')
}

/** And the file in it that holds the wire. */
function unzippedWireFile(buildPath: string): string {
  const electron = unzippedElectron(buildPath)
  return process.platform === 'darwin' ? join(electron, ...FRAMEWORK) : electron
}

/**
 * The fuse wire follows this sentinel, which Electron's build writes into the binary and
 * `@electron/fuses` searches for without exporting. After it come a version byte, a
 * length byte, and one byte per fuse.
 */
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')

let installed: Promise<Buffer> | undefined

/**
 * Just the sentinel and the wire, cut out of the installed binary: everything
 * `@electron/fuses` reads or writes, without copying two hundred megabytes of Electron
 * Framework into a temporary directory to get at forty bytes of it.
 */
function installedWire(): Promise<Buffer> {
  installed ??= readFile(INSTALLED_WIRE_FILE).then((binary) => {
    const start = binary.indexOf(SENTINEL)
    if (start === -1) throw new Error(`No fuse wire in ${INSTALLED_WIRE_FILE}`)
    const length = binary[start + SENTINEL.length + 1] ?? 0
    return Buffer.from(binary.subarray(start, start + SENTINEL.length + 2 + length))
  })
  return installed
}

/** A fuse in the wire is stored as an ASCII digit: `'1'` on, `'0'` off. */
function isOn(state: number | undefined): boolean {
  return state === FuseState.ENABLE
}

/** Whether each fuse in a wire is on, in wire order. */
function fusesOf(wire: Buffer): boolean[] {
  return [...wire.subarray(SENTINEL.length + 2)].map(isOn)
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
})

describe('the fuse wire', () => {
  /**
   * Flipping a fuse rewrites bytes inside the Electron binary, and on macOS that
   * invalidates the signature on it. `@electron-forge/plugin-fuses` re-signs ad hoc in the
   * middle of packaging, before @electron/packager's own late rewrites of `Info.plist` —
   * the ordering problem that once left local builds reporting `Info.plist=not bound` and
   * losing Keychain access with it. `forge.config.ts` flips the wire itself, on the
   * Electron packager has only just unzipped, and lets `osxSign` re-sign everything last.
   * A plugin that also touched the binary would bring the ordering problem back.
   */
  it('is flipped by forge.config.ts itself, before packaging, with no plugin re-signing', () => {
    expect(config.plugins ?? []).toEqual([])
    expect(config.hooks?.packageAfterExtract).toBeTypeOf('function')
  })

  /**
   * The four doors — running as Node, `NODE_OPTIONS`, `--inspect`, and extra powers for
   * `file://` pages — closed everywhere, and the app only ever loaded from its asar.
   * Integrity validation needs a hash packager only records for macOS and Windows.
   * WebAssembly keeps its trap handlers, as shipped.
   */
  it.each(['darwin', 'mas', 'win32', 'linux'])('closes everything it can on %s', (platform) => {
    const fuses = packagedFuses(platform)

    expect(fuses[FuseV1Options.RunAsNode]).toBe(false)
    expect(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false)
    expect(fuses[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false)
    expect(fuses[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(false)
    expect(fuses[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true)
    expect(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(platform !== 'linux')
    expect(fuses[FuseV1Options.WasmTrapHandlers]).toBe(true)
  })

  /**
   * Every fuse `@electron/fuses` can name is given a value, none is left to inherit, and
   * the library is told to refuse a wire with any fuse beyond them.
   */
  it.each(['darwin', 'mas', 'win32', 'linux'])('decides every fuse on %s', (platform) => {
    const fuses = packagedFuses(platform)
    const named = Object.values(FuseV1Options).filter((value) => typeof value === 'number')

    expect(fuses.strictlyRequireAllFuses).toBe(true)
    for (const fuse of named) expect(fuses[fuse], FuseV1Options[fuse]).toBeTypeOf('boolean')
  })

  /**
   * The incident the wire was first watched for: with cookie encryption on, Chromium will
   * not open the cookie store until the browser process has fetched a Safe Storage key
   * from the macOS Keychain, which an ad-hoc-signed bundle cannot do without a modal
   * prompt nobody answers. Every WebSocket handshake reads cookies before it sends, so
   * all ten stream checks timed out in a packaged build while the HTTP checks —
   * `credentials: 'omit'`, so never near the cookie store — passed.
   *
   * Electron ships it off. The config says so too rather than inheriting it, so an
   * upgrade that changes the default changes nothing here.
   */
  it.each(['darwin', 'mas', 'win32', 'linux'])(
    'keeps cookie encryption off on %s, so nothing waits on the Keychain to reach the network',
    (platform) => {
      expect(packagedFuses(platform)[FuseV1Options.EnableCookieEncryption]).toBe(false)
    }
  )

  it('writes that wire into the Electron this project builds against', async () => {
    const shipped = await installedWire()
    const buildPath = await mkdtemp(join(tmpdir(), 'statusky-fuses-'))
    const file = unzippedWireFile(buildPath)
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, shipped)

      await flipPackagedFuses(buildPath, process.platform, true)

      expect(fusesOf(await readFile(file))).toEqual([
        false, // RunAsNode
        false, // EnableCookieEncryption
        false, // EnableNodeOptionsEnvironmentVariable
        false, // EnableNodeCliInspectArguments
        process.platform !== 'linux', // EnableEmbeddedAsarIntegrityValidation
        true, // OnlyLoadAppFromAsar
        false, // LoadBrowserProcessSpecificV8Snapshot
        false, // GrantFileProtocolExtraPrivileges
        true // WasmTrapHandlers
      ])
      expect(fusesOf(shipped)).not.toEqual(fusesOf(await readFile(file)))
      // And what `@electron/fuses` itself reads back agrees.
      const wire = await getCurrentFuseWire(unzippedElectron(buildPath))
      expect(isOn(wire[FuseV1Options.RunAsNode])).toBe(false)
    } finally {
      await rm(buildPath, { recursive: true, force: true })
    }
  })

  /**
   * A macOS build that nothing will sign afterwards would carry a framework whose
   * signature no longer matches its bytes, and Apple silicon refuses to run it. The
   * refusal comes before anything is read: the path given here does not exist, so a
   * check that came too late would fail with ENOENT instead.
   */
  it.each(['darwin', 'mas'])(
    'refuses to package for %s where nothing will re-sign it',
    async (platform) => {
      const nowhere = join(tmpdir(), 'statusky-fuses-never-created')

      await expect(flipPackagedFuses(nowhere, platform, false)).rejects.toThrow(
        'Package the macOS build on macOS.'
      )
    }
  )

  /**
   * A tenth fuse would arrive in some Electron upgrade with whatever default Electron
   * picked, and nobody here would have chosen it. `strictlyRequireAllFuses` turns that
   * into a packaging failure rather than a silent default: this hands the hook the real
   * wire with one more fuse on the end, and it refuses to write any of it.
   */
  it('refuses a wire with a fuse nobody has decided about', async () => {
    const shipped = await installedWire()
    const lengthAt = SENTINEL.length + 1
    const longer = Buffer.concat([shipped, Buffer.from([FuseState.ENABLE])])
    longer[lengthAt] = (shipped[lengthAt] ?? 0) + 1
    const buildPath = await mkdtemp(join(tmpdir(), 'statusky-fuses-'))
    const file = unzippedWireFile(buildPath)
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, longer)

      await expect(flipPackagedFuses(buildPath, process.platform, true)).rejects.toThrow(
        'strictlyRequireAllFuses'
      )
      expect(await readFile(file)).toEqual(longer)
    } finally {
      await rm(buildPath, { recursive: true, force: true })
    }
  })

  /**
   * And the Electron installed today has exactly the fuses `@electron/fuses` can name,
   * so the wire above is the one a packaged build really gets.
   */
  it('names every fuse in the installed Electron', async () => {
    const named = Object.values(FuseV1Options).filter((value) => typeof value === 'number')

    expect(fusesOf(await installedWire())).toHaveLength(named.length)
  })
})
