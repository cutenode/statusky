import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MakerDeb } from '@electron-forge/maker-deb'
import { MakerDMG } from '@electron-forge/maker-dmg'
import { MakerSquirrel, type MakerSquirrelConfig } from '@electron-forge/maker-squirrel'
import { MakerZIP } from '@electron-forge/maker-zip'
import { PublisherGithub } from '@electron-forge/publisher-github'
import type { ForgeConfig } from '@electron-forge/shared-types'
import type { MakerAppImageConfig } from '@reforged/maker-appimage'

import { assertProductionWiring } from './src/main/packed-wiring'

/**
 * Forge packages, signs and publishes; `electron-vite` still builds. Nothing here
 * compiles anything — `out/` arrives already built by `npm run build`, and the
 * `packageAfterCopy` hook below refuses to go on if it was built from the wrong IPC
 * wiring.
 *
 * This file is loaded by jiti, inside a `"type": "module"` package, so there is no
 * `__dirname` to lean on. Forge resolves the config relative to the project directory
 * and is only ever run from there, so `process.cwd()` is the repository root.
 */
const root = process.cwd()

/**
 * electron-builder's `productName`. @electron/packager names the bundle and, on every
 * platform, the executable inside it after this — where electron-builder used
 * `productName` for the macOS and Windows executables but `name` for the Linux one.
 * Both Linux makers therefore have to be told the executable is capitalised, or they
 * look for `statusky` beside an app that only contains `Statusky` and stop.
 */
const PRODUCT_NAME = 'Statusky'

/**
 * The OS-level URL scheme, registered three different ways because the three platforms
 * register it three different ways. See src/main/deep-link.ts for the URL shapes and for
 * why a `statusky://` link is a completely different, untrusted thing from the
 * `app://statusky` origin the popover's own page is served from.
 *
 * macOS: `packagerConfig.protocols` below writes `CFBundleURLTypes` into the bundle's
 * Info.plist, and Launch Services picks it up when the app is first seen.
 *
 * Linux: `MimeType=x-scheme-handler/statusky` in the `.desktop` file, which is what
 * `xdg-open` reads. Both Linux makers need telling separately, and the deb maker's
 * template is the vendored `build/desktop.ejs` — which already renders `MimeType=` when
 * it is given one, so nothing there needs changing.
 *
 * Windows: not here at all. Forge writes no registry entries, and a Squirrel installer
 * has nowhere to put them; the running app claims the scheme itself on every launch. See
 * `registerProtocolClient`.
 */
const URL_SCHEME = 'statusky'
const LINUX_MIME_TYPES = [`x-scheme-handler/${URL_SCHEME}` as const]

// Derived from the config type rather than imported from `@electron/packager`,
// `@electron/osx-sign` and `@electron/windows-sign`, so each one always matches the
// version the installed Forge actually depends on.
type PackagerOptions = NonNullable<ForgeConfig['packagerConfig']>
type MacSignOptions = Exclude<NonNullable<PackagerOptions['osxSign']>, true>
type MacSignFileOptions = ReturnType<NonNullable<MacSignOptions['optionsForFile']>>
type MacNotarizeOptions = NonNullable<PackagerOptions['osxNotarize']>
type WindowsSignOptions = Exclude<NonNullable<PackagerOptions['windowsSign']>, true>
type WindowsSignHash = NonNullable<WindowsSignOptions['hashes']>[number]

