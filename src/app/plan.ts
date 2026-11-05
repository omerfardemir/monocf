import {rmSync} from 'node:fs'
import {join, resolve} from 'node:path'

import {runRules, type Finding} from '../check/rules.js'
import {readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError, type ResolvedWorker} from '../config/types.js'
import {EXIT_ENVIRONMENT, EXIT_FAILED, EXIT_OK, MonocfError} from '../errors.js'
import {buildGraph} from '../graph/graph.js'
import {formatMarkdown, formatSummary} from '../plan/format.js'
import {createPlan, needsTag, type OnDrift, type Plan, type PlanBundle} from '../plan/plan.js'
import {nodeReader} from '../project/load.js'
import {discoverWorkers} from '../project/workers.js'
import type {OptionFlags} from '../project/options.js'
import {SCHEMA_VERSION} from '../report/events.js'
import {writeFileAtomic} from '../runtime/atomic.js'
import {manifestKey, parseStateManifest, type StateManifest} from '../state/manifest.js'
import {openStateStore, parseStateUrl} from '../state/store.js'
import {locateWrangler} from '../wrangler/locate.js'
import {readActiveVersion, readVersionOrigin, type ActiveInfo, type WranglerCall} from '../wrangler/read.js'
import {withReadRetries} from '../wrangler/retry.js'
import {configHash, doHash, triggersHash, triggersOf} from '../fingerprint/fingerprint.js'
import {buildBundle, checkEntrypoints, readBundleManifest, type BundleManifest, type ManifestWorker} from './bundle.js'
import {checkoutHead, isTreeDirty, loadOptions, resolveCommit, selectNamed} from './project.js'
import {accountOf, callWrangler, createSink, runWorkerSteps, withRun, type RunContext} from './run.js'

export interface PlanFlags extends OptionFlags {
  bundleDir?: string
  json?: boolean
  markdown?: string
  onDrift?: OnDrift
  out?: string
  state?: string
  workers?: string
}

const READ_CONCURRENCY = 8

function assertNotBlank(flag: string, value: string | undefined): void {
  if (value?.trim() === '') throw new ConfigError(`${flag} must not be empty.`)
}

/** What's left of an earlier run must not outlive this one's failure: `apply` or a PR comment would pick it up. */
function removeOutput(path: string): void {
  try {
    rmSync(path, {force: true})
  } catch (error) {
    throw new MonocfError(`Can't write ${path}: ${(error as Error).message}`, EXIT_ENVIRONMENT)
  }
}

function writeOutput(path: string, body: string): void {
  try {
    writeFileAtomic(path, body)
  } catch (error) {
    throw new MonocfError(`Can't write ${path}: ${(error as Error).message}`, EXIT_ENVIRONMENT)
  }
}

function workerNames(flag: string | undefined): string[] {
  if (flag === undefined) return []
  const names = flag.split(',').map((name) => name.trim())
  if (names.includes('')) throw new ConfigError(`--workers ${flag} has an empty name.`)
  return names
}

/** Needs no build, and catches another config at the same commit, such as another --base-config. */
function describesConfig(described: ManifestWorker | undefined, {config, deployedName}: ResolvedWorker, env: string): boolean {
  return (
    described?.deployedName === deployedName &&
    described.configHash === configHash(config, env) &&
    described.doHash === doHash(config, env) &&
    described.triggersHash === triggersHash(triggersOf(config, env))
  )
}

/** A bundle made elsewhere counts only if it describes exactly what this run would build. */
function reusableBundle(
  dir: string,
  expected: {commit: string; env: string; rootDir: string; version: string; workers: ResolvedWorker[]},
): {manifest: BundleManifest} | {mismatch: string} {
  const manifest = readBundleManifest(dir)
  if (!manifest?.workers) return {mismatch: 'it has no readable manifest'}
  if (manifest.schemaVersion !== SCHEMA_VERSION) return {mismatch: `its schema version is ${manifest.schemaVersion}`}
  if (manifest.env !== expected.env) return {mismatch: `it is for env ${manifest.env}`}
  if (expected.commit === 'unknown' || manifest.commit !== expected.commit) return {mismatch: 'it is for another commit'}
  if (manifest.wrangler !== expected.version) return {mismatch: `it was built with wrangler ${manifest.wrangler}`}
  if (manifest.dirty !== false) return {mismatch: 'its checkout had changes'}
  if (manifest.head !== checkoutHead(expected.rootDir)) return {mismatch: 'another commit was checked out'}
  if (isTreeDirty(expected.rootDir, dir)) return {mismatch: 'this checkout has changes'}
  const stale = expected.workers.find((worker) => !describesConfig(manifest.workers[worker.dir], worker, expected.env))
  return stale ? {mismatch: `it doesn't describe ${stale.dir}`} : {manifest}
}

async function bundleFor(
  context: RunContext,
  flags: PlanFlags,
  {commit, env, rootDir, workers}: {commit: string; env: string; rootDir: string; workers: ResolvedWorker[]},
): Promise<BundleManifest> {
  if (flags.bundleDir !== undefined) {
    const dir = resolve(flags.bundleDir)
    const found = reusableBundle(dir, {commit, env, rootDir, version: context.wrangler.version, workers})
    if ('manifest' in found) {
      checkEntrypoints(context, workers, dir, env)
      return found.manifest
    }

    context.emit({message: `Not using the bundle in ${dir}, because ${found.mismatch}. Building again.`, type: 'notice'})
  }

  const out = join(rootDir, '.monocf', 'bundle', env)
  const manifest = await buildBundle(context, {commit, env, out, rootDir, workers})
  checkEntrypoints(context, workers, out, env)
  return manifest
}

