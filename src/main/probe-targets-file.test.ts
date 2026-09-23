import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROBE_TARGETS,
  validateProbeTargets,
  type ProbeTargets
} from '../shared/probe-targets'
import { app, dialog, FakeWebFrameMain } from '../test/electron'
import { createHarness, type Harness } from '../test/harness'
import { EXPORT_NAME, MAX_IMPORT_BYTES } from './probe-targets-file'

let harness: Harness
let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'statusky-targets-'))
})

afterEach(async () => {
  harness?.dispose()
  await rm(folder, { recursive: true, force: true })
})

async function boot(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  harness = await createHarness({ tray: false, ...options })
  return harness
}

/** A document that is not the defaults, as a user's own would be. */
function custom(): ProbeTargets {
  const targets = structuredClone(DEFAULT_PROBE_TARGETS)
  targets.feeds = []
  return targets
}

function saveTo(path: string): void {
  dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: path })
}

function openFrom(path: string): void {
  dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] })
}

/** A promise a test settles by hand, to hold a dialog open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

describe('exporting the check targets', () => {
  it('writes the defaults, pretty-printed, when nothing overrides them', async () => {
    const h = await boot()
    const path = join(folder, 'targets.json')
    saveTo(path)

    await expect(h.api.ProbeTargetsFile.save()).resolves.toBe('targets.json')

    const text = await readFile(path, 'utf8')
    expect(text).toBe(`${JSON.stringify(DEFAULT_PROBE_TARGETS, null, 2)}\n`)
  })

  it('writes the override in force, which reads back as the same document', async () => {
    const h = await boot({ settings: { probeTargets: custom() } })
    const path = join(folder, 'mine.json')
    saveTo(path)

    await h.api.ProbeTargetsFile.save()

    const read = validateProbeTargets(JSON.parse(await readFile(path, 'utf8')))
    expect(read).toEqual({ ok: true, targets: custom() })
  })

  it('offers a JSON file in Documents', async () => {
    const h = await boot()
    await h.api.ProbeTargetsFile.save()

    const [options] = dialog.showSaveDialog.mock.calls[0] as unknown as [
      { defaultPath: string; filters: { extensions: string[] }[] }
    ]
    expect(options.defaultPath).toBe(join(app.getPath('documents'), EXPORT_NAME))
    expect(options.filters).toEqual([{ name: 'JSON', extensions: ['json'] }])
  })

  it('answers null when the dialog is cancelled', async () => {
    const h = await boot()

    await expect(h.api.ProbeTargetsFile.save()).resolves.toBeNull()
  })

  it('says which file it could not write', async () => {
    const h = await boot()
    saveTo(join(folder, 'missing', 'targets.json'))

    await expect(h.api.ProbeTargetsFile.save()).rejects.toThrow(/Could not save targets\.json: /)
  })
})

describe('importing the check targets', () => {
  it('hands back the chosen file’s name and text, unparsed', async () => {
    const h = await boot()
    const path = join(folder, 'theirs.json')
    await writeFile(path, 'not even JSON')
    openFrom(path)

    await expect(h.api.ProbeTargetsFile.open()).resolves.toEqual({
      name: 'theirs.json',
      text: 'not even JSON'
    })
    // Nothing is applied by reading: that is a separate, validated `Preferences.patch`.
    expect(h.model.settings.probeTargets).toBeNull()
  })

  it('asks for one JSON file', async () => {
    const h = await boot()
    await h.api.ProbeTargetsFile.open()

    const [options] = dialog.showOpenDialog.mock.calls[0] as unknown as [
      { properties: string[]; filters: { extensions: string[] }[] }
    ]
    expect(options.properties).toEqual(['openFile'])
    expect(options.filters).toEqual([{ name: 'JSON', extensions: ['json'] }])
  })

  it('answers null when the dialog is cancelled', async () => {
    const h = await boot()
    await expect(h.api.ProbeTargetsFile.open()).resolves.toBeNull()
  })

  it('refuses a file far too large to be a list of targets', async () => {
    const h = await boot()
    const path = join(folder, 'huge.json')
    await writeFile(path, Buffer.alloc(MAX_IMPORT_BYTES + 1, 0x20))
    openFrom(path)

    await expect(h.api.ProbeTargetsFile.open()).rejects.toThrow(
      /Could not read huge\.json: it is far too large/
    )
  })

  it('says which file it could not read', async () => {
    const h = await boot()
    openFrom(join(folder, 'gone.json'))

    await expect(h.api.ProbeTargetsFile.open()).rejects.toThrow(/Could not read gone\.json: /)
  })
})

describe('the dialogs and the popover', () => {
  // The popover hides on blur, and a dialog takes focus: without this the panel waiting
  // on the answer would vanish the moment it asked.
  it('holds the popover open while a dialog is up, and only then', async () => {
    const h = await boot()
    h.popover.show()
    const window = h.browserWindow()!
    const answer = deferred<{ canceled: boolean; filePath: string }>()
    dialog.showSaveDialog.mockReturnValueOnce(answer.promise)

    const saving = h.api.ProbeTargetsFile.save()
    await Promise.resolve()
    window.emit('blur')
    expect(h.popover.isVisible()).toBe(true)

    answer.resolve({ canceled: true, filePath: '' })
    await saving
    window.emit('blur')
    expect(h.popover.isVisible()).toBe(false)
  })

  it('lets go of the popover when a dialog fails', async () => {
    const h = await boot()
    h.popover.show()
    openFrom(join(folder, 'gone.json'))

    await expect(h.api.ProbeTargetsFile.open()).rejects.toThrow()
    h.browserWindow()!.emit('blur')
    expect(h.popover.isVisible()).toBe(false)
  })

  it('opens one dialog at a time', async () => {
    const h = await boot()
    const answer = deferred<{ canceled: boolean; filePaths: string[] }>()
    dialog.showOpenDialog.mockReturnValueOnce(answer.promise)

    const opening = h.api.ProbeTargetsFile.open()
    await Promise.resolve()
    await expect(h.api.ProbeTargetsFile.save()).rejects.toThrow(/already open/)
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()

    answer.resolve({ canceled: true, filePaths: [] })
    await expect(opening).resolves.toBeNull()
    await expect(h.api.ProbeTargetsFile.save()).resolves.toBeNull()
  })

  it('answers only the popover', async () => {
    const h = await boot()
    h.browserWindow()!.webContents.mainFrame.url = 'https://status.example.test/'

    await expect(h.api.ProbeTargetsFile.save()).rejects.toThrow(/did not pass origin validation/)
    await expect(h.api.ProbeTargetsFile.open()).rejects.toThrow(/did not pass origin validation/)
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('refuses a sub-frame', async () => {
    const h = await boot()
    const popover = h.browserWindow()!.webContents.mainFrame
    popover.parent = new FakeWebFrameMain(popover.webContents, popover.url)

    await expect(h.api.ProbeTargetsFile.open()).rejects.toThrow(/did not pass origin validation/)
  })
})
