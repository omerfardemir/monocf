import {mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import {isAbsolute, join, parse, relative, resolve} from 'node:path'

import {effectiveField, envSection, readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError, isPlainObject, type RawConfig, type ResolvedWorker} from '../config/types.js'
import {validateSelection} from '../config/validate.js'
import {EXIT_FAILED, MonocfError} from '../errors.js'
import {externalHash, externalInputs, fieldsNeedingDeploy} from '../fingerprint/external.js'
import {
  bundleHash,
  configHash,
  doHash,
  fingerprintOf,
  parseExportNames,
  triggersHash,
  triggersOf,
  type BundleFile,
  type Triggers,
} from '../fingerprint/fingerprint.js'
import type {OptionFlags} from '../project/options.js'
import {SCHEMA_VERSION} from '../report/events.js'
import {materialiseConfig} from '../runtime/materialise.js'
import {locateWrangler} from '../wrangler/locate.js'
import {loadOptions, resolveCommit, selectNamed} from './project.js'
import {defaultBuildConcurrency, runStep, runWorkerSteps, withRun, type RunContext} from './run.js'

export interface BundleFlags extends OptionFlags {
  concurrency?: number
  json?: boolean
  out?: string
}

export interface ManifestWorker {
  bundleHash: string
  configHash: string
  deployedName: string
  doHash: string
  externalHash: string
  fingerprint: string
  /** Fields `wrangler versions upload` can't carry, so that this worker only reaches Cloudflare by `wrangler deploy`. */
  needsDeploy?: string[]
  triggers: Triggers
  triggersHash: string
  version?: string
}

export interface BundleManifest {
  commit: string
  env: string
  schemaVersion: number
  workers: Record<string, ManifestWorker>
  wrangler: string
}

const MANIFEST_FILE = 'manifest.json'

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** A worker's output directory is emptied first, so it must not hold the worker or the project itself. */
function assertSafeOut(out: string, workers: ResolvedWorker[], rootDir: string): void {
  for (const {dir, path} of workers) {
    const target = join(out, dir)
    if (isWithin(target, path) || isWithin(target, rootDir)) {
      throw new ConfigError(`--out ${out} would empty ${target}, which holds source files.`)
    }
  }
}

function readBundleFiles(dir: string): BundleFile[] {
  return readdirSync(dir, {recursive: true, withFileTypes: true})
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return {bytes: readFileSync(path), path: relative(dir, path)}
    })
}

/** The bundle is a comparison key, so a minify setting in the config must not reach it. */
function withoutMinify(config: RawConfig): RawConfig {
  const strip = (section: RawConfig): RawConfig =>
    Object.fromEntries(Object.entries(section).filter(([key]) => key !== 'minify'))
  const env = isPlainObject(config.env)
    ? Object.fromEntries(
        Object.entries(config.env).map(([name, section]) => [name, isPlainObject(section) ? strip(section) : section]),
      )
    : undefined
  return {...strip(config), ...(env && {env})}
}

function describeWorker(worker: ResolvedWorker, out: string, env: string): ManifestWorker {
  const {config, deployedName, path} = worker
  const bundle = bundleHash(readBundleFiles(join(out, worker.dir)))
  const hash = configHash(config, env)
  // After the dry run, because build.command can generate these inputs.
  const external = externalHash(externalInputs(config, env, path), [out])
  const triggers = triggersOf(config, env)
  const {vars} = envSection(config, env)
  const version = isPlainObject(vars) ? vars.VERSION : undefined
  const needsDeploy = fieldsNeedingDeploy(config, env)
  return {
    bundleHash: bundle,
    configHash: hash,
    deployedName,
    doHash: doHash(config, env),
    externalHash: external,
    fingerprint: fingerprintOf(bundle, hash, external),
    ...(needsDeploy.length > 0 && {needsDeploy}),
    triggers,
    triggersHash: triggersHash(triggers),
    ...(version !== undefined && {version: String(version)}),
  }
}

/** Wrangler names the output after the entry file. Whatever can't be read counts as unknown, not as no exports. */
function exportsOf({config, dir}: ResolvedWorker, out: string, env: string): string[] | undefined {
  // With no_bundle the file is the author's own text, so its last export statement needn't list everything.
  if (effectiveField(config, env, 'no_bundle') === true) return undefined
  const main = effectiveField(config, env, 'main')
  const name = typeof main === 'string' ? parse(main).name : 'index'
  try {
    return parseExportNames(readFileSync(join(out, dir, `${name}.js`), 'utf8'))
  } catch {
    return undefined
  }
}