/** A failed read stops the plan. There's no way to tell what a worker needs without knowing what is live. */
async function readActiveVersions(
  context: RunContext,
  workers: ResolvedWorker[],
  {env, state}: {env: string; state: null | StateManifest},
): Promise<Record<string, ActiveInfo>> {
  const stored = new Map(Object.entries(state?.workers ?? {}))
  const active = new Map<string, ActiveInfo>()
  await runWorkerSteps(context, {
    action: 'read',
    concurrency: READ_CONCURRENCY,
    steps: workers.map(({config, deployedName, dir}) => ({
      dependsOn: [],
      async run() {
        const accountId = accountOf(context, {config, dir}, env)
        const call: WranglerCall = withReadRetries(
          (step, account) => callWrangler(context, step, {accountId: account, worker: dir}),
          context.interrupts.signal,
        )
        const info = await readActiveVersion(call, deployedName, accountId)
        const tagged =
          info.state === 'active' && needsTag(info, stored.get(dir), deployedName)
            ? {...info, ...(await readVersionOrigin(call, deployedName, info.versionId, accountId))}
            : info
        active.set(dir, tagged)
      },
      worker: dir,
    })),
  })
  return Object.fromEntries(active)
}

function pickWorkers(bundle: BundleManifest, selected: string[]): PlanBundle {
  const workers = Object.fromEntries(Object.entries(bundle.workers).filter(([name]) => selected.includes(name)))
  return {commit: bundle.commit, env: bundle.env, workers, wrangler: bundle.wrangler}
}

function reportFindings(findings: Finding[], json: boolean): void {
  const sink = createSink(json)
  for (const {env, level, message, rule, worker} of findings) {
    sink({level, message, rule, type: 'finding', ...(env !== undefined && {env}), ...(worker !== undefined && {worker})})
  }
}

/**
 * `monocf plan`: says what needs deploying, in what order and why, and writes it to a file for `monocf apply`. It only
 * reads from Cloudflare. A plan with a blocked worker is still written, marked as not applicable, and exits 1.
 */
export async function runPlan(flags: PlanFlags): Promise<void> {
  assertNotBlank('--bundle-dir', flags.bundleDir)
  assertNotBlank('--markdown', flags.markdown)
  assertNotBlank('--out', flags.out)
  const markdownPath = flags.markdown === undefined ? undefined : resolve(flags.markdown)
  if (markdownPath !== undefined) removeOutput(markdownPath)
  if (flags.out !== undefined) removeOutput(resolve(flags.out))

  const options = loadOptions(flags)
  const {env, rootDir} = options
  if (env === undefined) throw new ConfigError('plan needs --env.')
  if (flags.state === undefined) throw new ConfigError('plan needs --state.')
  const planPath = flags.out ? resolve(flags.out) : join(rootDir, '.monocf', 'plan', `${env}.json`)
  removeOutput(planPath)
  const location = parseStateUrl(flags.state)
  const {ignored, selected} = selectNamed(options, workerNames(flags.workers))
  const json = flags.json === true

  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  const directories = nodeReader.readDir(join(rootDir, options.workersDirName))
  const findings = runRules({directories, env, ignored, inputs, options, project, reader: nodeReader, selected})
  reportFindings(findings, json)
  const errors = findings.filter(({level}) => level === 'error').length
  if (errors > 0) throw new ConfigError(`${errors} check errors, so there is no plan. See monocf check.`)

  const workers = project.workers.filter(({dir}) => selected.includes(dir))
  const graph = buildGraph(project.workers.filter(({dir}) => !ignored.includes(dir)))
  const wrangler = locateWrangler(rootDir)

  const reported = new Set(findings.map(({message}) => message))
  const notices: {message: string; worker?: string}[] = project.notices
    .filter(({message, worker}) => selected.includes(worker) && !reported.has(message))
    .map(({message, worker}) => ({message, worker}))
  const commit = resolveCommit(rootDir, (message) => {
    notices.push({message})
  })

  let plan: Plan | undefined

  await withRun({action: 'plan', env, json, notices, resolved: workers, rootDir, workers: selected, wrangler}, async (context) => {
    const bundle = await bundleFor(context, flags, {commit, env, rootDir, workers})

    const stateCall = withReadRetries((step) => callWrangler(context, step), context.interrupts.signal)
    const store = openStateStore(location, stateCall, context.runDir.path)
    await store.check()
    const body = await store.read(manifestKey(env))
    const state = body === null ? null : parseStateManifest(body, env)

    const active = await readActiveVersions(context, workers, {env, state})
    plan = createPlan(pickWorkers(bundle, selected), state, active, graph, {
      createdAt: new Date().toISOString(),
      onDrift: flags.onDrift ?? 'warn',
      repositoryWorkers: discoverWorkers(options),
      state: store.describe(),
    })

    // The plan comes last, so that it's there only when everything else is.
    if (markdownPath !== undefined) writeOutput(markdownPath, formatMarkdown(plan))
    writeOutput(planPath, `${JSON.stringify(plan, null, 2)}\n`)
    return plan.applicable ? EXIT_OK : EXIT_FAILED
  })

  if (json) {
    createSink(json)({path: planPath, plan: plan!, type: 'plan'})
  } else {
    process.stderr.write(formatSummary(plan!))
    process.stdout.write(`${planPath}\n`)
  }

  process.exitCode = plan!.applicable ? EXIT_OK : EXIT_FAILED
}