/**
 * What ends up inside the asar.
 *
 * electron-builder took an allowlist — `files: ['out/**', 'package.json', '!**\/*.map']`.
 * `@electron/packager` has no such thing: `ignore` is a list of regular expressions
 * matched against every path relative to the project root, so it can only say what to
 * leave out. Writing that as a blocklist of the directories that happen to exist today
 * (`src/`, `schemas/`, `coverage/`, `release/`, `build/`, the config files) would ship
 * the next one somebody adds without anyone noticing — a scratch directory, a dotfile
 * with credentials in it, the 39k README. So it is turned back into an allowlist by a
 * negative lookahead: everything at the top level goes, except the three entries a
 * packaged app actually needs.
 *
 * `node_modules` is one of them because `externalizeDepsPlugin` deliberately leaves
 * `electron-store` out of the main bundle, so it has to be loaded from `node_modules`
 * at runtime. `prune` (on by default) then walks the real dependency graph and drops
 * the devDependencies, which is why keeping the whole directory here is not the same as
 * shipping it.
 *
 * Pruning only knows about packages, though, and the dot-directories under
 * `node_modules` are not packages — they are tooling's own bookkeeping, and `.vite`
 * alone is six megabytes of pre-bundled renderer dependencies that the packaged app
 * never reads. packager excludes `.bin` by default and nothing else, so the rest are
 * named here.
 *
 * The last pattern drops source maps, as the electron-builder config did. They are
 * dead weight in a shipped build, and their embedded sources can show IPC wiring the
 * code beside them no longer has.
 */
const IGNORED_PATHS = [
  /^\/(?!out($|\/)|node_modules($|\/)|package\.json$)/,
  /^\/node_modules\/\./,
  /\.map$/
]

/**
 * Entitlements, by the file being signed.
 *
 * electron-builder found `build/entitlements.mac.plist` and
 * `build/entitlements.mac.inherit.plist` in `buildResources` by name and applied this
 * rule itself. Forge auto-discovers neither, so it is spelled out: Electron's helper
 * bundles inherit the app's sandbox and need the looser set, and getting it wrong shows
 * up as helper processes that refuse to start under the hardened runtime — which, for a
 * menu bar app with no window, looks like nothing happening at all.
 */
const ENTITLEMENTS = join(root, 'build', 'entitlements.mac.plist')
const INHERITED_ENTITLEMENTS = join(root, 'build', 'entitlements.mac.inherit.plist')
const HELPER_BUNDLE = /\((?:Plugin|GPU|Renderer)\)\.app/

/**
 * Whether a Developer ID certificate is meant to be used for this build.
 *
 * In CI the certificate arrives as a base64 .p12 in `CSC_LINK` (with
 * `CSC_KEY_PASSWORD`). electron-builder imported that into a throwaway keychain by
 * itself; Forge has no equivalent anywhere in the stack, so `CSC_LINK` is now only
 * taken as a statement of intent — the certificate has to already be in a keychain by
 * the time this runs, which on a GitHub runner means a step like
 * `apple-actions/import-codesign-certs` before the build. Left as a signal rather than
 * dropped, because the alternative is a release that ad-hoc signs itself in silence.
 */
function wantsDeveloperId(): boolean {
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_IDENTITY) {
    return true
  }

  if (process.platform !== 'darwin' || process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    return false
  }

  try {
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    })
    return identities.includes('Developer ID Application')
  } catch {
    return false
  }
}

/**
 * Pin the designated requirement to our own team, so a bundle signed by anyone else
 * cannot pass as Statusky. Needs the team ID, so it is skipped when `APPLE_TEAM_ID` is
 * unset.
 */
function writeRequirements(teamId: string): string {
  const path = join(tmpdir(), 'statusky-designated-requirement.txt')
  writeFileSync(
    path,
    'designated => anchor apple generic and ' +
      'certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and ' +
      'certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and ' +
      `certificate leaf[subject.OU] = ${teamId}\n`
  )
  return path
}

/**
 * Developer ID signing, for a release build.
 */
