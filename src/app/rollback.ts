import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {accountIdOf, readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError, type ResolvedWorker} from '../config/types.js'
import {assertResolved} from '../config/validate.js'
import {EXIT_FAILED, EXIT_OK, MonocfError} from '../errors.js'
import {doHash, triggersHash, triggersOf, type Triggers} from '../fingerprint/fingerprint.js'
import {buildGraph} from '../graph/graph.js'
import {nearestWithin} from '../graph/order.js'
import {directBindingCallers} from '../plan/plan.js'
import type {OptionFlags} from '../project/options.js'
import {IGNORE_FILE} from '../project/workers.js'
import {formatRunSummary} from '../report/run-summary.js'
import {materialiseConfig} from '../runtime/materialise.js'
import type {RunDir} from '../runtime/run-dir.js'
import {runKey, type StateWorker} from '../state/manifest.js'
import {parseRunRecord, RUN_RECORD_SCHEMA_VERSION, VALID_RUN_ID, type RecordResult, type RunRecord} from '../state/run-record.js'
import {openStateStore, parseStateUrl, type StateStore} from '../state/store.js'
import {locateWrangler} from '../wrangler/locate.js'
import {readActiveVersion} from '../wrangler/read.js'
import {withReadRetries} from '../wrangler/retry.js'
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
import {accountOf, callWrangler, runStep, withRun, type RunContext} from './run.js'

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
  /** The entry from before the run, for what an unknown entry can still say: its Durable Objects and triggers. */
  earlier?: StateWorker
  /** A route the restored triggers can't remove, as wrangler only publishes a list with something in it. */
  keptRoutes?: Triggers['routes']
  /** What the state should say once this version is live. Undefined means that nothing says what the version holds. */
  knownEntry?: StateWorker
  /** It needs a new version once it's back on this one. */
  mark?: true
  message: string
  /** What a person should know about the result. */
  notes?: string[]
  /** Why this worker stays as it is, unless forced. */
  refusal?: string
  restoreTriggers?: Triggers
  /** A `versions deploy` has started and hasn't been verified, so what happened has to be read rather than assumed. */
  restoring?: boolean
  /** The run says it left this worker alone without finishing, so all that's left is to check that. */
  verifyOnly?: true
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
  /** What this run created that the worker calls through a binding. */
  createdCallees: string[]
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

type RecordEntry = RunRecord['workers'][string]

/** The triggers to put back: the state moved, or a step that may have taken effect meant to move them. */
function triggersToRestore({changed, planned, previous}: RecordEntry, current: StateWorker | undefined): Triggers | undefined {
  if (previous === null) return undefined
  const meantTo = changed !== false && planned !== undefined && planned.triggersHash !== previous.triggersHash
  return meantTo || previous.triggersHash !== current?.triggersHash ? previous.triggers : undefined
}

function crossesDurableObjects({changed, planned, previous}: RecordEntry, currentDoHash: string): boolean {
  if (previous === null || previous.doHash !== currentDoHash) return true
  return changed !== false && planned !== undefined && planned.doHash !== previous.doHash
}

/** What the run attached that restored triggers can't take away: wrangler only publishes a list with something in it. */
function routesLeftBehind({planned}: RecordEntry, current: StateWorker | undefined, restored: Triggers | undefined): Triggers['routes'] | undefined {
  const routes = planned?.triggers.routes ?? current?.triggers.routes ?? []
  return restored?.routes.length === 0 && routes.length > 0 ? routes : undefined
}

function routesNote(routes: Triggers['routes']): string {
  return routes.length === 1
    ? 'This run added a route that stays attached, as wrangler can\'t remove the last one. Remove it by hand.'
    : 'This run added routes that stay attached, as wrangler can\'t remove the last one. Remove them by hand.'
}

