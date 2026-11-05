import {mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import {isAbsolute, join, relative, resolve} from 'node:path'

import {envSection, readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError, isPlainObject, type RawConfig, type ResolvedWorker} from '../config/types.js'
import {validateSelection} from '../config/validate.js'
import {EXIT_FAILED, MonocfError} from '../errors.js'
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
  fingerprint: string
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

function describeWorker(worker: ResolvedWorker, outdir: string, env: string): ManifestWorker {
  const {config, deployedName} = worker
  const bundle = bundleHash(readBundleFiles(outdir))
  const hash = configHash(config, env)
  const triggers = triggersOf(config, env)
  const {vars} = envSection(config, env)
  const version = isPlainObject(vars) ? vars.VERSION : undefined
  return {
    bundleHash: bundle,
    configHash: hash,
    deployedName,
    doHash: doHash(config, env),
    fingerprint: fingerprintOf(bundle, hash),
    triggers,
    triggersHash: triggersHash(triggers),
    ...(version !== undefined && {version: String(version)}),
  }
}

/** Reports a service binding naming an entrypoint that its provider's bundle doesn't export. */
function checkEntrypoints({emit}: Pick<RunContext, 'emit'>, workers: ResolvedWorker[], out: string, env: string): number {
  const bundled = new Set(workers.map(({dir}) => dir))
  let errors = 0
  for (const {bindings, dir} of workers) {
    for (const {binding, entrypoint, target} of bindings) {
      if (entrypoint !== undefined && target.kind === 'local' && bundled.has(target.dir)) {
        const names = parseExportNames(readFileSync(join(out, target.dir, 'index.js'), 'utf8'))
        if (!names) {
          const message = `${dir}: could not read the exports of ${target.dir}, so entrypoint ${entrypoint} of ${binding} is unchecked.`
          emit({env, level: 'warning', message, rule: 'unknown-entrypoint', type: 'finding', worker: dir})
        } else if (!names.includes(entrypoint)) {
          errors++
          const message = `${dir}: binding ${binding} names entrypoint ${entrypoint}, which ${target.dir} does not export.`
          emit({env, level: 'error', message, rule: 'unknown-entrypoint', type: 'finding', worker: dir})
        }
      }
    }
  }

  return errors
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : Number(a > b)
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
  assertSafeOut(out, workers, rootDir)
  const wrangler = locateWrangler(rootDir)

  const notices: {message: string; worker?: string}[] = project.notices
    .filter(({worker}) => selected.includes(worker))
    .map(({message, worker}) => ({message, worker}))
  const commit = resolveCommit(rootDir, (message) => {
    notices.push({message})
  })
  const manifestPath = join(out, MANIFEST_FILE)
  const json = flags.json === true

  await withRun({action: 'bundle', env, json, notices, rootDir, workers: selected, wrangler}, async (context) => {
    // Only a complete run writes a manifest, so an old one must not outlive a failed run.
    rmSync(manifestPath, {force: true})
    mkdirSync(out, {recursive: true})

    const described = new Map<string, ManifestWorker>()
    await runWorkerSteps(context, {
      action: 'bundle',
      concurrency: flags.concurrency ?? defaultBuildConcurrency(),
      steps: workers.map((worker) => ({
        dependsOn: [],
        async run(mode) {
          const outdir = join(out, worker.dir)
          rmSync(outdir, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
          await runStep(context, {
            argvOptions: {env},
            cwd: worker.path,
            mode,
            step: {
              action: 'build',
              configPath: materialiseConfig({...worker, config: withoutMinify(worker.config)}, context.runDir),
              outdir,
            },
            worker: worker.dir,
          })
          described.set(worker.dir, describeWorker(worker, outdir, env))
        },
        worker: worker.dir,
      })),
    })

    const manifest: BundleManifest = {
      commit,
      env,
      schemaVersion: SCHEMA_VERSION,
      workers: Object.fromEntries([...described].sort(([a], [b]) => compareNames(a, b))),
      wrangler: wrangler.version,
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    context.emit({manifest, path: manifestPath, type: 'bundle-written'})
    if (!json) process.stdout.write(`${manifestPath}\n`)

    const errors = checkEntrypoints(context, workers, out, env)
    if (errors > 0) throw new MonocfError(`${errors} service bindings name an entrypoint that doesn't exist.`, EXIT_FAILED)
  })
}
