#!/usr/bin/env node
/**
 * Generates every icon the app ships with, so the binary assets in the repo are
 * reproducible from source rather than opaque blobs.
 *
 *   resources/trayTemplate.png / @2x   macOS template icon (black + alpha, auto-tinted)
 *   resources/trayIncident.png / @2x   coloured variant shown during an active incident
 *   resources/trayMonitoring.png / @2x coloured variant shown while recovering
 *   resources/trayBeat<n>.png / @2x    one cardiac cycle, played while updates are unread
 *   resources/icon.png                 512px window/Linux icon
 *   build/icon.png                     1024px source icon, taken as-is by the Linux makers
 *   build/icon.icns                    macOS app icon, every size Finder and the Dock ask for
 *   build/icon.ico                     Windows app icon, every size Explorer and the taskbar ask for
 *
 * Rendering is signed-distance-field based: shapes are described analytically and
 * sampled per pixel, which gives clean antialiasing down to 16x16.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Encode straight (non-premultiplied) RGBA pixels as a PNG. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ------------------------------------------------------------------- geometry

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Distance from p to the segment ab. */
function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const lenSq = abx * abx + aby * aby
  const t = lenSq === 0 ? 0 : clamp01((apx * abx + apy * aby) / lenSq)
  const dx = apx - abx * t
  const dy = apy - aby * t
  return Math.hypot(dx, dy)
}

function distToPolyline(px, py, points) {
  let best = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    const d = distToSegment(px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])
    if (d < best) best = d
  }
  return best
}

/** Signed distance to a rounded rectangle centred at (cx, cy). Negative inside. */
function sdRoundedRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius)
  const qy = Math.abs(py - cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r
}

/** Convert a signed distance to coverage, antialiased over roughly one pixel. */
function coverage(dist, feather) {
  return clamp01(0.5 - dist / feather)
}

// The pulse glyph, in unit coordinates (0..1). A flat baseline broken by one
// sharp spike reads as "monitoring" even at 16px.
const PULSE = [
  [0.05, 0.5],
  [0.28, 0.5],
  [0.35, 0.325],
  [0.44, 0.7],
  [0.53, 0.37],
  [0.6, 0.575],
  [0.66, 0.5],
  [0.95, 0.5]
]

// At 16px the app icon's four direction changes smear into a blob, so the tray
// uses a single spike: one clear up-stroke and one down-stroke.
const TRAY_PULSE = [
  [0.06, 0.5],
  [0.33, 0.5],
  [0.45, 0.19],
  [0.58, 0.81],
  [0.68, 0.5],
  [0.94, 0.5]
]

function blend(dst, i, r, g, b, a) {
  if (a <= 0) return
  const da = dst[i + 3] / 255
  const outA = a + da * (1 - a)
  if (outA <= 0) {
    dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0
    return
  }
  dst[i] = Math.round((r * a + dst[i] * (da / 255) * (1 - a) * 255) / outA)
  dst[i + 1] = Math.round((g * a + dst[i + 1] * (da / 255) * (1 - a) * 255) / outA)
  dst[i + 2] = Math.round((b * a + dst[i + 2] * (da / 255) * (1 - a) * 255) / outA)
  dst[i + 3] = Math.round(outA * 255)
}

// ---------------------------------------------------------------- tray icons

/**
 * Bare pulse glyph on transparent background.
 * `colour` of null produces a macOS template image (pure black + alpha).
 * `scale` shrinks or grows the glyph about the centre; the stroke keeps its
 * thickness so a small frame stays legible at 16px. `alpha` fades the whole
 * glyph, which is what carries the beat at menu bar size — a 16px shape can
 * only shrink so far before the change stops registering. `dot` adds the unread
 * badge, which is the quiet alternative to the beat.
 */
function renderTray(size, colour, scale = 1, alpha = 1, dot = false) {
  const rgba = Buffer.alloc(size * size * 4)
  const stroke = size * 0.06
  const feather = 1 / size
  const [r, g, b] = colour ?? [0, 0, 0]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sample in glyph space, then restore the canvas metric so the stroke
      // width and antialiasing stay independent of `scale`.
      const px = 0.5 + ((x + 0.5) / size - 0.5) / scale
      const py = 0.5 + ((y + 0.5) / size - 0.5) / scale
      const d = distToPolyline(px, py, TRAY_PULSE) * scale - stroke / size
      const a = coverage(d, feather) * alpha
      if (a > 0) blend(rgba, (y * size + x) * 4, r, g, b, a)

      if (dot) {
        // Top-right, clear of both the flat tail at y=0.5 and the spike's reach.
        const badge = coverage(sdCircle(px, py, BADGE[0], BADGE[1], BADGE[2]), feather) * alpha
        if (badge > 0) blend(rgba, (y * size + x) * 4, r, g, b, badge)
      }
    }
  }
  return encodePng(size, size, rgba)
}

