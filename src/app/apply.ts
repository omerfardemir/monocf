import {execFileSync} from 'node:child_process'
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'

import {readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError, isPlainObject, type ResolvedWorker} from '../config/types.js'
import {assertResolved} from '../config/validate.js'
import {EXIT_FAILED, EXIT_OK} from '../errors.js'
import type {Triggers} from '../fingerprint/fingerprint.js'
import {PLAN_SCHEMA_VERSION, tagFor, type Plan, type PlanStep} from '../plan/plan.js'
import type {OptionFlags, Options} from '../project/options.js'
import {formatRunMarkdown, formatRunSummary} from '../report/run-summary.js'
import {materialiseConfig} from '../runtime/materialise.js'
import type {StateWorker} from '../state/manifest.js'
import {RUN_RECORD_SCHEMA_VERSION, type RecordResult, type RunRecord} from '../state/run-record.js'
import {openStateStore, parseStateUrl} from '../state/store.js'
import type {ArgvOptions} from '../wrangler/argv.js'
import {locateWrangler} from '../wrangler/locate.js'
import {readActiveVersion, readVersionTag, type WranglerCall} from '../wrangler/read.js'
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
  type DeployResult,
  type DeployStep,
} from './deployment.js'
import {checkoutHead, loadOptions} from './project.js'
import {accountOf, runStep, withRun, type RunContext} from './run.js'

export interface ApplyFlags extends OptionFlags {
  concurrency?: number
  expectBranchTip?: string
  json?: boolean
  summaryFile?: string
}

const SHORT_SHA_LENGTH = 7
const MAX_MESSAGE_LENGTH = 999
const NO_TRIGGERS: Triggers = {crons: null, previewUrls: null, routes: [], workersDev: false}
/** Matches no real hash, so the next plan applies the triggers again. */
const TRIGGERS_NOT_APPLIED = 'not-applied'

function readPlanFile(path: string): Plan {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ConfigError(`Can't read the plan ${path}: ${(error as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`The plan ${path} is not valid JSON: ${(error as Error).message}`)
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.steps)) throw new ConfigError(`${path} is not a plan.`)
  return parsed as unknown as Plan
}

function resolveRef(rootDir: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
      cwd: rootDir,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

/** Stale plans stop here, with exit 2 and nothing attempted. CI's variables don't count: only what's really checked out does. */
function assertCanApply(plan: Plan, {expectBranchTip, rootDir, wranglerVersion}: {expectBranchTip?: string; rootDir: string; wranglerVersion: string}): void {
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new ConfigError(`The plan has schema version ${String(plan.schemaVersion)}, and this monocf applies ${PLAN_SCHEMA_VERSION}. Plan again.`)
  }

  if (plan.refused !== undefined) throw new ConfigError(`The plan was refused: ${plan.refused}`)
  if (plan.applicable !== true) throw new ConfigError("The plan is marked as not applicable. Look at what blocks it, then plan again.")
  const head = checkoutHead(rootDir)
  if (head === undefined || head !== plan.commit) {
    throw new ConfigError(`The plan is for commit ${plan.commit}, and ${head ?? 'no commit'} is checked out. Plan on this commit.`)
  }

  if (wranglerVersion !== plan.wrangler) {
    throw new ConfigError(`The plan was made with wrangler ${plan.wrangler}, and ${wranglerVersion} is installed. A different version changes bundles, so plan again.`)
  }

  if (expectBranchTip !== undefined) {
    const tip = resolveRef(rootDir, expectBranchTip)
    if (tip === undefined) throw new ConfigError(`--expect-branch-tip ${expectBranchTip} doesn't resolve to a commit.`)
    if (tip !== plan.commit) throw new ConfigError(`${expectBranchTip} is at ${tip}, and the plan is for ${plan.commit}, so a newer commit has taken over.`)
  }
}

interface Target {
  accountId?: string
  record: RunRecord['workers'][string]
  step: PlanStep
  worker: ResolvedWorker
}

function withEmptyCrons(worker: ResolvedWorker, env: string): ResolvedWorker {
  const envs = isPlainObject(worker.config.env) ? worker.config.env : {}
  const section = isPlainObject(envs[env]) ? envs[env] : {}
  const triggers = isPlainObject(section.triggers) ? section.triggers : {}
  return {...worker, config: {...worker.config, env: {...envs, [env]: {...section, triggers: {...triggers, crons: []}}}}}
}

function hasTriggers({crons, routes}: Triggers): boolean {
  return (crons?.length ?? 0) > 0 || routes.length > 0
}