function developerIdSigningOptions(): MacSignOptions {
  const teamId = process.env.APPLE_TEAM_ID
  const requirements = teamId ? writeRequirements(teamId) : undefined

  return {
    // Left unset, @electron/osx-sign finds the Developer ID Application identity in the
    // keychain itself, which is what a developer machine wants.
    identity: process.env.CSC_NAME ?? process.env.CSC_IDENTITY,
    // v1 of @electron/osx-sign — which Forge 7.11 pins, through @electron/packager 18 —
    // passes one argument here, and takes the hardened runtime, the requirements and the
    // timestamp per file rather than once for the whole bundle.
    optionsForFile: (filePath: string): MacSignFileOptions => ({
      entitlements: HELPER_BUNDLE.test(filePath) ? INHERITED_ENTITLEMENTS : ENTITLEMENTS,
      hardenedRuntime: true,
      requirements,
      timestamp: 'http://timestamp.apple.com/ts01'
    })
  }
}

/**
 * Ad-hoc signing, for a build with no certificate behind it.
 *
 * electron-builder spelled this `identity: '-'`. `@electron/osx-sign` documents no
 * ad-hoc mode, but the same string with `identityValidation: false` skips the keychain
 * lookup and hands the `-` straight to `codesign --sign`, which is that.
 *
 * Leaving `osxSign` off entirely — the obvious reading of "no certificate, no signing
 * config" — is not the same thing and is not enough. Nothing else in the pipeline signs:
 * an unsigned bundle reports `Identifier=com.github.Electron` and has no seal at all.
 * Signing has to happen after @electron/packager's last write to the bundle — it renames
 * the app and writes `ElectronAsarIntegrity` into `Info.plist` late — and a signature
 * applied before that comes out stale, failing `codesign --verify --strict` with
 * `invalid Info.plist (plist or signature have been modified)`. packager runs `osxSign`
 * last, after every rewrite it makes, so signing from here is the placement that
 * survives. A `postPackage` hook is not needed and was removed.
 *
 * None of that is cosmetic: macOS refuses Keychain access to a bundle whose signature
 * does not verify, so `safeStorage.isEncryptionAvailable()` came back false in every
 * locally packaged build and `src/main/store.ts` silently took its documented fallback
 * of writing the webhook endpoint secret to `statusky.json` in the clear. An ad-hoc
 * signature is still not a certificate — Gatekeeper on another machine refuses it — but
 * it is a valid seal, and the secret stays sealed with it. The same seal is what lets a
 * local build ask for notifications at all: an unsealed bundle is refused by
 * `usernotificationsd` before any permission prompt, which is the problem
 * `scripts/seal-dev-electron.mjs` solves for `npm run dev`.
 */
function adHocSigningOptions(): MacSignOptions {
  return {
    identity: '-',
    // `-` is not an identity that exists in any keychain, so validating it only fails.
    identityValidation: false,
    optionsForFile: (filePath: string): MacSignFileOptions => ({
      entitlements: HELPER_BUNDLE.test(filePath) ? INHERITED_ENTITLEMENTS : ENTITLEMENTS,
      // The same hardened runtime a release build gets, so a local build runs under the
      // constraints the entitlements above are there to relax rather than under none.
      hardenedRuntime: true,
      // A trusted timestamp needs a certificate behind it, and an ad-hoc signature
      // cannot carry one. Left unset, osx-sign passes a bare `--timestamp` instead,
      // which is a round trip to Apple's timestamp server for every file in the bundle
      // in exchange for nothing.
      timestamp: 'none'
    })
  }
}

/**
 * Which of the two a build gets, if either.
 *
 * There is no `gatekeeperAssess` equivalent, and none is wanted: it only ever told
 * electron-builder not to run `spctl` against its own output.
 */
function macSigningOptions(withDeveloperId: boolean): MacSignOptions | undefined {
  if (withDeveloperId) return developerIdSigningOptions()

  // Ad-hoc signing shells out to `codesign`, which only exists on a Mac. A darwin
  // bundle cross-packaged from Linux or Windows therefore stays unsigned, as it was
  // before; a build that meant to use a certificate is not quietly downgraded here,
  // because `wantsDeveloperId` has already said so and packager will fail loudly.
  if (process.platform !== 'darwin') return undefined

  return adHocSigningOptions()
}

