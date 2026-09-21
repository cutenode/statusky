import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Configuration, WindowsConfiguration } from 'electron-builder'

import { assertProductionWiring } from './src/main/packed-wiring'

// Derived from electron-builder rather than imported from `app-builder-lib`, so
// the type always matches the version electron-builder itself depends on.
type AzureSignOptions = NonNullable<WindowsConfiguration['azureSignOptions']>

/**
 * Whether a Developer ID certificate is reachable for this build.
 *
 * In CI the certificate arrives as a base64 .p12 in `CSC_LINK` (with
 * `CSC_KEY_PASSWORD`); electron-builder imports it into a throwaway keychain
 * itself. Locally it has to already be in the keychain.
 *
 * When nothing is available we fall back to ad-hoc signing rather than leaving
 * the bundle unsigned: electron-builder 26 has no automatic fallback, and an
 * unsigned bundle will not launch on Apple silicon at all.
 */
function findMacSigningIdentity(): 'developer-id' | 'ad-hoc' {
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_IDENTITY) {
    return 'developer-id'
  }

  if (process.platform !== 'darwin' || process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    return 'ad-hoc'
  }

  try {
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    })
    return identities.includes('Developer ID Application') ? 'developer-id' : 'ad-hoc'
  } catch {
    return 'ad-hoc'
  }
}

/**
 * One of the three credential sets @electron/notarize accepts. Notarisation is
 * skipped without them, so this only decides whether we warn about it.
 */
function hasNotarizationCredentials(): boolean {
  const env = process.env
  return Boolean(
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
    (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) ||
    (env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE)
  )
}

/**
 * Pin the designated requirement to our own team, so a bundle signed by anyone
 * else cannot pass as Statusky. Needs the team ID, so it is skipped when
 * `APPLE_TEAM_ID` is unset.
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
 * Windows code signing through Azure Trusted Signing.
 *
 * Authentication is not handled here: electron-builder's TrustedSigning module
 * picks up an Entra ID service principal from `AZURE_TENANT_ID`,
 * `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. This only says which account and
 * certificate profile to sign with.
 *
 * Returns `undefined` when none of the variables are set, so local and CI
 * builds produce unsigned Windows artifacts instead of failing.
 */
function getWindowsSignOptions(): AzureSignOptions | undefined {
  const {
    AZURE_CODE_SIGNING_ENDPOINT: endpoint,
    AZURE_CODE_SIGNING_ACCOUNT_NAME: codeSigningAccountName,
    AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME: certificateProfileName,
    AZURE_CODE_SIGNING_PUBLISHER_NAME: publisherName
  } = process.env

  if (!endpoint && !codeSigningAccountName && !certificateProfileName && !publisherName) {
    return undefined
  }

  if (!endpoint || !codeSigningAccountName || !certificateProfileName || !publisherName) {
    throw new Error(
      'Azure Trusted Signing is only partially configured. Set all of ' +
        'AZURE_CODE_SIGNING_ENDPOINT, AZURE_CODE_SIGNING_ACCOUNT_NAME, ' +
        'AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME and ' +
        'AZURE_CODE_SIGNING_PUBLISHER_NAME, or none of them.'
    )
  }

  return { endpoint, codeSigningAccountName, certificateProfileName, publisherName }
}

const macIdentity = findMacSigningIdentity()
const teamId = process.env.APPLE_TEAM_ID

if (macIdentity === 'developer-id' && !hasNotarizationCredentials()) {
  console.warn(
    'Signing with a Developer ID certificate but notarization credentials are ' +
      'missing — the build will be signed and not notarized, and Gatekeeper ' +
      'will still refuse it on other Macs. Set APPLE_API_KEY, APPLE_API_KEY_ID ' +
      'and APPLE_API_ISSUER to notarize.'
  )
}

const config: Configuration = {
  appId: 'community.statusky.app',
  productName: 'Statusky',
  copyright: 'Copyright © 2026 Statusky contributors',

  directories: {
    output: 'release',
    buildResources: 'build'
  },

  files: ['out/**/*', 'package.json', '!**/*.map'],

  // `out/` is packed exactly as it is, and nothing on the way here rebuilds it. A build
  // with development IPC wiring would refuse every IPC call once packaged, so check the
  // bundle itself, not `src/ipc`, which can be newer than `out/`. `beforePack` is the
  // earliest hook that runs on every pack: `beforeBuild` only runs when dependencies are
  // rebuilt. It runs once per architecture, which costs a few hundred kilobytes of reading.
  beforePack: (context) => assertProductionWiring(context.packager.info.appDir),

  extraResources: [{ from: 'resources', to: 'assets', filter: ['**/*.png'] }],

  asar: true,

  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }
    ],
    icon: 'build/icon.png',
    // A menu bar app has no Dock presence and no windows of its own.
    extendInfo: {
      LSUIElement: true,
      NSUserNotificationAlertStyle: 'alert'
    },
    // Entitlements come from build/entitlements.mac.plist and
    // build/entitlements.mac.inherit.plist, which electron-builder picks up
    // from buildResources by name.
    hardenedRuntime: true,
    gatekeeperAssess: false,
    // Undefined lets electron-builder find the Developer ID certificate in the
    // keychain (or import CSC_LINK); '-' is an explicit ad-hoc signature, which
    // is what makes an unnotarized local build runnable on this machine.
    identity: macIdentity === 'developer-id' ? undefined : '-',
    requirements: macIdentity === 'developer-id' && teamId ? writeRequirements(teamId) : null,
    // A no-op unless the credentials above are present; @electron/notarize is
    // only reached after the bundle has actually been signed.
    notarize: macIdentity === 'developer-id',
    timestamp: macIdentity === 'developer-id' ? 'http://timestamp.apple.com/ts01' : undefined
  },

  dmg: {
    artifactName: '${productName}-${version}-${arch}.${ext}'
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    icon: 'build/icon.png',
    azureSignOptions: getWindowsSignOptions()
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false
  },

  linux: {
    target: ['AppImage', 'deb'],
    icon: 'build/icon.png',
    category: 'Network',
    desktop: {
      entry: {
        StartupNotify: 'false'
      }
    }
  },

  publish: null
}

export default config
