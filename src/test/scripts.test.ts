import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `src/ipc` holds exactly one of the two `PopoverOnly` branches: whichever was chosen when
 * it was last generated. Anything that runs, builds, packages or tests the app has to
 * generate the branch it needs first, or it quietly runs on whatever an earlier command
 * left behind. That is how `npm start` once refused every IPC call: it had no `prestart`,
 * so it previewed a build of the production branch, unpackaged.
 *
 * npm makes this easy to get wrong, because a `pre<name>` hook fires for that exact script
 * name and nothing else: `pretest` does nothing for `test:node`. So rather than listing
 * today's scripts, this walks every script the way npm would run it, and fails as soon as
 * one reaches a wiring-sensitive tool without the right generation on the way.
 */

type Scripts = Readonly<Record<string, string>>
type Environment = 'development' | 'production'

/**
 * What one run has established so far. An absent environment means "whatever an earlier
 * run left on disk", which is exactly what the incident ran on.
 */
interface Ledger {
  /** The environment last generated into src/ipc. */
  ipc?: Environment
  /** The environment of the wiring out/ was last built from. */
  out?: Environment
  /** Whether anything in this run has generated the wiring or depended on it. */
  touched: boolean
}

/** Thrown at the first command that would run on the wrong wiring, or cannot be followed. */
class Violation extends Error {
  constructor(trail: readonly string[], reason: string) {
    super(`${trail.join(' → ')}: ${reason}`)
  }
}

/**
 * Every script someone might run that would reach the app, a build, a package or a test run
 * on the wrong IPC wiring, as "trail: reason". Pre and post hooks are checked as part of
 * the script they belong to rather than on their own, because that is how npm runs them.
 */
function checkScripts(scripts: Scripts): string[] {
  const problems: string[] = []
  for (const name of Object.keys(scripts)) {
    const target = /^(?:pre|post)(.+)$/.exec(name)?.[1]
    if (target !== undefined && Object.hasOwn(scripts, target)) continue
    try {
      runScript(scripts, name, [], true, { touched: false }, [])
    } catch (error) {
      if (!(error instanceof Violation)) throw error
      problems.push(error.message)
    }
  }
  return problems
}

/**
 * Run a script the way `npm run <name>` does: its pre hook, the script, then its post hook.
 * npm hands positional arguments to the script alone, and never looks for hooks of hooks.
 */
function runScript(
  scripts: Scripts,
  name: string,
  args: readonly string[],
  hooks: boolean,
  ledger: Ledger,
  trail: readonly string[]
): Ledger {
  const here = [...trail, name]
  if (trail.includes(name)) throw new Violation(here, 'the scripts call each other in a loop')

  let state = ledger
  const pre = `pre${name}`
  const post = `post${name}`
  if (hooks && Object.hasOwn(scripts, pre)) {
    state = runBody(scripts, scripts[pre] ?? '', [], state, [...here, pre])
  }
  state = runBody(scripts, scripts[name] ?? '', args, state, here)
  if (hooks && Object.hasOwn(scripts, post)) {
    state = runBody(scripts, scripts[post] ?? '', [], state, [...here, post])
  }
  return state
}

/** Only these run their commands one after another, which is all a straight walk can model. */
const FOLLOWED = new Set(['&&', ';'])

function runBody(
  scripts: Scripts,
  body: string,
  args: readonly string[],
  ledger: Ledger,
  trail: readonly string[]
): Ledger {
  const { commands, unfollowed } = parse(body, args)
  let state: Ledger = { ...ledger, touched: false }
  let violation: Violation | undefined
  try {
    for (const command of commands) state = runCommand(scripts, command, state, trail)
  } catch (error) {
    if (!(error instanceof Violation)) throw error
    violation = error
  }

  // A pipe, fallback, background job or subshell can reorder or skip commands, so walking
  // them in order could pass a script that is broken. That only matters when the wiring is
  // involved, so a script like `oxlint | tee lint.log` is left alone.
  if (unfollowed !== undefined && (violation !== undefined || state.touched)) {
    throw new Violation(
      trail,
      `uses \`${unfollowed}\`, which this check cannot follow, alongside commands that generate or depend on the IPC wiring`
    )
  }
  if (violation !== undefined) throw violation
  return { ...state, touched: ledger.touched || state.touched }
}