/** Every worker a step waits for that's in `members`, looking through the ones that aren't. */
function waitsFor(steps: Map<string, PlanStep>, worker: string, members: Set<string>): string[] {
  const found = new Set<string>()
  const seen = new Set([worker])
  const queue = [...(steps.get(worker)?.dependsOn ?? [])]
  while (queue.length > 0) {
    const name = queue.pop()!
    if (!seen.has(name)) {
      seen.add(name)
      if (members.has(name)) found.add(name)
      else queue.push(...(steps.get(name)?.dependsOn ?? []))
    }
  }

  return [...found].sort()
}

interface ApplyRun {
  concurrency: number
  options: Options
  plan: Plan
  runId: string
  startedAt: string
  summaryFile?: string
  targets: Map<string, Target>
}

class Applier {
  private readonly env: string
  private readonly failed = new Map<string, string>()
  private readonly configPaths = new Map<string, string>()
  private readonly stepsByWorker: Map<string, PlanStep>

  constructor(
    private readonly context: RunContext,
    private readonly run: ApplyRun,
    private readonly writer: StateWriter,
  ) {
    this.env = run.plan.env
    this.stepsByWorker = new Map(run.plan.steps.map((step) => [step.worker, step]))
  }

  async execute(): Promise<void> {
    const targets = [...this.run.targets.values()]
    const ofAction = (...actions: PlanStep['action'][]) => targets.filter(({step}) => actions.includes(step.action))

    for (const target of ofAction('skip')) {
      if (target.step.recordState && target.step.previousVersionId !== undefined) {
        this.writer.update(target.step.worker, this.entryFor(target, target.step.previousVersionId))
      }
    }

    const marks = [...new Set(targets.flatMap(({step}) => step.markCallers ?? []))]
    if (marks.length > 0) await this.writer.mark(marks)

    await this.phase(ofAction('create').map((target) => this.deployStep(target)))
    await this.phase(ofAction('upload').map((target) => this.uploadStep(target)), {final: false})
    await this.phase(
      ofAction('upload', 'full-deploy', 'triggers', 'adopt').flatMap((target) => {
        if (target.step.action === 'upload' && !target.record.uploadedVersionId) return []
        if (target.step.action === 'full-deploy') return [this.deployStep(target)]
        if (target.step.action === 'upload') return [this.promoteStep(target)]
        return target.step.action === 'triggers' ? [this.triggersStep(target)] : [this.adoptStep(target)]
      }),
    )
  }

  private blockerOf(worker: string): string | undefined {
    const direct = this.failed.get(worker)
    if (direct !== undefined) return direct
    const everything = new Set(this.stepsByWorker.keys())
    const seen = new Set([worker])
    const queue = [...(this.stepsByWorker.get(worker)?.dependsOn ?? [])]
    while (queue.length > 0) {
      const name = queue.pop()!
      if (!seen.has(name) && everything.has(name)) {
        seen.add(name)
        const blocker = this.failed.get(name)
        if (blocker !== undefined) return blocker
        queue.push(...(this.stepsByWorker.get(name)?.dependsOn ?? []))
      }
    }

    return undefined
  }

  /** What a phase can't start is skipped here, and what fails in it skips what waits for it, through the pool. */
  private async phase(steps: DeployStep[], {final = true}: {final?: boolean} = {}): Promise<void> {
    const runnable: DeployStep[] = []
    for (const step of steps) {
      const blocker = this.blockerOf(step.worker)
      if (blocker === undefined) {
        runnable.push(step)
      } else if (this.run.targets.get(step.worker)!.record.result === 'unchanged') {
        this.settle(step, {id: step.worker, reason: blocker, status: 'skipped'})
        this.context.emit({action: step.action, reason: blocker, status: 'skipped', type: 'step-finished', worker: step.worker})
      }
    }

    const members = new Set(runnable.map(({worker}) => worker))
    await runDeploySteps(this.context, {
      concurrency: this.run.concurrency,
      onResult: (step, result) => this.settle(step, result, final),
      steps: runnable.map((step) => ({...step, dependsOn: final ? waitsFor(this.stepsByWorker, step.worker, members) : []})),
    })
  }

  private settle(step: DeployStep, result: DeployResult, final = true): void {
    const {record} = this.run.targets.get(step.worker)!
    const results: Record<DeployResult['status'], RecordResult> = {cancelled: 'cancelled', failed: 'failed', skipped: 'skipped', succeeded: 'ok'}
    if (result.status === 'succeeded' && !final) return
    record.result = results[result.status]
    if (result.status === 'failed') {
      const {exitCode, message} = result.error as Error & {exitCode?: number}
      if (exitCode !== undefined && exitCode > 128) record.result = 'cancelled'
      record.message = message
      this.failed.set(step.worker, step.worker)
    }

    if (result.status === 'skipped') {
      record.reason = result.reason
      this.failed.set(step.worker, result.reason)
    }
  }

  private call(target: Target): WranglerCall {
    return workerCall(this.context, target.worker.dir)
  }

