import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {accountIdOf, readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError, type ResolvedWorker} from '../config/types.js'
import {assertResolved} from '../config/validate.js'
import {EXIT_FAILED, EXIT_OK, MonocfError} from '../errors.js'
import {doHash, triggersHash, triggersOf, type Triggers} from '../fingerprint/fingerprint.js'
import {buildGraph} from '../graph/graph.js'
import {nearestWithin} from '../graph/order.js'
import type {OptionFlags} from '../project/options.js'
import {formatRunSummary} from '../report/run-summary.js'
import {materialiseConfig} from '../runtime/materialise.js'
import type {RunDir} from '../runtime/run-dir.js'
import {runKey, type StateWorker} from '../state/manifest.js'
import {parseRunRecord, RUN_RECORD_SCHEMA_VERSION, VALID_RUN_ID, type RecordResult, type RunRecord} from '../state/run-record.js'
import {openStateStore, parseStateUrl, type StateStore} from '../state/store.js'
import {locateWrangler} from '../wrangler/locate.js'
import {readActiveVersion} from '../wrangler/read.js'
import {
  accountMarker,
  DEFAULT_CONCURRENCY,
  newRunId,
  readManifest,
  runDeploySteps,
  stateCall,
  StateWriter,
  verifyActive,
  workerCall,
  writeRunRecord,
  type DeployStep,
} from './deployment.js'
import {loadOptions, selectNamed} from './project.js'
import {accountOf, runStep, withRun, type RunContext} from './run.js'

export interface RollbackFlags extends OptionFlags {
  dryRun?: boolean
  force?: boolean
  json?: boolean
  state?: string
  to?: string
  toRun?: string
}

/** Nothing compares equal to this, so the next plan uploads over a version the state knows nothing about. */
const UNKNOWN = 'unknown-after-rollback'

interface Target {
  /** What the state should say once this version is live. Undefined means that nothing says what the version holds. */
  knownEntry?: StateWorker
  message: string
  /** Why this worker stays as it is, unless forced. */
  refusal?: string
  restoreTriggers?: Triggers
  versionId?: string
  worker: ResolvedWorker
}

function assertFlags(workerName: string | undefined, {force, state, to, toRun}: RollbackFlags): void {
  if (state === undefined) throw new ConfigError('rollback needs --state.')
  if (toRun !== undefined && (workerName !== undefined || to !== undefined)) {
    throw new ConfigError('Give --to-run, or a worker and --to, not both.')
  }

  if (toRun === undefined && (workerName === undefined || to === undefined)) {
    throw new ConfigError('rollback needs --to-run <run-id>, or a worker and --to <version-id>.')
  }

  if (toRun !== undefined && !VALID_RUN_ID.test(toRun)) throw new ConfigError(`--to-run ${toRun} isn't a run ID.`)
  if (to?.trim() === '') throw new ConfigError('--to must not be empty.')
  if (workerName !== undefined && !force) {
    throw new ConfigError(`With no run record, monocf can't check Durable Object compatibility for ${workerName}. Pass --force to accept that.`)
  }
}

/** Holds only what `triggers deploy` reads, so that nothing else about the worker can change. */
function writeTriggersConfig(worker: ResolvedWorker, env: string, triggers: Triggers, runDir: RunDir): string {
  const dir = join(runDir.workerDir(worker.dir), 'triggers')
  mkdirSync(dir, {recursive: true})
  const path = join(dir, 'wrangler.json')
  const accountId = accountIdOf(worker.config, env)
  writeFileSync(
    path,
    JSON.stringify({
      ...(accountId !== undefined && {account_id: accountId}),
      name: worker.deployedName,
      ...(triggers.previewUrls !== null && {preview_urls: triggers.previewUrls}),
      ...(triggers.routes.length > 0 && {routes: triggers.routes}),
      triggers: {crons: triggers.crons ?? []},
      workers_dev: triggers.workersDev,
    }),
  )
  return path
}

interface TargetInputs {
  env: string
  force: boolean
  manifest: Record<string, StateWorker>
  runId: string
  worker: ResolvedWorker
}

function refusalOf({dir}: ResolvedWorker, hasPrevious: boolean): string {
  return hasPrevious
    ? `${dir}: its Durable Object classes differ between these versions. Cloudflare can take this with exit 0 and leave a class broken. Pass --force to accept that.`
    : `${dir}: the record holds no Durable Object information for the earlier version. Pass --force to accept that.`
}

function targetFor(entry: RunRecord['workers'][string], {env, force, manifest, runId, worker}: TargetInputs): Target {
  const current = manifest[worker.dir]
  const {newVersionId, previous, previousVersionId} = entry
  const crossesDo = previous === null || previous.doHash !== (current?.doHash ?? doHash(worker.config, env))
  const restoreTriggers = previous && previous.triggersHash !== current?.triggersHash ? previous.triggers : undefined
  return {
    knownEntry: previous ?? undefined,
    message: `rollback ${runId}`,
    ...(crossesDo && !force && {refusal: refusalOf(worker, previous !== null)}),
    ...(restoreTriggers && {restoreTriggers}),
    ...(previousVersionId !== undefined && newVersionId !== undefined && {versionId: previousVersionId}),
    worker,
  }
}