/** Reports a service binding naming an entrypoint that its provider's bundle doesn't export. */
function findBadEntrypoints({emit}: Pick<RunContext, 'emit'>, workers: ResolvedWorker[], out: string, env: string): number {
  const bundled = new Map(workers.map((worker) => [worker.dir, worker]))
  let errors = 0
  for (const {bindings, dir} of workers) {
    for (const {binding, entrypoint, target} of bindings) {
      const provider = target.kind === 'local' ? bundled.get(target.dir) : undefined
      if (entrypoint !== undefined && provider) {
        const names = exportsOf(provider, out, env)
        if (!names) {
          const message = `${dir}: could not read the exports of ${provider.dir}, so entrypoint ${entrypoint} of ${binding} is unchecked.`
          emit({env, level: 'warning', message, rule: 'unknown-entrypoint', type: 'finding', worker: dir})
        } else if (!names.includes(entrypoint)) {
          errors++
          const message = `${dir}: binding ${binding} names entrypoint ${entrypoint}, which ${provider.dir} does not export.`
          emit({env, level: 'error', message, rule: 'unknown-entrypoint', type: 'finding', worker: dir})
        }
      }
    }
  }

  return errors
}

/** A manifest exists at this point, so a failure here leaves one behind, unlike a failed build. */
export function checkEntrypoints(context: Pick<RunContext, 'emit'>, workers: ResolvedWorker[], out: string, env: string): void {
  const errors = findBadEntrypoints(context, workers, out, env)
  if (errors > 0) throw new MonocfError(`${errors} service bindings name an entrypoint that doesn't exist.`, EXIT_FAILED)
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : Number(a > b)
}

export interface BundleJob {
  commit: string
  concurrency?: number
  env: string
  out: string
  rootDir: string
  workers: ResolvedWorker[]
}

/** The manifest an earlier bundle left in this directory, or undefined when there is none to read. */
export function readBundleManifest(out: string): BundleManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(out, MANIFEST_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

/** Builds inside a run that is already going, and returns the manifest it wrote. */
export async function buildBundle(context: RunContext, job: BundleJob): Promise<BundleManifest> {
  const {commit, concurrency, env, out, rootDir, workers} = job
  assertSafeOut(out, workers, rootDir)
  const manifestPath = join(out, MANIFEST_FILE)

  // Only a complete run writes a manifest, so an old one must not outlive a failed run.
  rmSync(manifestPath, {force: true})
  mkdirSync(out, {recursive: true})

  const described = new Map<string, ManifestWorker>()
  await runWorkerSteps(context, {
    action: 'bundle',
    concurrency: concurrency ?? defaultBuildConcurrency(),
    steps: workers.map((worker) => ({
      dependsOn: [],
      async run(mode) {
        const outdir = join(out, worker.dir)
        rmSync(outdir, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
        await runStep(context, {
          argvOptions: {env},
          mode,
          step: {
            action: 'build',
            configPath: materialiseConfig({...worker, config: withoutMinify(worker.config)}, context.runDir),
            outdir,
          },
          worker: worker.dir,
        })
        described.set(worker.dir, describeWorker(worker, out, env))
      },
      worker: worker.dir,
    })),
  })

  const manifest: BundleManifest = {
    commit,
    env,
    schemaVersion: SCHEMA_VERSION,
    workers: Object.fromEntries([...described].sort(([a], [b]) => compareNames(a, b))),
    wrangler: context.wrangler.version,
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  context.emit({manifest, path: manifestPath, type: 'bundle-written'})
  return manifest
}

/** `monocf bundle`: a dry-run build of each worker in parallel, and a manifest of what would be uploaded. */
export async function runBundle(names: string[], flags: BundleFlags): Promise<void> {
  const options = loadOptions(flags)
  if (flags.out?.trim() === '') throw new ConfigError('--out must not be empty.')
  const {env, rootDir} = options
  if (env === undefined) throw new ConfigError('bundle needs --env.')

  const {selected} = selectNamed(options, names)
  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  validateSelection(selected, options, inputs, project)
  const workers = project.workers.filter(({dir}) => selected.includes(dir))

  const out = flags.out ? resolve(flags.out) : join(rootDir, '.monocf', 'bundle', env)
  const wrangler = locateWrangler(rootDir)

  const notices: {message: string; worker?: string}[] = project.notices
    .filter(({worker}) => selected.includes(worker))
    .map(({message, worker}) => ({message, worker}))
  const commit = resolveCommit(rootDir, (message) => {
    notices.push({message})
  })
  const json = flags.json === true

  await withRun({action: 'bundle', env, json, notices, resolved: workers, rootDir, workers: selected, wrangler}, async (context) => {
    await buildBundle(context, {commit, concurrency: flags.concurrency, env, out, rootDir, workers})
    if (!json) process.stdout.write(`${join(out, MANIFEST_FILE)}\n`)
    checkEntrypoints(context, workers, out, env)
  })
}
