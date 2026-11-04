import {execFileSync, spawn} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, relative} from 'node:path'
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
  /** Install the fake wrangler. Defaults to true. */
  fakeWrangler?: boolean
}

export interface WranglerCall {
  argv: string[]
  cwd: string
  config: WranglerConfig | null
  configs: WranglerConfig[]
  devVars: Record<string, string> | null
  secretFile?: {name: string; vars: Record<string, string> | null}
}

export interface Fixture {
  root: string
  worker(name: string): string
}

export interface WranglerRule {
  command: string
  worker?: string
  exitCode?: number
  signal?: string
  stdout?: string
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
    name: 'wrangler',
    type: 'module',
    version: '0.0.0-fake',
  })
  const script = pathToFileURL(join(helpersDir, 'fake-wrangler.mjs')).href
  writeFile(join(packageDir, 'bin', 'wrangler.js'), `await import(${JSON.stringify(script)})\n`)
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

  if (options.fakeWrangler !== false) installFakeWrangler(root)

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

  return {root, worker: (name) => join(root, 'workers', name)}
}

export interface RunOptions {
  /** Directory to run from, relative to the fixture root. Defaults to the root. */
  cwd?: string
  env?: Record<string, string>
  rules?: WranglerRule[]
}

function readCalls(logPath: string): WranglerCall[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function runCli(fixture: Fixture, args: string[], options: RunOptions = {}): Promise<CliResult> {
  const stateDir = makeTempDir()
  const logPath = join(stateDir, 'calls.ndjson')
  const rulesPath = join(stateDir, 'rules.json')
  writeJson(rulesPath, options.rules ?? [])

  const child = spawn(process.execPath, [join(repoRoot, 'bin', 'run.js'), ...args], {
    cwd: options.cwd ? join(fixture.root, options.cwd) : fixture.root,
    env: {
      ...process.env,
      FAKE_WRANGLER_LOG: logPath,
      FAKE_WRANGLER_RULES: rulesPath,
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

  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode, signal) => {
      resolve({calls: readCalls(logPath), exitCode, signal, stderr, stdout})
    })
  })
}

/** The argv of a call without its config flags, whose values are temp paths. */
export function argvWithoutConfig(call: WranglerCall): string[] {
  const result: string[] = []
  for (let index = 0; index < call.argv.length; index++) {
    const arg = call.argv[index]
    if (arg === '-c' || arg === '--config') {
      index++
    } else if (!arg.startsWith('--config=')) {
      result.push(arg)
    }
  }

  return result
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