  private configOf({step, worker}: Target): string {
    let path = this.configPaths.get(worker.dir)
    if (path === undefined) {
      path = materialiseConfig(step.explicitEmptyCrons ? withEmptyCrons(worker, this.env) : worker, this.context.runDir)
      this.configPaths.set(worker.dir, path)
    }

    return path
  }

  private argvOptions({step}: Target): ArgvOptions {
    const {commit} = this.run.plan
    const release = commit.slice(0, SHORT_SHA_LENGTH)
    return {
      env: this.env,
      message: `monocf ${this.run.runId} ${release} ${step.version ?? 'unversioned'}`.slice(0, MAX_MESSAGE_LENGTH),
      minify: this.run.options.minify,
      release,
      tag: tagFor(step.fingerprint),
    }
  }

  private entryFor({step, worker}: Target, versionId: string): StateWorker {
    const account = accountMarker(this.context, worker, this.env)
    return {
      ...(account !== undefined && {accountHash: account}),
      bundleHash: step.bundleHash,
      commit: this.run.plan.commit,
      configHash: step.configHash,
      deployedAt: new Date().toISOString(),
      deployedName: step.deployedName,
      doHash: step.doHash,
      externalHash: step.externalHash,
      fingerprint: step.fingerprint,
      triggers: step.triggers,
      triggersHash: step.triggersHash,
      ...(step.version !== undefined && {version: step.version}),
      versionId,
    }
  }

  private async wrangler(target: Target, step: Parameters<typeof runStep>[1]['step'], argvOptions: ArgvOptions) {
    const {dir} = target.worker
    return runStep(this.context, {accountId: target.accountId, argvOptions, mode: {prefix: `[${dir}] `}, step, worker: dir})
  }

  private async verify(target: Target, versionId: string): Promise<void> {
    await verifyActive(this.call(target), {accountId: target.accountId, deployedName: target.step.deployedName, dir: target.worker.dir}, versionId)
  }

  /** An earlier attempt may have taken effect, as a kill right after `Uploaded` does. Its tag says so, as it left no version ID. */
  private async liveFromEarlierAttempt(target: Target): Promise<string | undefined> {
    const {deployedName, fingerprint} = target.step
    const call = this.call(target)
    const active = await readActiveVersion(call, deployedName, target.accountId)
    if (active.state !== 'active') return undefined
    const tag = await readVersionTag(call, deployedName, active.versionId, target.accountId)
    return tag === tagFor(fingerprint) ? active.versionId : undefined
  }

  private deployStep(target: Target): DeployStep {
    return {
      action: 'deploy',
      dependsOn: [],
      run: async (attempt) => {
        const earlier = attempt > 1 ? await this.liveFromEarlierAttempt(target) : undefined
        const versionId =
          earlier ?? (await this.wrangler(target, {action: 'deploy', configPath: this.configOf(target)}, this.argvOptions(target))).output.versionId!
        await this.verify(target, versionId)
        target.record.newVersionId = versionId
        target.record.changed = true
        this.writer.update(target.worker.dir, this.entryFor(target, versionId), {newVersion: true})
        return versionId
      },
      worker: target.worker.dir,
    }
  }

  /** Reports no version ID: a version only counts as what a worker ended on once it's promoted. */
  private uploadStep(target: Target): DeployStep {
    return {
      action: 'upload',
      dependsOn: [],
      run: async () => {
        const result = await this.wrangler(target, {action: 'preview', configPath: this.configOf(target)}, this.argvOptions(target))
        target.record.uploadedVersionId = result.output.versionId!
      },
      worker: target.worker.dir,
    }
  }

  private promoteStep(target: Target): DeployStep {
    const {dir} = target.worker
    const configPath = (): string => this.configOf(target)
    return {
      action: 'promote',
      dependsOn: [],
      run: async (attempt) => {
        const versionId = target.record.uploadedVersionId!
        const active = attempt > 1 ? await readActiveVersion(this.call(target), target.step.deployedName, target.accountId) : undefined
        if (active?.state !== 'active' || active.versionId !== versionId) {
          const {env, message} = this.argvOptions(target)
          await this.wrangler(target, {action: 'versions-deploy', configPath: configPath(), versionId}, {env, message})
        }

        await this.verify(target, versionId)
        target.record.newVersionId = versionId
        target.record.changed = true

        if (target.step.triggersChanged) {
          try {
            await this.wrangler(target, {action: 'triggers-deploy', configPath: configPath()}, {env: this.env})
          } catch (error) {
            const previous = target.record.previous?.triggers ?? NO_TRIGGERS
            this.writer.update(dir, {...this.entryFor(target, versionId), triggers: previous, triggersHash: TRIGGERS_NOT_APPLIED}, {newVersion: true})
            throw error
          }
        }

        this.writer.update(dir, this.entryFor(target, versionId), {newVersion: true})
        return versionId
      },
      worker: dir,
    }
  }

