import {execFileSync, spawn, spawnSync, type ChildProcessByStdio} from 'node:child_process'
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, relative} from 'node:path'
import type {Readable} from 'node:stream'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {afterEach} from 'vitest'

const helpersDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(helpersDir, '..', '..')

// Tests read arbitrary wrangler config fields, whose shape the fake wrangler doesn't constrain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WranglerConfig = Record<string, any>

export interface WorkerSpec {
  name: string
  version?: string
  /** Service bindings at the top level of the worker config, as target worker names. */
  bindings?: string[]
  /** Service bindings under env.<name>, as target worker names. */
  envBindings?: Record<string, string[]>
  /** Merged over the generated wrangler.jsonc. */
  config?: Record<string, unknown>
}

export interface FixtureOptions {
  workers: WorkerSpec[]
  /** Environments declared in the base config. */
  environments?: string[]
  /** Merged over the generated base config. `false` writes no base config. */
  base?: Record<string, unknown> | false
  /** Merged over the generated monocf.config.json. */
  monocfConfig?: Record<string, unknown>
  /** Lines of .monocfignore. */
  ignore?: string[]
  /** Extra files such as `.dev.vars.production`, keyed by path relative to the project root. */
  files?: Record<string, string>
  /** Create the project inside a directory with this name, for example one with a space in it. */
  parentDirName?: string
  /** Which wrangler the project has. `real` links the one in this repository. Defaults to `fake`. */
  wrangler?: 'fake' | 'none' | 'real'
}

export interface WranglerCall {
  argv: string[]
  /** Absolute paths of the configs passed with --config. */
  configPaths: string[]
  config: WranglerConfig | null
  configDir: string | null
  configDirMode: number | null
  configs: WranglerConfig[]
  cwd: string
  /** Parsed by dotenv from the file next to the config, the way real wrangler reads it. */
  devVars: Record<string, string> | null
  devVarsMode: number | null
  devVarsRaw: string | null
  /** The `.env` files next to the config, with their modes. */
  dotEnvFiles: Record<string, number>
  /** The variables named FROM_*, which is how these tests mark a value from a worker's `.env`. */
  dotEnvValues: Record<string, string>
  /** What the child saw of the variables that could reach Cloudflare or a developer's login. */
  environment: Record<string, string>
  /** The file the rebased `main` of the first config points at, or null if it points at nothing. */
  mainSource: string | null
  outputFile: string | null
  secretFile?: {mode: number; name: string; raw: string; vars: Record<string, string>}
}

export interface Fixture {
  root: string
  /** False when the fixture has no fake wrangler, so a run can't be expected to log calls. */
  usesFake: boolean
  worker(name: string): string
}

export interface WranglerRule {
  command: string
  worker?: string
  /** What a dry run writes as index.js. */
  bundle?: string
  exitCode?: number
  /** The code of the `command-failed` entry written to the output file. */
  failCode?: number
  failMessage?: string
  /** Stays alive this long, recording the signals it gets. */
  holdMs?: number
  /** With holdMs: carries on after a signal. */
  ignoreSignals?: boolean
  /** Exits 0 from an upload without reporting a version ID. */
  noOutputEntry?: boolean
  signal?: string
  stdout?: string
  /** Written by a descendant after this process has exited, through the same stdout. */
  stdoutAfterExit?: string
  stderr?: string
  delayMs?: number
}

export interface CliResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  calls: WranglerCall[]
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, {force: true, maxRetries: 5, recursive: true, retryDelay: 200})
  }
})

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'monocf-test-')))
  tempDirs.push(dir)
  return dir
}

function writeFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), {recursive: true})
  writeFileSync(filePath, content)
}

