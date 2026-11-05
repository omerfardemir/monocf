import {rmSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

import {runRules, type Finding} from '../check/rules.js'
import {effectiveField, readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError, type ResolvedWorker} from '../config/types.js'
import {EXIT_FAILED, EXIT_OK} from '../errors.js'
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
import {readActiveVersion, readVersionTag, type ActiveInfo, type WranglerCall} from '../wrangler/read.js'
import {buildBundle, checkEntrypoints, readBundleManifest, type BundleManifest} from './bundle.js'
import {loadOptions, resolveCommit, selectNamed} from './project.js'
import {callWrangler, createSink, runWorkerSteps, withRun, type RunContext} from './run.js'

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

function workerNames(flag: string | undefined): string[] {
  if (flag === undefined) return []
  const names = flag.split(',').map((name) => name.trim())
  if (names.includes('')) throw new ConfigError(`--workers ${flag} has an empty name.`)
  return names
}

/** A bundle made elsewhere counts only if it describes exactly what this run would build. */
function reusableBundle(
  dir: string,
  expected: {commit: string; env: string; version: string; workers: ResolvedWorker[]},
): {manifest: BundleManifest} | {mismatch: string} {
  const manifest = readBundleManifest(dir)
  if (!manifest?.workers) return {mismatch: 'it has no readable manifest'}
  if (manifest.schemaVersion !== SCHEMA_VERSION) return {mismatch: `its schema version is ${manifest.schemaVersion}`}
  if (manifest.env !== expected.env) return {mismatch: `it is for env ${manifest.env}`}
  if (expected.commit === 'unknown' || manifest.commit !== expected.commit) return {mismatch: 'it is for another commit'}
  if (manifest.wrangler !== expected.version) return {mismatch: `it was built with wrangler ${manifest.wrangler}`}
  const stale = expected.workers.find(({deployedName, dir: name}) => manifest.workers[name]?.deployedName !== deployedName)
  return stale ? {mismatch: `it doesn't describe ${stale.dir}`} : {manifest}
}

async function bundleFor(
  context: RunContext,
  flags: PlanFlags,
  {commit, env, rootDir, workers}: {commit: string; env: string; rootDir: string; workers: ResolvedWorker[]},
): Promise<BundleManifest> {
  if (flags.bundleDir !== undefined) {
    const dir = resolve(flags.bundleDir)
    const found = reusableBundle(dir, {commit, env, version: context.wrangler.version, workers})
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
  call: WranglerCall,
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
        const accountField = effectiveField(config, env, 'account_id')
        const accountId = typeof accountField === 'string' ? accountField : undefined
        const info = await readActiveVersion(call, deployedName, accountId)
        const tagged =
          info.state === 'active' && needsTag(info, stored.get(dir), deployedName)
            ? {...info, tag: await readVersionTag(call, deployedName, info.versionId, accountId)}
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
  const options = loadOptions(flags)
  const {env, rootDir} = options
  if (env === undefined) throw new ConfigError('plan needs --env.')
  if (flags.state === undefined) throw new ConfigError('plan needs --state.')
  assertNotBlank('--bundle-dir', flags.bundleDir)
  assertNotBlank('--markdown', flags.markdown)
  assertNotBlank('--out', flags.out)
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

  const planPath = flags.out ? resolve(flags.out) : join(rootDir, '.monocf', 'plan', `${env}.json`)
  const markdownPath = flags.markdown === undefined ? undefined : resolve(flags.markdown)
  let plan: Plan | undefined

  await withRun({action: 'plan', env, json, notices, rootDir, workers: selected, wrangler}, async (context) => {
    // A failed run must not leave an older plan for `apply` to find.
    rmSync(planPath, {force: true})
    const bundle = await bundleFor(context, flags, {commit, env, rootDir, workers})

    const call: WranglerCall = (step, accountId) => callWrangler(context, step, accountId)
    const store = openStateStore(location, call, context.runDir.path)
    await store.check()
    const body = await store.read(manifestKey(env))
    const state = body === null ? null : parseStateManifest(body, env)

    const active = await readActiveVersions(context, call, workers, {env, state})
    plan = createPlan(pickWorkers(bundle, selected), state, active, graph, {
      createdAt: new Date().toISOString(),
      onDrift: flags.onDrift ?? 'warn',
      repositoryWorkers: discoverWorkers(options),
      state: store.describe(),
    })

    writeFileAtomic(planPath, `${JSON.stringify(plan, null, 2)}\n`)
    if (markdownPath !== undefined) writeFileSync(markdownPath, formatMarkdown(plan))
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