  private triggersStep(target: Target): DeployStep {
    return {
      action: 'triggers',
      dependsOn: [],
      run: async () => {
        await this.wrangler(target, {action: 'triggers-deploy', configPath: this.configOf(target)}, {env: this.env})
        target.record.changed = true
        this.writer.update(target.worker.dir, this.entryFor(target, target.step.previousVersionId!))
      },
      worker: target.worker.dir,
    }
  }

  /** Already live, by its tag. A run that crashed may have stopped short of its triggers, and applying them again is harmless. */
  private adoptStep(target: Target): DeployStep {
    return {
      action: 'adopt',
      dependsOn: [],
      run: async () => {
        if (hasTriggers(target.step.triggers)) {
          await this.wrangler(target, {action: 'triggers-deploy', configPath: this.configOf(target)}, {env: this.env})
        }

        this.writer.update(target.worker.dir, this.entryFor(target, target.step.previousVersionId!))
      },
      worker: target.worker.dir,
    }
  }
}

function writeSummaryFile(context: RunContext, path: string | undefined, body: string): void {
  if (path === undefined) return
  try {
    mkdirSync(dirname(path), {recursive: true})
    appendFileSync(path, body)
  } catch (error) {
    context.emit({message: `Could not write the summary file ${path}: ${(error as Error).message}`, type: 'notice'})
  }
}

/**
 * `monocf apply`: runs a plan. New workers first, then every upload in parallel, then promotes, callees first. A failure skips
 * what calls that worker, and independent branches carry on. State follows each step, and a run record ends the run.
 */
export async function runApply(planPath: string, flags: ApplyFlags): Promise<void> {
  const plan = readPlanFile(resolve(planPath))
  const options = loadOptions({...flags, env: plan.env})
  const {rootDir} = options
  const wrangler = locateWrangler(rootDir)
  assertCanApply(plan, {expectBranchTip: flags.expectBranchTip, rootDir, wranglerVersion: wrangler.version})
  const location = parseStateUrl(plan.state)

  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  const names = plan.steps.map(({worker}) => worker)
  assertResolved(names, project)
  const workers = new Map(project.workers.map((worker) => [worker.dir, worker]))
  for (const {deployedName, worker} of plan.steps) {
    const resolved = workers.get(worker)
    if (resolved?.deployedName !== deployedName) {
      throw new ConfigError(`The plan deploys ${worker} as ${deployedName}, and this checkout says ${resolved?.deployedName ?? 'nothing'}. Plan again.`)
    }
  }

  const runId = newRunId()
  const startedAt = new Date().toISOString()
  const json = flags.json === true
  let exitCode: number = EXIT_OK

  await withRun({action: 'apply', env: plan.env, json, notices: [{message: `Run ${runId}.`}], resolved: project.workers, rootDir, workers: names, wrangler}, async (context) => {
    const store = openStateStore(location, stateCall(context), context.runDir.path)
    await store.check()
    const manifest = await readManifest(store, plan.env)
    const previousEntries = structuredClone(manifest.workers)
    const writer = new StateWriter(store, plan.env, manifest)

    const targets = new Map(
      plan.steps.map((step): [string, Target] => {
        const worker = workers.get(step.worker)!
        const previous = previousEntries[step.worker] ?? null
        return [
          step.worker,
          {
            accountId: accountOf(context, worker, plan.env),
            record: {
              action: step.action,
              changed: false,
              deployedName: step.deployedName,
              previous,
              ...(step.previousVersionId !== undefined && {previousVersionId: step.previousVersionId}),
              result: 'unchanged',
            },
            step,
            worker,
          },
        ]
      }),
    )

    const applier = new Applier(context, {concurrency: flags.concurrency ?? DEFAULT_CONCURRENCY, options, plan, runId, startedAt, targets}, writer)
    await applier.execute()
    await writer.settled()

    const record: RunRecord = {
      commit: plan.commit,
      env: plan.env,
      finishedAt: new Date().toISOString(),
      kind: 'apply',
      runId,
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      startedAt,
      workers: Object.fromEntries([...targets].map(([name, {record: worker}]) => [name, worker])),
    }
    const recordFailure = await writeRunRecord(store, record)
    const problems = [
      ...writer.failures.map((message) => `State was not written: ${message}`),
      ...(recordFailure === undefined ? [] : [`The run record was not written: ${recordFailure}`]),
    ]
    process.stderr.write(formatRunSummary(record, problems))
    writeSummaryFile(context, flags.summaryFile, formatRunMarkdown(record, problems))

    context.interrupts.throwIfInterrupted()
    const failed = Object.values(record.workers).some(({result}) => result === 'failed' || result === 'skipped' || result === 'cancelled')
    exitCode = failed || problems.length > 0 ? EXIT_FAILED : EXIT_OK
    return exitCode
  })

  process.exitCode = exitCode
}