function writeJson(filePath: string, value: unknown): void {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function toServices(targets: string[]): {binding: string; service: string}[] {
  return targets.map((service) => ({binding: service.toUpperCase().replaceAll('-', '_'), service}))
}

function installFakeWrangler(root: string): void {
  const packageDir = join(root, 'node_modules', 'wrangler')
  writeJson(join(packageDir, 'package.json'), {
    bin: {wrangler: 'bin/wrangler.js'},
    engines: {node: '>=22.0.0'},
    name: 'wrangler',
    type: 'module',
    version: '4.151.0',
  })
  const script = pathToFileURL(join(helpersDir, 'fake-wrangler.mjs')).href
  const stub = `await import(${JSON.stringify(script)})\n`
  writeFile(join(packageDir, 'bin', 'wrangler.js'), stub)
  writeFile(join(packageDir, 'wrangler-dist', 'cli.js'), stub)
}

/** The project gets this repository's wrangler, and resolves its dependencies from here through the link. */
function linkRealWrangler(root: string): void {
  mkdirSync(join(root, 'node_modules'), {recursive: true})
  symlinkSync(join(repoRoot, 'node_modules', 'wrangler'), join(root, 'node_modules', 'wrangler'), 'junction')
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, {cwd: root, stdio: 'ignore'})
}

export function createFixture(options: FixtureOptions): Fixture {
  const tempDir = makeTempDir()
  const root = options.parentDirName ? join(tempDir, options.parentDirName, 'project') : join(tempDir, 'project')

  writeJson(join(root, 'monocf.config.json'), {
    baseConfig: options.base === false ? undefined : 'base.wrangler.jsonc',
    rootDir: './',
    variables: {version: 'v1'},
    workersDirName: 'workers',
    ...options.monocfConfig,
  })

  if (options.base !== false) {
    const env = Object.fromEntries((options.environments ?? []).map((name) => [name, {vars: {STAGE: name}}]))
    writeJson(join(root, 'base.wrangler.jsonc'), {
      compatibility_date: '2025-01-09',
      main: 'src/index.ts',
      name: '{workerName}-{version}',
      ...(Object.keys(env).length > 0 && {env}),
      ...options.base,
    })
  }

  for (const worker of options.workers) {
    const dir = join(root, 'workers', worker.name)
    const env = Object.entries(worker.envBindings ?? {}).map(([name, targets]) => [
      name,
      {services: toServices(targets)},
    ])
    writeJson(join(dir, 'wrangler.jsonc'), {
      ...(options.base === false && {compatibility_date: '2025-01-09', main: 'src/index.ts', name: worker.name}),
      ...(worker.bindings && {services: toServices(worker.bindings)}),
      ...(env.length > 0 && {env: Object.fromEntries(env)}),
      ...worker.config,
    })
    writeJson(join(dir, 'package.json'), {name: worker.name, version: worker.version ?? '1.0.0'})
    writeFile(join(dir, 'src', 'index.ts'), `export default {fetch: () => new Response('${worker.name}')}\n`)
  }

  if (options.ignore) writeFile(join(root, '.monocfignore'), `${options.ignore.join('\n')}\n`)

  for (const [path, content] of Object.entries(options.files ?? {})) {
    writeFile(join(root, path), content)
  }

  const wrangler = options.wrangler ?? 'fake'
  if (wrangler === 'fake') installFakeWrangler(root)
  if (wrangler === 'real') linkRealWrangler(root)

  writeFile(join(root, '.gitignore'), 'node_modules\n')
  git(root, 'init', '--quiet')
  git(root, 'add', '.')
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'init',
  )

  return {root, usesFake: wrangler === 'fake', worker: (name) => join(root, 'workers', name)}
}

/** What the fake wrangler answers reads with, as Cloudflare would. */
export interface FakeCloudflare {
  /** Bucket name to its objects by key. */
  buckets?: Record<string, Record<string, string>>
  /** By deployed name. A worker that isn't here doesn't exist. */
  workers?: Record<string, {active: [versionId: string, percentage: number][]; tags?: Record<string, null | string>}>
}