/** A script body as commands, with npm's extra arguments appended the way npm appends them. */
function parse(
  body: string,
  args: readonly string[]
): { commands: string[][]; unfollowed?: string } {
  const commands: string[][] = []
  let current: string[] = []
  let unfollowed: string | undefined
  for (const token of [...tokenize(body), ...args.map((word) => ({ word }))]) {
    if ('operator' in token) {
      if (!FOLLOWED.has(token.operator)) unfollowed ??= token.operator
      commands.push(current)
      current = []
    } else {
      current.push(token.word)
    }
  }
  commands.push(current)
  return { commands: commands.filter((command) => command.length > 0), unfollowed }
}

type Token = { word: string } | { operator: string }

/**
 * Split a script into words and control operators the way `sh` would, for what package.json
 * scripts realistically contain: quotes, backslashes, `&&`, `||`, `;`, `|`, `&`, subshells
 * and backticks. An operator inside quotes is just text, and so is the `&` in `2>&1`.
 */
function tokenize(body: string): Token[] {
  const tokens: Token[] = []
  let word: string | undefined
  let quote: string | undefined
  const append = (text: string) => {
    word = (word ?? '') + text
  }
  const endWord = () => {
    if (word !== undefined) tokens.push({ word })
    word = undefined
  }

  for (let i = 0; i < body.length; i++) {
    const char = body.charAt(i)
    const next = body.charAt(i + 1)
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (quote === '"' && char === '\\' && next !== '' && '"\\$`'.includes(next)) {
        append(next)
        i++
      } else append(char)
    } else if (char === "'" || char === '"') {
      quote = char
      append('')
    } else if (char === '\\') {
      append(next)
      i++
    } else if (char === '\n') {
      endWord()
      tokens.push({ operator: ';' })
    } else if (/\s/.test(char)) {
      endWord()
    } else if (char === '&' && /[<>]$/.test(word ?? '')) {
      append(char)
    } else if ('&|;()`'.includes(char)) {
      endWord()
      const doubled = (char === '&' || char === '|') && next === char
      tokens.push({ operator: doubled ? char + char : char })
      if (doubled) i++
    } else {
      append(char)
    }
  }
  endWord()
  return tokens
}

/** npm's aliases for `run`, and the lifecycle commands that are shorthand for one script. */
const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn'])
const NPM_SHORTHANDS = new Map([
  ['test', 'test'],
  ['t', 'test'],
  ['tst', 'test'],
  ['start', 'start']
])

/** The Electron Forge subcommands that take what is in out/ and turn it into artifacts. */
const FORGE_PACKAGING = new Set(['package', 'make', 'publish'])

function runCommand(
  scripts: Scripts,
  words: readonly string[],
  ledger: Ledger,
  trail: readonly string[]
): Ledger {
  const shown = `\`${words.join(' ')}\``
  const first = words.findIndex((word) => !/^[A-Za-z_]\w*=/.test(word))
  const argv = first === -1 ? [] : words.slice(first)
  const assigned = first === -1 ? words : words.slice(0, first)
  const eipcEnv = assigned
    .findLast((word) => word.startsWith('EIPC_ENV='))
    ?.slice('EIPC_ENV='.length)

  const npm = npmInvocation(argv)
  if (npm !== undefined) {
    if (Object.hasOwn(scripts, npm.name)) {
      return runScript(scripts, npm.name, npm.args, npm.hooks, ledger, trail)
    }
    if (npm.ifPresent) return ledger
    throw new Violation(trail, `${shown} names a script that does not exist`)
  }

  const generator = locate(argv, 'generate-ipc.mjs')
  const runsGenerator =
    generator !== -1 &&
    argv.slice(0, generator).every((word, i) => (i === 0 ? word === 'node' : word.startsWith('-')))
  if (runsGenerator) {
    // Given no argument, the generator falls back to EIPC_ENV and then to production, so a
    // bare call generates whatever the shell that ran npm happens to have set. Only an
    // environment the script itself names counts.
    const named = argv[generator + 1] ?? eipcEnv
    return { ...ledger, ipc: isEnvironment(named) ? named : undefined, touched: true }
  }

  const vite = locate(argv, 'electron-vite')
  if (vite !== -1) {
    const command = subcommand(argv, vite)
    if (command === undefined || command === 'dev' || command === 'serve') {
      expectWiring(ledger.ipc, 'development', shown, trail)
      // The dev server compiles main and preload into out/ but serves the renderer from
      // memory, so what is left in out/ is no longer any one build.
      return { ...ledger, out: undefined, touched: true }
    }
    if (command === 'preview' && argv.includes('--skipBuild')) {
      expectBuild(ledger.out, 'development', shown, trail)
      return { ...ledger, touched: true }
    }
    if (command === 'preview' || command === 'build') {
      // Both build out/ from src/ipc first; preview then runs it unpackaged.
      const needed = command === 'preview' ? 'development' : 'production'
      expectWiring(ledger.ipc, needed, shown, trail)
      return { ...ledger, out: needed, touched: true }
    }
    throw new Violation(trail, `${shown} is not an electron-vite command this check knows`)
  }

  if (locate(argv, 'vitest') !== -1) {
    expectWiring(ledger.ipc, 'production', shown, trail)
    return { ...ledger, touched: true }
  }

  const forge = locate(argv, 'electron-forge')
  if (forge !== -1) {
    if (FORGE_PACKAGING.has(subcommand(argv, forge) ?? '')) {
      // Forge packages out/ and never reads src/ipc, so regenerating the wiring is not
      // enough on its own: out/ has to have been built from production wiring. `publish`
      // packages and makes on its way to uploading, so it is no different from `make`.
      expectBuild(ledger.out, 'production', shown, trail)
      return { ...ledger, touched: true }
    }
    // Everything else Forge can be told to do either scaffolds a project or runs the app
    // (`start`, which would want development wiring and a development build, and which
    // this project does not use — `npm start` is electron-vite's preview). Refusing is
    // deliberate, and matches what an unknown electron-vite command does: a packaging
    // command that slipped through here unrecognised would return the ledger unchanged
    // and ship a build that refuses every IPC call, which is the whole reason this file
    // exists.
    throw new Violation(trail, `${shown} is not an electron-forge command this check knows`)
  }

  return ledger
}