/**
 * One of the three credential sets @electron/notarize accepts, or nothing. Notarisation
 * is skipped without them, and packager will not notarize an unsigned bundle anyway, so
 * this only decides whether we warn.
 */
function macNotarizeOptions(): MacNotarizeOptions | undefined {
  const env = process.env

  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return {
      appleApiKey: env.APPLE_API_KEY,
      appleApiKeyId: env.APPLE_API_KEY_ID,
      appleApiIssuer: env.APPLE_API_ISSUER
    }
  }

  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return {
      appleId: env.APPLE_ID,
      appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: env.APPLE_TEAM_ID
    }
  }

  if (env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE) {
    return { keychain: env.APPLE_KEYCHAIN, keychainProfile: env.APPLE_KEYCHAIN_PROFILE }
  }

  return undefined
}

/**
 * The credentials Azure Trusted Signing's dlib reads, as a file, because that is the
 * only way signtool takes them. `ExcludeCredentials` narrows `DefaultAzureCredential`
 * to the service principal in the environment: without it a developer who happens to be
 * signed in to the Azure CLI would sign with whatever identity that session has, which
 * is the sort of thing nobody notices until a release is signed by the wrong account.
 */
function writeAzureMetadata(
  endpoint: string,
  codeSigningAccountName: string,
  certificateProfileName: string
): string {
  const path = join(tmpdir(), 'statusky-azure-trusted-signing.json')
  writeFileSync(
    path,
    JSON.stringify(
      {
        Endpoint: endpoint,
        CodeSigningAccountName: codeSigningAccountName,
        CertificateProfileName: certificateProfileName,
        ExcludeCredentials: [
          'ManagedIdentityCredential',
          'SharedTokenCacheCredential',
          'VisualStudioCredential',
          'VisualStudioCodeCredential',
          'AzureCliCredential',
          'AzurePowerShellCredential',
          'AzureDeveloperCliCredential',
          'InteractiveBrowserCredential'
        ]
      },
      null,
      2
    )
  )
  return path
}

/**
 * Windows code signing through Azure Trusted Signing.
 *
 * electron-builder had a TrustedSigning module that knew how to do this; Forge reaches
 * `@electron/windows-sign` 1.x, which only knows how to run signtool. Two things that
 * used to be somebody else's problem therefore become ours. First, the `signtool.exe`
 * vendored inside windows-sign predates `/dlib`, so the build has to be pointed at one
 * from Windows SDK 10.0.22621.755 or newer via `WINDOWS_SIGNTOOL_PATH`. Second, the
 * dlib itself — `Azure.CodeSigning.Dlib.dll`, from the Microsoft.Trusted.Signing.Client
 * package — has to be fetched and its path given as `AZURE_CODE_SIGNING_DLIB`.
 *
 * `signWithParams` is given as an array rather than a string on purpose: windows-sign
 * splits a string on whitespace without honouring quotes (electron/windows-sign#45), so
 * any path with a space in it silently becomes two arguments and signtool fails with an
 * error that names neither.
 *
 * Authentication is still not handled here: the dlib picks up an Entra ID service
 * principal from `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`.
 *
 * Returns `undefined` when none of the variables are set, so local and CI builds
 * produce unsigned Windows artifacts instead of failing.
 */