export interface RunOptions {
  /** Set to serve reads. Without it, every read fails, so a test can't reach one by accident. */
  cloudflare?: FakeCloudflare
  /** Directory to run from, relative to the fixture root. Defaults to the root. */
  cwd?: string
  env?: Record<string, string>
  /** The run is expected to make no wrangler call, for example a usage error. */
  noCalls?: boolean
  rules?: WranglerRule[]
}

/**
 * The child's environment: it can't reach Cloudflare, or a developer's login, whichever wrangler it ends up running.
 * A wrangler that isn't the fake finds a dummy token, an API on a closed local port, and an empty home.
 */
function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(CLOUDFLARE|CF|GITHUB)_/i.test(name)),
  )
  return {
    ...inherited,
    APPDATA: join(home, 'AppData', 'Roaming'),
    CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000000',
    CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9/client/v4',
    CLOUDFLARE_API_TOKEN: 'dummy-token-for-tests',
    // Otherwise miniflare fetches request metadata from Cloudflare when a session starts.
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    HOME: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    USERPROFILE: home,
    WRANGLER_HOME: join(home, '.wrangler'),
    XDG_CONFIG_HOME: join(home, '.config'),
  }
}

function readCalls(logPath: string): WranglerCall[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export interface RunningCli {
  child: ChildProcessByStdio<null, Readable, Readable>
  /** Settles when the process has ended. */
  done: Promise<CliResult>
  /** Resolves once the fake wrangler has logged this many calls. */
  waitForCalls(count: number): Promise<WranglerCall[]>
  /** What the fake recorded receiving, as `<worker> <signal>` lines. */
  signals(): string[]
  /** The output so far. */
  stderr(): string
  stdout(): string
}

/** Whoami, the state store, and reads by name are the calls that need no worker's config. */
function isConfigFree(argv: string[]): boolean {
  return argv[0] === 'whoami' || argv[0] === 'r2' || (argv.includes('--name') && ['deployments', 'versions'].includes(argv[0]))
}

export function startCli(fixture: Fixture, args: string[], options: RunOptions = {}): RunningCli {
  const stateDir = makeTempDir()
  const logPath = join(stateDir, 'calls.ndjson')
  const rulesPath = join(stateDir, 'rules.json')
  writeJson(rulesPath, options.rules ?? [])
  const cloudflarePath = join(stateDir, 'cloudflare.json')
  if (options.cloudflare) writeJson(cloudflarePath, options.cloudflare)

  const child = spawn(process.execPath, [join(repoRoot, 'bin', 'run.js'), ...args], {
    cwd: options.cwd ? join(fixture.root, options.cwd) : fixture.root,
    env: {
      ...isolatedEnvironment(stateDir),
      FAKE_WRANGLER_LOG: logPath,
      FAKE_WRANGLER_RULES: rulesPath,
      ...(options.cloudflare && {FAKE_WRANGLER_CF: cloudflarePath}),
      NO_COLOR: '1',
      WRANGLER_SEND_METRICS: 'false',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const done = new Promise<CliResult>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode, signal) => {
      const calls = readCalls(logPath)
      // Zero calls can mean that something other than the fake ran, so a test has to say that it expects none.
      if (fixture.usesFake && !options.noCalls && calls.length === 0) {
        reject(new Error(`monocf ${args.join(' ')} made no fake wrangler call (exit ${exitCode}):\n${stderr}`))
        return
      }

      // Wrangler falls back to looking for a config in its working directory, so a missing flag can go unnoticed.
      const withoutConfig = calls.find((call) => call.config === null && !isConfigFree(call.argv))
      if (withoutConfig) {
        reject(new Error(`wrangler ${withoutConfig.argv.join(' ')} was called with no config`))
        return
      }

      resolve({calls, exitCode, signal, stderr, stdout})
    })
  })

  return {
    child,
    done,
    signals() {
      const path = `${logPath}.signals`
      return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
    },
    stderr: () => stderr,
    stdout: () => stdout,
    async waitForCalls(count) {
      const deadline = Date.now() + 30_000
      while (readCalls(logPath).length < count) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`monocf ended early:\n${stderr}`)
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} wrangler calls:\n${stderr}`)
        await new Promise((tick) => {
          setTimeout(tick, 50)
        })
      }

      return readCalls(logPath)
    },
  }
}

export function runCli(fixture: Fixture, args: string[], options: RunOptions = {}): Promise<CliResult> {
  return startCli(fixture, args, options).done
}

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, {withFileTypes: true})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * The paths under a directory that are not installed, directories with a trailing slash. It opens no file, so it can
 * look at a tree a live process works in: on Windows, reading a range of a file that process has locked fails with
 * EBUSY. A directory that process removes during the walk counts as gone.
 */
export function listTree(root: string): string[] {
  const paths: string[] = []
  const walk = (dir: string): void => {
    for (const entry of entriesOf(dir)) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      const name = relative(root, path).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        paths.push(`${name}/`)
        walk(path)
      } else {
        paths.push(name)
      }
    }
  }

  walk(root)
  return paths
}

/** This repository's real wrangler, for what monocf has no command of its own to reach. Isolated like a run of monocf. */
export function runRealWrangler(args: string[], cwd: string): {exitCode: number | null; output: string} {
  const cli = join(repoRoot, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js')
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: {...isolatedEnvironment(makeTempDir()), NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false'},
  })
  return {exitCode: result.status, output: result.stdout + result.stderr}
}

/** Everything under a directory that is not installed, with its content, for before-and-after comparisons. */
export function snapshotTree(root: string): Record<string, string> {
  return Object.fromEntries(
    listTree(root).map((path) => [path, path.endsWith('/') ? '' : readFileSync(join(root, path), 'utf8')]),
  )
}

/** The argv of a call without the flags whose values change per run: config and persistence paths, and the release. */
export function argvWithoutConfig(call: WranglerCall): string[] {
  const result: string[] = []
  for (let index = 0; index < call.argv.length; index++) {
    const arg = call.argv[index]
    const isRelease = arg === '--var' && call.argv[index + 1]?.startsWith('RELEASE:')
    if (arg === '--config' || arg === '--persist-to' || isRelease) {
      index++
    } else {
      result.push(arg)
    }
  }

  return result
}

/** The calls that had no worker's config, which every wrangler call except whoami needs. */
export function expectConfigFor(call: WranglerCall, name: string): void {
  if (call.config === null) throw new Error(`wrangler ${call.argv.join(' ')} had no config`)
  const actual = effectiveConfig(call).name
  if (actual !== name) throw new Error(`wrangler ${call.argv.join(' ')} had the config of ${actual}, not ${name}`)
}

/** The value of RELEASE on this call, if any. */
export function releaseOf(call: WranglerCall): string | undefined {
  return call.argv
    .filter((arg, index) => call.argv[index - 1] === '--var' && arg.startsWith('RELEASE:'))
    .map((arg) => arg.slice('RELEASE:'.length))[0]
}

export function flagValue(call: WranglerCall, flag: string): string | undefined {
  const index = call.argv.indexOf(flag)
  return index === -1 ? undefined : call.argv[index + 1]
}

/** The config wrangler ends up using for this call: the env section wins over the top level, as in wrangler. */
export function effectiveConfig(call: WranglerCall): WranglerConfig {
  const env = flagValue(call, '--env')
  const config = call.config ?? {}
  return env ? {...config, ...config.env?.[env]} : config
}

/** Deployed worker names in call order, for one wrangler subcommand. */
export function deployedNames(calls: WranglerCall[], subcommand: string): string[] {
  return calls
    .filter((call) => call.argv.join(' ').startsWith(subcommand))
    .map((call) => effectiveConfig(call).name as string)
}

export function fromRoot(fixture: Fixture, path: string): string {
  return relative(fixture.root, path).replaceAll('\\', '/')
}