/** `npm run x -- a`, `npm test`, `npm start`: the script npm runs, and what it passes on. */
function npmInvocation(
  argv: readonly string[]
): { name: string; args: string[]; hooks: boolean; ifPresent: boolean } | undefined {
  if (argv[0] !== 'npm') return undefined
  const separator = argv.includes('--') ? argv.indexOf('--') : argv.length
  const options = argv.slice(1, separator)
  // Before `--`, npm reads anything flag-shaped as its own configuration, not an argument.
  const [command = '', ...positional] = options.filter((word) => !word.startsWith('-'))
  const passed = [...positional, ...argv.slice(separator + 1)]
  const hooks = !options.includes('--ignore-scripts')
  const ifPresent = options.includes('--if-present')

  if (NPM_RUN.has(command)) {
    const [name, ...args] = passed
    return name === undefined ? undefined : { name, args, hooks, ifPresent }
  }
  const shorthand = NPM_SHORTHANDS.get(command)
  return shorthand === undefined ? undefined : { name: shorthand, args: passed, hooks, ifPresent }
}

/** Where a tool sits in a command: `vitest`, `npx vitest` and `node_modules/.bin/vitest` all run it. */
function locate(argv: readonly string[], tool: string): number {
  return argv.findIndex((word) => word === tool || word.endsWith(`/${tool}`))
}

/** A CLI's subcommand: the first argument after it that is not a flag. */
function subcommand(argv: readonly string[], index: number): string | undefined {
  return argv.slice(index + 1).find((word) => !word.startsWith('-'))
}

function isEnvironment(value: string | undefined): value is Environment {
  return value === 'development' || value === 'production'
}

function expectWiring(
  have: Environment | undefined,
  need: Environment,
  shown: string,
  trail: readonly string[]
): void {
  if (have === need) return
  throw new Violation(
    trail,
    have === undefined
      ? `${shown} runs without generating ${need} IPC wiring first`
      : `${shown} runs on ${have} IPC wiring but needs ${need}`
  )
}

function expectBuild(
  have: Environment | undefined,
  need: Environment,
  shown: string,
  trail: readonly string[]
): void {
  if (have === need) return
  throw new Violation(
    trail,
    have === undefined
      ? `${shown} uses out/ without building it from ${need} IPC wiring first`
      : `${shown} uses an out/ built from ${have} IPC wiring but needs ${need}`
  )
}

const generate = (environment: Environment) => `node scripts/generate-ipc.mjs ${environment}`

describe('the scripts in package.json', () => {
  it('never run, build, package or test the app on the wrong IPC wiring', () => {
    const { scripts } = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(checkScripts(scripts)).toEqual([])
  })
})