/** The unread badge, as [centre x, centre y, radius] in unit glyph space. */
const BADGE = [0.845, 0.155, 0.135]

// ---------------------------------------------------------------- the beat

/**
 * The unread indicator is the tray icon beating rather than a number beside it,
 * so one cardiac cycle is baked into `BEAT_FRAMES` evenly spaced frames that the
 * tray plays on a loop. `src/main/tray.ts` holds the matching frame count and the
 * rate they are played at.
 */
const BEAT_FRAMES = 10
/** How small and how faint the glyph sits between beats. It never overshoots full size. */
const BEAT_REST_SCALE = 0.72
const BEAT_REST_ALPHA = 0.45
/** Where in the cycle the two contractions land, as a fraction of one beat. */
const S1 = 1 / BEAT_FRAMES
const S2 = 3 / BEAT_FRAMES

/**
 * How contracted the heart is at phase `t` (0..1) of one beat: a full S1, a weaker
 * S2 a moment later, then diastole. Sampling this on frame boundaries is what makes
 * it read as lub-dub rather than a sine wave.
 */
function contraction(t) {
  const bump = (centre, width) => Math.exp(-(((t - centre) / width) ** 2))
  return Math.min(1, bump(S1, 0.08) + 0.55 * bump(S2, 0.07))
}

// ----------------------------------------------------------------- app icon

/** Vertical gradient between two colours. */
function gradient(t, from, to) {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t
  ]
}

function renderAppIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const feather = 1.5 / size

  // macOS Big Sur proportions: the squircle fills ~82% of the canvas.
  const half = 0.412
  const radius = 0.1845

  // The .icns and .ico sets reach down to sizes the window icon never had to survive, and
  // they run into exactly what the tray does: the four direction changes close up into a
  // smudge, and a stroke defined as a fraction of the canvas thins below one pixel and
  // fades to grey. So borrow the tray's single spike and hold the stroke at a pixel.
  // Neither applies above 32px, which is why the 512 and 1024 icons still render byte for
  // byte as they did.
  const pulse = size <= 32 ? TRAY_PULSE : PULSE
  const stroke = Math.max(size * 0.042, 1.2)

  const top = [0x6d, 0x5c, 0xf6] // indigo
  const bottom = [0x38, 0x2c, 0xc4] // deeper indigo

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size
      const py = (y + 0.5) / size
      const i = (y * size + x) * 4

      const body = sdRoundedRect(px, py, 0.5, 0.5, half, half, radius)
      const bodyA = coverage(body, feather)
      if (bodyA <= 0) continue

      const [r, g, b] = gradient(clamp01((py - 0.09) / 0.82), top, bottom)

      // A soft highlight arc across the top face gives the flat shape some depth.
      const gloss = clamp01(1 - sdCircle(px, py, 0.5, -0.32, 0.78) * -6) * 0.16 * (1 - py)
      blend(
        rgba,
        i,
        Math.min(255, r + gloss * 255),
        Math.min(255, g + gloss * 255),
        Math.min(255, b + gloss * 255),
        bodyA
      )

      // Pulse glyph, inset inside the squircle.
      const gx = 0.5 + (px - 0.5) / 0.7
      const gy = 0.5 + (py - 0.5) / 0.7
      const glyph = distToPolyline(gx, gy, pulse) * 0.7 - stroke / size
      const glyphA = coverage(glyph, feather) * bodyA
      if (glyphA > 0) blend(rgba, i, 255, 255, 255, glyphA)
    }
  }
  return encodePng(size, size, rgba)
}

// ------------------------------------------------------------- icon containers

/**
 * macOS and Windows each want the app icon as one file holding every size at once, and
 * neither @electron/packager nor the makers will build one: they only swap the extension
 * on the path they are given. Both formats are thin wrappers around PNG data this script
 * already has in hand, so both are assembled here rather than by shelling out to
 * `iconutil` and `sips` — which would make `npm run icons` macOS-only, and leave Linux and
 * Windows CI unable to rebuild the assets they ship.
 */

/**
 * Windows .ico: a 6-byte ICONDIR, one 16-byte ICONDIRENTRY per image, then the payloads
 * back to back. Every entry here is a PNG, which Vista and later read directly; the older
 * BMP form would mean a second encoder, bottom-up rows, and a padded 1-bit AND mask for
 * the transparency the alpha channel already carries.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon, 2 = cursor
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(images.length * 16)
  let offset = header.length + directory.length
  images.forEach(({ size, png }, index) => {
    const entry = index * 16
    // One byte each, so 256 is the largest size the format can name and is spelled 0.
    // Nothing above it is offered, and `& 0xff` is that rule rather than a truncation.
    directory[entry] = size & 0xff
    directory[entry + 1] = size & 0xff
    directory[entry + 2] = 0 // palette entries: none, this is direct colour
    directory[entry + 3] = 0 // reserved
    directory.writeUInt16LE(1, entry + 4) // colour planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })

  return Buffer.concat([header, directory, ...images.map(({ png }) => png)])
}

/**
 * macOS .icns: an 8-byte header — the magic, then the length of the whole file — followed
 * by typed chunks of [4-byte OSType][4-byte length, counting these 8 bytes][payload], all
 * big-endian. The ic07–ic14 types take a PNG as their payload verbatim, so there is no
 * .iconset directory to lay out and no `iconutil` to invoke.
 */
