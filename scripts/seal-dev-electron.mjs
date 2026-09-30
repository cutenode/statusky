#!/usr/bin/env node
/**
 * Give `node_modules/electron/dist/Electron.app` a bundle signature, so `npm run dev` can
 * raise notifications on macOS.
 *
 * The Electron.app that npm installs is only linker-signed: each Mach-O carries an ad-hoc
 * signature the linker wrote, identifying itself as plain `Electron`, and nothing seals
 * the bundle around it. `Info.plist` is not bound to any signature, so when the process
 * tells `usernotificationsd` it is `com.github.Electron`, the daemon has no signature
 * that says so and refuses every call —
 *
 *   Entitlement 'com.apple.private.usernotifications.bundle-identifiers' required to
 *   request user notifications
 *   requestAuthorization not allowed: com.github.Electron
 *
 * — which reaches the app as `UNErrorDomain error 1`, whatever System Settings says.
 * It is not about certificates: a packaged build is ad-hoc signed too, and is granted
 * notifications, because packaging seals the whole bundle under its own identifier.
 * An ad-hoc `codesign` of the bundle does the same here.
 *
 * `npm install` puts the linker-signed bundle back whenever it re-extracts Electron, so
 * this is a `pre` step on `dev` and `start` rather than something done once. It checks
 * first and signs only a bundle that does not already verify, so it costs nothing on the
 * runs where there is nothing to do.
 *
 * Usage: node scripts/seal-dev-electron.mjs
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

if (process.platform !== 'darwin') process.exit(0)

// The `electron` package's main export is the path to the executable inside the bundle.
const executable = createRequire(import.meta.url)('electron')
const bundle = executable.slice(0, executable.indexOf('.app/') + '.app'.length)

function sealed() {
  try {
    execFileSync('codesign', ['--verify', '--strict', bundle], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!sealed()) {
  // `--deep` so the helper apps and frameworks inside are sealed under the same pass;
  // a bundle whose nested code does not verify does not verify either.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' })
  if (!sealed()) {
    console.error(`Could not seal ${bundle}; notifications will be refused in development.`)
    process.exit(1)
  }
  console.log('Sealed the development Electron.app so macOS will allow its notifications.')
}