function targetsFromRun(
  record: RunRecord,
  {env, force, manifest, skip, workers}: Omit<TargetInputs, 'runId' | 'worker'> & {skip: (name: string, message: string) => void; workers: Map<string, ResolvedWorker>},
): Target[] {
  const targets: Target[] = []
  for (const [name, entry] of Object.entries(record.workers)) {
    if (entry.action === 'create' && entry.changed) {
      skip(name, 'This run created it, so it has no earlier version.')
    } else if (entry.changed) {
      const worker = workers.get(name)
      if (worker === undefined) throw new MonocfError(`${name} is in the run record, and this checkout has no such worker.`, EXIT_FAILED)
      targets.push(targetFor(entry, {env, force, manifest, runId: record.runId, worker}))
    }
  }

  return targets
}

function callersFirst(workers: ResolvedWorker[], names: string[]): Map<string, string[]> {
  const callees = nearestWithin(buildGraph(workers), names)
  const callers = new Map<string, string[]>(names.map((name) => [name, []]))
  for (const [caller, list] of callees) {
    for (const callee of list) callers.get(callee)?.push(caller)
  }

  return callers
}

function describeTarget({refusal, restoreTriggers, versionId, worker}: Target): string {
  if (refusal) return `would refuse: ${refusal}`
  const parts = [
    ...(versionId === undefined ? [] : [`versions deploy ${versionId}@100%`]),
    ...(restoreTriggers ? [`triggers deploy with crons ${JSON.stringify(restoreTriggers.crons ?? [])}`] : []),
  ]
  return `${worker.dir}: ${parts.join(', then ') || 'nothing to do'}`
}

interface Execution {
  context: RunContext
  env: string
  runId: string
  store: StateStore
  targets: Target[]
  workers: ResolvedWorker[]
  writer: StateWriter
}

function unknownEntry(worker: ResolvedWorker, env: string, current: StateWorker | undefined, versionId: string): StateWorker {
  const triggers = triggersOf(worker.config, env)
  return {
    commit: UNKNOWN,
    deployedName: worker.deployedName,
    doHash: doHash(worker.config, env),
    triggers,
    triggersHash: triggersHash(triggers),
    ...current,
    bundleHash: UNKNOWN,
    configHash: UNKNOWN,
    deployedAt: new Date().toISOString(),
    externalHash: UNKNOWN,
    fingerprint: UNKNOWN,
    versionId,
  }
}

async function restore({context, env, runId, writer}: Execution, target: Target, attempt: number, record: RunRecord['workers'][string]) {
  const {knownEntry, message, restoreTriggers, versionId, worker} = target
  const {dir, deployedName} = worker
  const accountId = accountOf(context, worker, env)
  const shared = {accountId, mode: {prefix: `[${dir}] `}, worker: dir}
  const call = workerCall(context, dir)

  if (versionId !== undefined) {
    const active = await readActiveVersion(call, deployedName, accountId)
    if (attempt === 1 && active.state === 'active') record.previousVersionId = active.versionId
    if (active.state !== 'active' || active.versionId !== versionId) {
      await runStep(context, {
        ...shared,
        argvOptions: {env, message: `${message} ${runId}`},
        step: {action: 'versions-deploy', configPath: materialiseConfig(worker, context.runDir), versionId},
      })
    }

    await verifyActive(call, {accountId, deployedName, dir}, versionId)
    record.newVersionId = versionId
    record.changed = true
  }

  if (restoreTriggers) {
    const configPath = writeTriggersConfig(worker, env, restoreTriggers, context.runDir)
    await runStep(context, {...shared, argvOptions: {}, step: {action: 'triggers-deploy', configPath}})
    record.changed = true
  }

  const current = writer.manifest.workers[dir]
  const live = versionId ?? current?.versionId
  if (live !== undefined) {
    const marker = accountMarker(context, worker, env)
    const entry = knownEntry ? {...knownEntry, deployedAt: new Date().toISOString(), versionId: live} : unknownEntry(worker, env, current, live)
    writer.update(dir, {...entry, ...(marker !== undefined && {accountHash: marker})})
  }

  return versionId
}