function encodeIcns(entries) {
  const body = Buffer.concat(
    entries.map(({ type, png }) => {
      const head = Buffer.alloc(8)
      head.write(type, 0, 'ascii')
      head.writeUInt32BE(head.length + png.length, 4)
      return Buffer.concat([head, png])
    })
  )
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(header.length + body.length, 4)
  return Buffer.concat([header, body])
}

/**
 * The .icns members, as [OSType, pixel size]. Each is one of the point sizes macOS draws
 * an app icon at — 16, 32, 128, 256, 512 — at one of the two display scales, which is why
 * two pairs land on the same number of pixels: ic08 is 256pt@1x and ic13 is 128pt@2x.
 *
 * 16pt@1x and 32pt@1x are missing because their types predate PNG in this format — they
 * are the RLE `is32`/`il32` bitmaps with a separate `s8mk`/`l8mk` alpha mask, which would
 * mean a second encoder for the two sizes macOS is happy to scale ic11 and ic12 down to.
 */
const ICNS_TYPES = [
  ['ic11', 32], // 16pt @2x
  ['ic12', 64], // 32pt @2x
  ['ic07', 128], // 128pt @1x
  ['ic13', 256], // 128pt @2x
  ['ic08', 256], // 256pt @1x
  ['ic14', 512], // 256pt @2x
  ['ic09', 512], // 512pt @1x
  ['ic10', 1024] // 512pt @2x
]

/**
 * The .ico members. Windows reaches for 16 in the title bar and tree, 32 on the taskbar and
 * for shortcuts, 48 for "medium icons", and 256 for the jumbo view and the Start menu tile;
 * 24, 64 and 128 are the in-between display scales, and cost a couple of KB each — cheaper
 * than letting Windows resample one of its neighbours badly.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

// --------------------------------------------------------------------- write

function write(path, buffer) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, buffer)
  console.log(`  ${path}  (${(buffer.length / 1024).toFixed(1)} KB)`)
}

/**
 * The two containers ask for sizes the loose PNGs and each other already want, and a
 * 1024px render is most of this script's running time. So each size is drawn once and
 * handed out, which is also how ic08/ic13 and ic09/ic14 come to share one buffer.
 */
const APP_ICONS = new Map()
function appIconAt(size) {
  const existing = APP_ICONS.get(size)
  if (existing !== undefined) return existing
  const png = renderAppIcon(size)
  APP_ICONS.set(size, png)
  return png
}

const INCIDENT = [0xf4, 0x3f, 0x5e] // rose
const MONITORING = [0xf5, 0x9e, 0x0b] // amber

/** The three health icons, each in a plain and a badged form. */
const HEALTH_ICONS = [
  ['trayTemplate', null],
  ['trayIncident', INCIDENT],
  ['trayMonitoring', MONITORING]
]

console.log('Generating icons…')
for (const [stem, colour] of HEALTH_ICONS) {
  write(`resources/${stem}.png`, renderTray(16, colour))
  write(`resources/${stem}@2x.png`, renderTray(32, colour))
  // The `dot` tray style: the same icon, saying there is something unread.
  write(`resources/${stem}Dot.png`, renderTray(16, colour, 1, 1, true))
  write(`resources/${stem}Dot@2x.png`, renderTray(32, colour, 1, 1, true))
}
for (let frame = 0; frame < BEAT_FRAMES; frame++) {
  const beat = contraction(frame / BEAT_FRAMES)
  const scale = BEAT_REST_SCALE + (1 - BEAT_REST_SCALE) * beat
  const alpha = BEAT_REST_ALPHA + (1 - BEAT_REST_ALPHA) * beat
  write(`resources/trayBeat${frame}.png`, renderTray(16, INCIDENT, scale, alpha))
  write(`resources/trayBeat${frame}@2x.png`, renderTray(32, INCIDENT, scale, alpha))
}
write('resources/icon.png', appIconAt(512))
write('build/icon.png', appIconAt(1024))
write(
  'build/icon.icns',
  encodeIcns(ICNS_TYPES.map(([type, size]) => ({ type, png: appIconAt(size) })))
)
write('build/icon.ico', encodeIco(ICO_SIZES.map((size) => ({ size, png: appIconAt(size) }))))
console.log('Done.')