function refusalsFor(entry: RecordEntry, {createdCallees, currentDoHash, recreated, worker}: {createdCallees: string[]; currentDoHash: string; recreated: boolean; worker: ResolvedWorker}): string[] {
  const unreachable = `${worker.dir}: this run recreated ${createdCallees.join(', ')}, and its earlier version can't reach what it calls until it gets a new version. Pass --force to accept that, and the next plan gives it a new version.`
  return [...(crossesDurableObjects(entry, currentDoHash) ? [refusalOf(worker, entry.previous !== null)] : []), ...(recreated && createdCallees.length > 0 ? [unreachable] : [])]
}

const NEEDS_NEW_VERSION = "Its earlier version can't reach a provider that was recreated, so it stays broken for now. The next plan gives it a new version."

function versionToRestore({action, changed, newVersionId, previousVersionId}: RecordEntry): string | undefined {
  return newVersionId !== undefined || (changed === 'unknown' && action !== 'triggers') ? previousVersionId : undefined
}

function targetFor(entry: RecordEntry, {createdCallees, env, force, manifest, runId, worker}: TargetInputs): Target {
  const message = `rollback ${runId}`
  const {changed, previous, previousVersionId} = entry
  if (changed === false && previousVersionId !== undefined) return {message, verifyOnly: true, versionId: previousVersionId, worker}

  const current = manifest[worker.dir]
  const restoreTriggers = triggersToRestore(entry, current)
  const keptRoutes = routesLeftBehind(entry, current, restoreTriggers)
  const versionId = versionToRestore(entry)
  const recreated = entry.reasons?.includes('provider-recreated') === true
  const refusals = refusalsFor(entry, {createdCallees, currentDoHash: current?.doHash ?? doHash(worker.config, env), recreated, worker})
  const notes = [...(recreated ? [NEEDS_NEW_VERSION] : []), ...(keptRoutes ? [routesNote(keptRoutes)] : [])]
  return {
    ...(previous && {earlier: previous}),
    ...(keptRoutes && {keptRoutes}),
    // A version the entry doesn't name may be a manual hotfix or what a crash left, so the entry can't speak for it.
    ...(previous && previous.versionId === previousVersionId && {knownEntry: previous}),
    ...(recreated && {mark: true as const}),
    message,
    ...(notes.length > 0 && {notes}),
    ...(refusals.length > 0 && !force && {refusal: refusals.join(' ')}),
    ...(restoreTriggers && {restoreTriggers}),
    ...(versionId !== undefined && {versionId}),
    worker,
  }
}

interface NoTarget {
  message: string
  /** Nothing says this worker is as it should be, so the rollback can't report success. */
  unresolved?: true
}

/** Why a worker in the record can't be put back, if so. Undefined means there's a target, or nothing to do for a run that finished. */
function noTarget({action, changed, previousVersionId}: RecordEntry): NoTarget | undefined {
  if (action === 'create') {
    if (changed === true) return {message: 'This run created it, so it has no earlier version.'}
    if (changed === false) return {message: 'This run stopped before creating it, so there is nothing to put back.'}
    return {message: 'This run may have created it, and it has no earlier version. Check it by hand.', unresolved: true}
  }

  if (action === 'adopt' && changed !== false) {
    return {message: "This run applied triggers to a version already live, and nothing records what they were. Check them by hand.", unresolved: true}
  }

  if (previousVersionId !== undefined) return undefined
  return changed === false ? {message: 'This run stopped before changing it, so there is nothing to put back.'} : {message: 'This run may have changed it, and nothing says what was live before. Check it by hand.', unresolved: true}
}

