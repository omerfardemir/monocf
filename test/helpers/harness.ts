import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {afterEach} from 'vitest'

const helpersDir = dirname(fileURLToPath(import.meta.url))

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
  /** Whether the project has the fake wrangler. Defaults to `fake`. */
  wrangler?: 'fake' | 'none'
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
  worker(name: string): string
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

  if ((options.wrangler ?? 'fake') === 'fake') installFakeWrangler(root)

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

/** What the fake wrangler answers reads with, as Cloudflare would. */
export interface FakeCloudflare {
  /** Bucket name to its objects by key. */
  buckets?: Record<string, Record<string, string>>
  /** Queue name to its consumers, by deployed name. A queue here exists. */
  consumers?: Record<string, Record<string, {max_batch_size?: number; queue: string}>>
  /** Queues that exist with no consumer yet. */
  queues?: string[]
  /** Registered Workflows by name. */
  workflows?: Record<string, {className: string; script: string}>
  /** By deployed name. A worker that isn't here doesn't exist. */
  workers?: Record<
    string,
    {
      active: [versionId: string, percentage: number][]
      /** The names on the active version. */
      secrets?: string[]
      tags?: Record<string, null | string>
      triggeredBy?: Record<string, string>
      streamingTailConsumers?: string[]
      tailConsumers?: string[]
      triggers?: null | {crons?: string[]}
    }
  >
}