function windowsSignOptions(): WindowsSignOptions | undefined {
  const {
    AZURE_CODE_SIGNING_ENDPOINT: endpoint,
    AZURE_CODE_SIGNING_ACCOUNT_NAME: codeSigningAccountName,
    AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME: certificateProfileName,
    AZURE_CODE_SIGNING_DLIB: dlib,
    WINDOWS_SIGNTOOL_PATH: signToolPath
  } = process.env

  if (!endpoint && !codeSigningAccountName && !certificateProfileName && !dlib && !signToolPath) {
    return undefined
  }

  if (!endpoint || !codeSigningAccountName || !certificateProfileName || !dlib || !signToolPath) {
    throw new Error(
      'Azure Trusted Signing is only partially configured. Set all of ' +
        'AZURE_CODE_SIGNING_ENDPOINT, AZURE_CODE_SIGNING_ACCOUNT_NAME, ' +
        'AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME, AZURE_CODE_SIGNING_DLIB and ' +
        'WINDOWS_SIGNTOOL_PATH, or none of them.'
    )
  }

  return {
    signToolPath,
    signWithParams: [
      '/dlib',
      dlib,
      '/dmdf',
      writeAzureMetadata(endpoint, codeSigningAccountName, certificateProfileName)
    ],
    timestampServer: 'http://timestamp.acs.microsoft.com',
    // `hashes` is typed as an ambient `const enum`, whose members `isolatedModules`
    // forbids reading, so the string the enum is built from is asserted into place —
    // once `satisfies` has checked that it is one of the enum's values.
    hashes: ['sha256' satisfies `${WindowsSignHash}` as WindowsSignHash],
    // signtool's /a would pick a certificate out of the local store; the dlib supplies
    // the certificate, and letting signtool guess instead is how a build ends up signed
    // by a stale developer certificate somebody left installed.
    automaticallySelectCertificate: false
  }
}

const signWithDeveloperId = wantsDeveloperId()
const osxSign = macSigningOptions(signWithDeveloperId)
// Only a Developer ID build is notarizable; Apple will not take an ad-hoc one, and
// packager skips notarization for it regardless.
const osxNotarize = signWithDeveloperId ? macNotarizeOptions() : undefined
// Resolved once: it writes the credential file, and it throws on a half-configured
// environment, neither of which wants doing twice.
const windowsSign = windowsSignOptions()

if (signWithDeveloperId && !osxNotarize) {
  console.warn(
    'Signing with a Developer ID certificate but notarization credentials are ' +
      'missing — the build will be signed and not notarized, and Gatekeeper ' +
      'will still refuse it on other Macs. Set APPLE_API_KEY, APPLE_API_KEY_ID ' +
      'and APPLE_API_ISSUER to notarize.'
  )
}