function targetsFromRun(
  record: RunRecord,
  {env, force, graph, ignored, manifest, skip, workers}: Omit<TargetInputs, 'createdCallees' | 'runId' | 'worker'> & {graph: ReturnType<typeof buildGraph>; ignored: string[]; skip: (name: string, reason: NoTarget) => void; workers: Map<string, ResolvedWorker>},
): Target[] {
  const created = Object.entries(record.workers).filter(([, {action, changed}]) => action === 'create' && changed !== false).map(([name]) => name)
  const targets: Target[] = []
  for (const [name, entry] of Object.entries(record.workers)) {
    const unsettled = entry.result === 'failed' || entry.result === 'cancelled' || entry.result === 'refused'
    if (entry.changed !== false || unsettled) {
      const reason = ignored.includes(name) ? {message: `${IGNORE_FILE} leaves it out of ${env} now, so this rollback doesn't touch it, and it stays as it is.`} : noTarget(entry)
      if (reason === undefined) {
        const worker = workers.get(name)
        if (worker !== undefined) {
          const createdCallees = created.filter((provider) => directBindingCallers(graph, provider).includes(name))
          targets.push(targetFor(entry, {createdCallees, env, force, manifest, runId: record.runId, worker}))
        } else if (entry.changed === false) {
          skip(name, {message: "This run didn't change it, and this checkout has no such worker, so there is nothing to put back."})
        } else {
          throw new MonocfError(`${name} is in the run record, and this checkout has no such worker.`, EXIT_FAILED)
        }
      } else {
        skip(name, reason)
      }
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

function describeTarget({notes = [], refusal, restoreTriggers, verifyOnly, versionId, worker}: Target): string {
  if (refusal) return `would refuse: ${refusal}`
  if (verifyOnly) return `${worker.dir}: check that ${versionId} is still live, as this run didn't change it`
  const parts = [
    ...(versionId === undefined ? [] : [`versions deploy ${versionId}@100%`]),
    ...(restoreTriggers ? [`triggers deploy with crons ${JSON.stringify(restoreTriggers.crons ?? [])}`] : []),
  ]
  return [`${worker.dir}: ${parts.join(', then ') || 'nothing to do'}`, ...notes].join(' ')
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

function restoredEntry({earlier, keptRoutes, knownEntry, restoreTriggers, worker}: Target, env: string, current: StateWorker | undefined, live: string): StateWorker {
  const entry = knownEntry
    ? {...knownEntry, deployedAt: new Date().toISOString(), versionId: live}
    : {...unknownEntry(worker, env, current, live), ...(earlier && {doHash: earlier.doHash, triggers: earlier.triggers, triggersHash: earlier.triggersHash})}
  if (keptRoutes === undefined) return entry
  // The state says what's really attached, so the next plan names it.
  const triggers = {...(restoreTriggers ?? entry.triggers), routes: keptRoutes}
  return {...entry, triggers, triggersHash: triggersHash(triggers)}
}

async function restore({context, env, runId, writer}: Execution, target: Target, attempt: number, record: RunRecord['workers'][string]) {
  const {message, notes, restoreTriggers, verifyOnly, versionId, worker} = target
  const {dir, deployedName} = worker
  const accountId = accountOf(context, worker, env)
  const shared = {accountId, mode: {prefix: `[${dir}] `}, worker: dir}
  const call = workerCall(context, dir)

  // Whatever this step changes, its record has to say what was live for a later `--to-run` to undo it.
  const active = versionId !== undefined || restoreTriggers ? await readActiveVersion(call, deployedName, accountId) : undefined
  if (attempt === 1 && active?.state === 'active') record.previousVersionId = active.versionId

  if (versionId !== undefined) {
    const alreadyLive = active?.state === 'active' && active.versionId === versionId
    if (verifyOnly) {
      if (!alreadyLive) throw new MonocfError(`${dir}: ${versionId} isn't live any more, and this run didn't change it, so there's nothing of its to undo. Use --to to choose a version.`, EXIT_FAILED)
      record.message = 'Already live, nothing to restore.'
      return
    }

    if (!alreadyLive) {
      record.changed = 'unknown'
      target.restoring = true
      await runStep(context, {
        ...shared,
        argvOptions: {env, message: `${message} ${runId}`},
        step: {action: 'versions-deploy', configPath: materialiseConfig(worker, context.runDir), versionId},
      })
    }

    await verifyActive(call, {accountId, deployedName, dir}, versionId)
    target.restoring = false
    record.newVersionId = versionId
    if (record.changed !== false) record.changed = true
  }

  if (restoreTriggers) {
    const configPath = writeTriggersConfig(worker, env, restoreTriggers, context.runDir)
    record.changed = 'unknown'
    await runStep(context, {...shared, argvOptions: {}, step: {action: 'triggers-deploy', configPath}})
    record.changed = true
  }

  if (notes) record.message = notes.join(' ')

  const current = writer.manifest.workers[dir]
  const live = versionId ?? current?.versionId
  if (live !== undefined) {
    const marker = accountMarker(context, worker, env)
    writer.update(dir, {...restoredEntry(target, env, current, live), ...(marker !== undefined && {accountHash: marker})})
  }

  return versionId
}

/**
 * A `versions deploy` that failed or was cancelled may or may not have taken effect, and what's live says which. A failed read
 * leaves it unknown, which a later rollback treats as changed. Triggers can't be read back, so a failure there stays unknown too.
 * `persist`, as this follows a signal too.
 */
async function readWhatHappened({context, env}: Execution, {versionId, worker}: Target, record: RunRecord['workers'][string]): Promise<void> {
  const call = withReadRetries((read, accountId) => callWrangler(context, read, {accountId, persist: true, worker: worker.dir}))
  try {
    const active = await readActiveVersion(call, worker.deployedName, accountOf(context, worker, env))
    if (active.state !== 'active') return
    if (active.versionId === versionId) {
      record.newVersionId = versionId
      record.changed = true
    } else if (active.versionId === record.previousVersionId) {
      record.changed = false
    }
  } catch {
    // It stays unknown: this is what a failed read says.
  }
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

  await Promise.all(targets.filter(({restoring}) => restoring).map((target) => readWhatHappened(execution, target, records[target.worker.dir])))
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
    const skip = (name: string, {message, unresolved}: NoTarget): void => {
      records[name] = {action: 'rollback', changed: false, deployedName: project.workers.find(({dir}) => dir === name)?.deployedName ?? name, message, previous: before[name] ?? null, result: unresolved ? 'refused' : 'skipped'}
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
      // The whole graph: a caller's earlier version can't reach a provider this run recreated, even one that's ignored now.
      targets = targetsFromRun(record, {env, force: flags.force === true, graph: buildGraph(project.workers), ignored, manifest: manifest.workers, skip, workers})
    }

    if (flags.dryRun) {
      for (const target of targets) context.emit({message: describeTarget(target), type: 'notice', worker: target.worker.dir})
      exitCode = targets.some(({refusal}) => refusal) || Object.values(records).some(({result}) => result === 'refused') ? EXIT_FAILED : EXIT_OK
      return exitCode
    }

    for (const {worker} of targets) {
      records[worker.dir] = {action: 'rollback', changed: false, deployedName: worker.deployedName, previous: before[worker.dir] ?? null, result: 'unchanged'}
    }

    const writer = new StateWriter(store, env, manifest)
    const marks = targets.filter(({mark, refusal}) => mark && !refusal).map(({worker}) => worker.dir)
    for (const {notes, refusal, worker} of targets) {
      if (notes && !refusal) context.emit({message: `${worker.dir}: ${notes.join(' ')}`, type: 'notice', worker: worker.dir})
    }

    // Before the old version is back, so a crash in between leaves the need on record.
    if (marks.length > 0) await writer.mark(marks)
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
    const unfinished = targets.some(({worker}) => records[worker.dir].result !== 'ok') || Object.values(records).some(({result}) => result === 'refused')
    exitCode = unfinished || problems.length > 0 ? EXIT_FAILED : EXIT_OK
    return exitCode
  })

  process.exitCode = exitCode
}