describe('checkScripts', () => {
  describe('pre and post hooks', () => {
    // The incident, exactly: `start` previewed whatever wiring an earlier command left.
    it('catches a start script with no prestart', () => {
      expect(checkScripts({ start: 'electron-vite preview' })).toEqual([
        'start: `electron-vite preview` runs without generating development IPC wiring first'
      ])
    })

    it('accepts the fix: an exact-name hook generating the environment the script needs', () => {
      expect(
        checkScripts({ prestart: generate('development'), start: 'electron-vite preview' })
      ).toEqual([])
    })

    it.each([
      [
        { prestart: generate('production'), start: 'electron-vite preview' },
        'start: `electron-vite preview` runs on production IPC wiring but needs development'
      ],
      [
        { prebuild: generate('development'), build: 'electron-vite build' },
        'build: `electron-vite build` runs on development IPC wiring but needs production'
      ]
    ])('catches a hook that generates the wrong environment', (scripts, problem) => {
      expect(checkScripts(scripts)).toEqual([problem])
    })

    it('catches a new test script, because pretest only fires for test itself', () => {
      expect(
        checkScripts({
          pretest: generate('production'),
          test: 'vitest run',
          'test:unit': 'vitest run --project node'
        })
      ).toEqual([
        'test:unit: `vitest run --project node` runs without generating production IPC wiring first'
      ])
    })

    it('runs a post hook on the wiring its script left, and never on its own', () => {
      expect(
        checkScripts({
          pretest: generate('production'),
          test: 'vitest run',
          posttest: 'vitest run --coverage'
        })
      ).toEqual([])
    })

    it('skips hooks when npm is told to ignore scripts', () => {
      expect(
        checkScripts({
          pretest: generate('production'),
          test: 'vitest run',
          ci: 'npm test --ignore-scripts'
        })
      ).toEqual(['ci → test: `vitest run` runs without generating production IPC wiring first'])
    })
  })

  describe('chains', () => {
    it('follows npm run, npm test and && into the scripts they name, hooks included', () => {
      expect(
        checkScripts({
          prebuild: generate('production'),
          build: 'electron-vite build',
          pretest: generate('production'),
          test: 'vitest run',
          'test:unit': 'npm test -- --project node',
          release: 'npm run build && npm run-script test:unit'
        })
      ).toEqual([])
    })

    it('reports the whole trail, and stops each run at its first problem', () => {
      expect(
        checkScripts({
          check: 'tsc --noEmit',
          build: 'npm run check && electron-vite build',
          dist: 'npm run build && electron-forge make'
        })
      ).toEqual([
        'build: `electron-vite build` runs without generating production IPC wiring first',
        'dist → build: `electron-vite build` runs without generating production IPC wiring first'
      ])
    })

    it('passes arguments after -- to the script itself', () => {
      expect(
        checkScripts({
          'generate:ipc': 'node scripts/generate-ipc.mjs',
          test: 'npm run generate:ipc -- production && vitest run'
        })
      ).toEqual([])
    })

    it('does not pass those arguments on to the script’s hooks', () => {
      expect(
        checkScripts({
          pretest: 'node scripts/generate-ipc.mjs',
          test: 'vitest run',
          ci: 'npm test -- production'
        })
      ).toEqual([
        'test: `vitest run` runs without generating production IPC wiring first',
        'ci → test: `vitest run production` runs without generating production IPC wiring first'
      ])
    })

    it('only counts a generation that happens before the tool', () => {
      expect(checkScripts({ test: `vitest run && ${generate('production')}` })).toEqual([
        'test: `vitest run` runs without generating production IPC wiring first'
      ])
    })

    it('lets a later generation, including one set through EIPC_ENV, override a hook', () => {
      expect(
        checkScripts({
          pretest: generate('production'),
          test: 'EIPC_ENV=development node scripts/generate-ipc.mjs && vitest run'
        })
      ).toEqual(['test: `vitest run` runs on development IPC wiring but needs production'])
    })

    it('reports a loop instead of following it forever', () => {
      expect(checkScripts({ a: 'npm run b', b: 'npm run a && vitest run' })).toEqual([
        'a → b → a: the scripts call each other in a loop',
        'b → a → b: the scripts call each other in a loop'
      ])
    })

    it('reports a script that does not exist, unless npm was told it may be absent', () => {
      expect(checkScripts({ ci: 'npm run tset', lenient: 'npm run tset --if-present' })).toEqual([
        'ci: `npm run tset` names a script that does not exist'
      ])
    })
  })

  describe('environments', () => {
    it.each([
      ['electron-vite dev', 'development'],
      ['electron-vite', 'development'],
      ['electron-vite preview', 'development'],
      ['electron-vite build', 'production'],
      ['vitest', 'production'],
      ['npx vitest run', 'production'],
      ['node_modules/.bin/vitest run', 'production']
    ] as const)('runs %s on %s wiring and nothing else', (command, needed) => {
      const other = needed === 'development' ? 'production' : 'development'

      expect(checkScripts({ run: `${generate(needed)} && ${command}` })).toEqual([])
      expect(checkScripts({ run: `${generate(other)} && ${command}` })).toEqual([
        `run: \`${command}\` runs on ${other} IPC wiring but needs ${needed}`
      ])
    })

    it.each([
      ['a bare generator, which inherits the caller’s EIPC_ENV', 'node scripts/generate-ipc.mjs'],
      ['a command that only names the generator', 'cat scripts/generate-ipc.mjs production']
    ])('does not trust %s', (_name, generation) => {
      expect(checkScripts({ test: `${generation} && vitest run` })).toEqual([
        'test: `vitest run` runs without generating production IPC wiring first'
      ])
    })
  })

  describe('packaging', () => {
    it('packages an out/ built from production wiring', () => {
      expect(
        checkScripts({
          prebuild: generate('production'),
          build: 'electron-vite build',
          dist: 'npm run build && electron-forge make --platform=darwin'
        })
      ).toEqual([])
    })

    it.each(['package', 'make', 'publish'])(
      'refuses to %s an out/ nothing in the run built',
      (command) => {
        expect(checkScripts({ dist: `electron-forge ${command}` })).toEqual([
          `dist: \`electron-forge ${command}\` uses out/ without building it from production IPC wiring first`
        ])
      }
    )

    // Forge never reads src/ipc, so this would package whatever was built last.
    it('does not accept a production generation that never rebuilt out/', () => {
      expect(checkScripts({ dist: `${generate('production')} && electron-forge make` })).toEqual([
        'dist: `electron-forge make` uses out/ without building it from production IPC wiring first'
      ])
    })

    it('refuses to package the out/ a development preview built', () => {
      expect(
        checkScripts({
          package: `${generate('development')} && electron-vite preview && electron-forge package`
        })
      ).toEqual([
        'package: `electron-forge package` uses an out/ built from development IPC wiring but needs production'
      ])
    })

    // The incident's other shape: a hook that is right, in front of a preview of a stale build.
    it('catches a preview that skips its build', () => {
      expect(
        checkScripts({
          prestart: generate('development'),
          start: 'electron-vite preview --skipBuild'
        })
      ).toEqual([
        'start: `electron-vite preview --skipBuild` uses out/ without building it from development IPC wiring first'
      ])
    })
  })

  describe('what it will not guess at', () => {
    it.each([
      ['a pipe', 'vitest run | tee test.log', '|'],
      ['a fallback', `${generate('production')} || true; vitest run`, '||'],
      ['a background job', `${generate('production')} & vitest run`, '&'],
      ['a subshell', `(${generate('production')}) && vitest run`, '(']
    ])('refuses %s around wiring commands', (_name, test, operator) => {
      expect(checkScripts({ test })).toEqual([
        `test: uses \`${operator}\`, which this check cannot follow, alongside commands that generate or depend on the IPC wiring`
      ])
    })

    it('leaves those operators alone when the wiring is not involved', () => {
      expect(checkScripts({ lint: 'oxlint | tee lint.log' })).toEqual([])
    })

    it('reads quoted operators and redirects as plain arguments', () => {
      expect(
        checkScripts({
          pretest: generate('production'),
          test: `vitest run -t "a && b" -t 'c | d' 2>&1`
        })
      ).toEqual([])
    })

    it('rejects an electron-vite command it does not recognise', () => {
      expect(
        checkScripts({
          start: `${generate('development')} && electron-vite --mode staging preview`
        })
      ).toEqual([
        'start: `electron-vite --mode staging preview` is not an electron-vite command this check knows'
      ])
    })

    // `electron-forge start` would run the app from out/ on development wiring, which is
    // a different question from packaging; nothing here answers it, so nothing here
    // pretends to.
    it('rejects an electron-forge command it does not recognise', () => {
      expect(
        checkScripts({
          prebuild: generate('production'),
          build: 'electron-vite build',
          dev: 'npm run build && electron-forge start'
        })
      ).toEqual(['dev: `electron-forge start` is not an electron-forge command this check knows'])
    })
  })
})