const config: ForgeConfig = {
  // Forge's default is `out/`, which is where electron-vite builds the app. Packaging
  // into it would have Forge writing its staged bundles on top of its own input.
  // `release/` is what the electron-builder config used.
  outDir: 'release',

  packagerConfig: {
    name: PRODUCT_NAME,
    appBundleId: 'community.statusky.app',
    appCategoryType: 'public.app-category.developer-tools',
    appCopyright: 'Copyright © 2026 Statusky contributors',

    // @electron/packager swaps this extension for the one the platform wants — .icns on
    // macOS, .ico on Windows — and does not convert anything, where electron-builder
    // rendered both from build/icon.png. Neither file exists yet, so packager warns and
    // ships Electron's own icon. Pointed at the stem regardless, so that generating
    // build/icon.icns and build/icon.ico is all it takes to fix.
    icon: join(root, 'build', 'icon'),

    asar: true,
    prune: true,
    ignore: IGNORED_PATHS,

    // @electron/packager copies each extra resource to `path.basename(resource)` inside
    // the bundle's resources directory. There is no `to:` to rename with and no
    // `filter:` to narrow with, so electron-builder's `{ from: 'resources', to: 'assets' }`
    // cannot be expressed — the directory keeps its own name, and `src/main/tray.ts`
    // looks for it under that name instead. The whole tray depends on this agreeing.
    extraResource: ['resources'],

    // What macOS registers with Launch Services, so that `open statusky://network`
    // reaches this app rather than nothing at all. `name` is what the OS shows when it
    // asks whether to allow the app to open the link.
    protocols: [{ name: PRODUCT_NAME, schemes: [URL_SCHEME] }],

    // A menu bar app has no Dock presence and no windows of its own.
    extendInfo: {
      LSUIElement: true,
      NSUserNotificationAlertStyle: 'alert'
    },

    osxSign,
    osxNotarize,
    windowsSign
  },

  hooks: {
    // `out/` is packed exactly as it is, and nothing on the way here rebuilds it. A
    // build with development IPC wiring would refuse every IPC call once packaged, so
    // check the bundle itself, not `src/ipc`, which can be newer than `out/`.
    //
    // `packageAfterCopy` hands over packager's staged application directory — the bytes
    // that are about to be asar'd — which is a stricter thing to inspect than the
    // repository electron-builder's `beforePack` pointed at. `prePackage` is no use
    // (no path argument) and `generateAssets` would also run on `electron-forge start`.
    // It runs once per architecture, which costs a few hundred kilobytes of reading.
    packageAfterCopy: async (_forgeConfig, buildPath) => assertProductionWiring(buildPath)
  },

  makers: [
    // Named `${appName}-${version}-${arch}.dmg` by the maker itself, which is what
    // electron-builder's artifactName template spelled out.
    new MakerDMG({}, ['darwin']),
    new MakerZIP({}, ['darwin']),

    // Squirrel.Windows in place of NSIS. It cannot be asked for a non-one-click
    // installer, a choosable install directory, or no desktop shortcut; see the
    // README's "Building a distributable" for what that costs.
    //
    // The cast is TypeScript's, not ours: @electron/packager reaches
    // @electron/windows-sign through its ESM entry and electron-winstaller through its
    // CommonJS one, so the `hashes` enum is declared twice and the two declarations are
    // not interchangeable by name. It is the same object either way.
    // `setupIcon` is the installer's own chrome — the Setup.exe's icon and the entry
    // in Add/Remove Programs — and is separate from the icon packager bakes into the
    // app. Squirrel reads .ico only, which is why build/icon.ico is generated at all.
    new MakerSquirrel(
      {
        setupIcon: join(root, 'build', 'icon.ico'),
        windowsSign: windowsSign as MakerSquirrelConfig['windowsSign']
      },
      ['win32']
    ),

    new MakerDeb(
      {
        options: {
          // Both of these default to `package.json`'s lowercase `name`, which is the
          // package name and the `/usr/bin` symlink but not the executable packager
          // wrote. Left alone, the maker fails looking for a binary that is not there.
          bin: PRODUCT_NAME,
          productName: PRODUCT_NAME,
          categories: ['Network'],
          mimeType: LINUX_MIME_TYPES,
          icon: join(root, 'build', 'icon.png'),
          // The only way to reach StartupNotify; see build/desktop.ejs for why.
          desktopTemplate: join(root, 'build', 'desktop.ejs')
        }
      },
      ['linux']
    ),

    // @reforged/maker-appimage is ESM-only, and this config is loaded by jiti into a
    // CommonJS-shaped world. Forge resolves a maker named by string at the point it
    // actually needs it, which is the one place an ESM-only package loads cleanly, so
    // this one is never imported at the top of the file. Its config type is, because
    // `import type` is erased before jiti sees it, and Forge types `config` as `any`.
    {
      name: '@reforged/maker-appimage',
      platforms: ['linux'],
      config: {
        options: {
          // As above: this maker takes its display name from Forge but still derives
          // the executable it looks for from `package.json`'s `name`.
          bin: PRODUCT_NAME,
          categories: ['Network'],
          mimeType: LINUX_MIME_TYPES,
          icon: join(root, 'build', 'icon.png')
        }
      } satisfies MakerAppImageConfig
    }
  ],

  publishers: [
    new PublisherGithub({
      // Must stay in step with `package.json`'s `repository` field: that is what
      // `update-electron-app` reads to find the feed, and update.electronjs.org only
      // serves public repositories.
      repository: { owner: 'cutenode', name: 'statusky' },
      // Releases go up as drafts, so a mistaken publish is retractable rather than
      // already downloaded.
      draft: true
    })
  ]
}

export default config