async function execute(execution: Execution, records: RunRecord['workers']): Promise<void> {
  const {context, targets, workers} = execution
  const callers = callersFirst(workers, targets.map(({worker}) => worker.dir))
  const byName = new Map(targets.map((target) => [target.worker.dir, target]))
  const steps: DeployStep[] = targets.map((target) => ({
    action: 'rollback',
    dependsOn: callers.get(target.worker.dir) ?? [],
    async run(attempt) {
      if (target.refusal) throw new MonocfError(target.refusal, EXIT_FAILED)
      return restore(execution, target, attempt, records[target.worker.dir])
    },
    worker: target.worker.dir,
  }))

  const results: Record<string, RecordResult> = {cancelled: 'cancelled', failed: 'failed', skipped: 'skipped', succeeded: 'ok'}
  await runDeploySteps(context, {
    concurrency: DEFAULT_CONCURRENCY,
    onResult(step, result) {
      const record = records[step.worker]
      record.result = results[result.status]
      if (result.status === 'failed') {
        const {exitCode, message} = result.error as Error & {exitCode?: number}
        record.message = message
        if (byName.get(step.worker)?.refusal) record.result = 'refused'
        else if (exitCode !== undefined && exitCode > 128) record.result = 'cancelled'
      }

      if (result.status === 'skipped') record.reason = result.reason
    },
    steps,
  })
}

/**
 * `monocf rollback`: puts back the versions a run replaced, callers first, so that nothing new ever calls something old that
 * it no longer fits. Code, vars and secrets follow the version. Crons don't, so they are restored apart.
 */
export async function runRollback(workerName: string | undefined, flags: RollbackFlags): Promise<void> {
  assertFlags(workerName, flags)
  const options = loadOptions(flags)
  const {env, rootDir} = options
  if (env === undefined) throw new ConfigError('rollback needs --env.')
  const location = parseStateUrl(flags.state!)
  const wrangler = locateWrangler(rootDir)
  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  const {ignored, selected} = selectNamed(options, workerName === undefined ? [] : [workerName])
  assertResolved(selected, project)
  const notIgnored = project.workers.filter(({dir}) => !ignored.includes(dir))
  const workers = new Map(notIgnored.map((worker) => [worker.dir, worker]))
  const json = flags.json === true
  const runId = newRunId()
  const startedAt = new Date().toISOString()
  let exitCode: number = EXIT_OK

  await withRun({action: 'rollback', env, json, notices: [{message: `Run ${runId}.`}], resolved: project.workers, rootDir, workers: selected, wrangler}, async (context) => {
    const store = openStateStore(location, stateCall(context), context.runDir.path)
    await store.check()
    const manifest = await readManifest(store, env)
    const before = structuredClone(manifest.workers)
    const records: RunRecord['workers'] = {}
    const skip = (name: string, message: string): void => {
      records[name] = {action: 'rollback', changed: false, deployedName: workers.get(name)?.deployedName ?? name, message, previous: before[name] ?? null, result: 'skipped'}
      context.emit({message: `${name}: ${message}`, type: 'notice', worker: name})
    }

    let commit = 'unknown'
    let targets: Target[]
    if (flags.toRun === undefined) {
      const worker = workers.get(workerName!)!
      context.emit({message: `${workerName}: Durable Object compatibility can't be checked without a run record, and --force accepts that.`, type: 'notice', worker: workerName})
      targets = [{message: 'rollback', versionId: flags.to!, worker}]
    } else {
      const body = await store.read(runKey(env, flags.toRun))
      if (body === null) throw new ConfigError(`${flags.state} has no run ${flags.toRun} for ${env}.`)
      const record = parseRunRecord(body, env, flags.toRun)
      commit = record.commit
      targets = targetsFromRun(record, {env, force: flags.force === true, manifest: manifest.workers, skip, workers})
    }

    if (flags.dryRun) {
      for (const target of targets) context.emit({message: describeTarget(target), type: 'notice', worker: target.worker.dir})
      exitCode = targets.some(({refusal}) => refusal) ? EXIT_FAILED : EXIT_OK
      return exitCode
    }

    for (const {worker} of targets) {
      records[worker.dir] = {action: 'rollback', changed: false, deployedName: worker.deployedName, previous: before[worker.dir] ?? null, result: 'unchanged'}
    }

    const writer = new StateWriter(store, env, manifest)
    await execute({context, env, runId, store, targets, workers: notIgnored, writer}, records)
    await writer.settled()

    const record: RunRecord = {commit, env, finishedAt: new Date().toISOString(), kind: 'rollback', runId, schemaVersion: RUN_RECORD_SCHEMA_VERSION, startedAt, workers: records}
    const recordFailure = await writeRunRecord(store, record)
    const problems = [
      ...writer.failures.map((message) => `State was not written: ${message}`),
      ...(recordFailure === undefined ? [] : [`The run record was not written: ${recordFailure}`]),
    ]
    process.stderr.write(formatRunSummary(record, problems))
    context.interrupts.throwIfInterrupted()
    const unfinished = targets.some(({worker}) => records[worker.dir].result !== 'ok')
    exitCode = unfinished || problems.length > 0 ? EXIT_FAILED : EXIT_OK
    return exitCode
  })

  process.exitCode = exitCode
}
