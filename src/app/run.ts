import {cpus} from 'node:os'

import {EXIT_FAILED, EXIT_OK, MonocfError} from '../errors.js'
import type {EventSink} from '../report/events.js'
import {humanSink} from '../report/human.js'
import {ndjsonSink} from '../report/ndjson.js'
import {runPool, type FailedStep} from '../runtime/pool.js'
import {createRunDir, type RunDir} from '../runtime/run-dir.js'
import {Interrupts, signalExitCode} from '../runtime/signals.js'
import {buildArgv, type ArgvOptions, type Step} from '../wrangler/argv.js'
import type {Wrangler} from '../wrangler/locate.js'
import {spawnWrangler, type OutputMode, type WranglerResult} from '../wrangler/process.js'

export interface RunContext {
  emit: EventSink
  interrupts: Interrupts
  json: boolean
  runDir: RunDir
  wrangler: Wrangler
}

export function createSink(json: boolean): EventSink {
  return json ? ndjsonSink() : humanSink()
}

const COMMAND_NAMES: Record<Step['action'], string> = {
  'active-version': 'deployments status',
  build: 'deploy --dry-run',
  deploy: 'deploy',
  'deployment-status': 'deployments status',
  dev: 'dev',
  preview: 'versions upload',
  'r2-bucket-info': 'r2 bucket info',
  'r2-get': 'r2 object get',
  'r2-put': 'r2 object put',
  'secret-bulk': 'secret bulk',
  'triggers-deploy': 'triggers deploy',
  'version-view': 'versions view',
  'versions-deploy': 'versions deploy',
  'versions-list': 'versions list',
  whoami: 'whoami',
}

export function isSuccess({code, signal}: WranglerResult): boolean {
  return code === 0 && signal === null
}

/** The error for a finished process. A signal keeps its own exit code, so CI can tell a kill from a failure. */
export function failureOf(label: string, action: Step['action'], result: WranglerResult): MonocfError {
  const name = `${label}wrangler ${COMMAND_NAMES[action]}`
  if (result.signal) return new MonocfError(`${name} was killed by ${result.signal}.`, signalExitCode(result.signal))
  const detail = result.output.failure?.message ? `: ${result.output.failure.message}` : '.'
  return new MonocfError(`${name} failed with exit code ${result.code}${detail}`, EXIT_FAILED)
}

export interface StepRun {
  argvOptions?: ArgvOptions
  mode: OutputMode
  step: Step
  worker: string
}

/** Runs one wrangler process to its end. Exit 0 from an upload isn't proof, so a version ID has to be there too. */
export async function runStep(context: RunContext, {argvOptions, mode, step, worker}: StepRun) {
  const {interrupts, runDir, wrangler} = context
  interrupts.throwIfInterrupted()
  const running = spawnWrangler(wrangler, buildArgv(step, argvOptions), {
    cwd: runDir.workerDir(worker),
    mode,
    outputFile: runDir.outputFile(worker),
  })
  interrupts.track(running.child)
  const result = await running.done
  interrupts.throwIfInterrupted()
  if (!isSuccess(result)) throw failureOf(`${worker}: `, step.action, result)

  if ((step.action === 'deploy' || step.action === 'preview') && result.output.versionId === undefined) {
    throw new MonocfError(
      `${worker}: wrangler ${COMMAND_NAMES[step.action]} exited 0 without reporting a version ID, so the upload is unconfirmed.`,
      EXIT_FAILED,
    )
  }

  return result
}

/**
 * One read or small write, from the run directory, with no config. Nothing reaches the terminal, and a failure comes back
 * for the caller to judge, since some failures here are answers.
 */
export async function callWrangler(context: RunContext, step: Step, accountId?: string): Promise<WranglerResult> {
  const {interrupts, runDir, wrangler} = context
  interrupts.throwIfInterrupted()
  const running = spawnWrangler(wrangler, buildArgv(step), {accountId, cwd: runDir.path, mode: 'quiet'})
  interrupts.track(running.child)
  const result = await running.done
  interrupts.throwIfInterrupted()
  return result
}

/** Wraps one worker's work in its events. A failure is reported here and carries on upward. */
export async function reportStep(
  {emit}: Pick<RunContext, 'emit'>,
  action: string,
  worker: string,
  work: () => Promise<string | undefined | void>,
): Promise<void> {
  emit({action, type: 'step-started', worker})
  try {
    const versionId = await work()
    emit({action, status: 'ok', type: 'step-finished', worker, ...(versionId && {versionId})})
  } catch (error) {
    emit({action, message: (error as Error).message, status: 'failed', type: 'step-finished', worker})
    throw error
  }
}

const MAX_BUILD_CONCURRENCY = 8

export function defaultBuildConcurrency(): number {
  return Math.min(cpus().length, MAX_BUILD_CONCURRENCY)
}

export interface WorkerStep {
  dependsOn: string[]
  /** The mode tells the work how to send output: with a label on each line when several workers run at once. */
  run: (mode: OutputMode) => Promise<string | undefined | void>
  worker: string
}

function failureFrom(failed: FailedStep[]): Error {
  const errors = failed.map(({error}) => error as Error & {exitCode?: number})
  if (errors.length === 1) return errors[0]
  const killed = errors.find(({exitCode}) => exitCode !== undefined && exitCode > 128)
  // Every worker failing the same way, such as no credentials, says more than "workers failed".
  const shared = errors.every(({exitCode}) => exitCode === errors[0].exitCode) ? errors[0].exitCode : undefined
  const lines = errors.map(({message}) => `  ${message}`).join('\n')
  return new MonocfError(`${errors.length} workers failed:\n${lines}`, killed?.exitCode ?? shared ?? EXIT_FAILED)
}

/**
 * Runs each worker's work over the pool, with its events. A wrangler killed from outside stops new steps, since whatever
 * killed it likely isn't done. Throws once everything has settled if anything failed.
 */
export async function runWorkerSteps(
  context: RunContext,
  {action, concurrency, steps}: {action: string; concurrency: number; steps: WorkerStep[]},
): Promise<void> {
  const {emit, interrupts} = context
  const results = await runPool(
    steps.map(({dependsOn, run, worker}) => ({
      dependsOn,
      id: worker,
      async run() {
        const mode: OutputMode = concurrency > 1 ? {prefix: `[${worker}] `} : aloneMode(context, false)
        try {
          await reportStep(context, action, worker, () => run(mode))
        } catch (error) {
          if ((error as {exitCode?: number}).exitCode! > 128) interrupts.halt()
          throw error
        }
      },
    })),
    {
      concurrency,
      onFinish(result) {
        if (result.status === 'skipped' || result.status === 'cancelled') {
          const reason = result.status === 'skipped' ? {reason: result.reason} : {}
          emit({action, status: result.status, type: 'step-finished', worker: result.id, ...reason})
        }
      },
      signal: interrupts.signal,
    },
  )

  interrupts.throwIfInterrupted()
  const failed = results.filter((result): result is FailedStep => result.status === 'failed')
  if (failed.length > 0) throw failureFrom(failed)
}

/** The mode for a process that runs alone. --json keeps stdout for monocf's events. */
export function aloneMode(context: Pick<RunContext, 'json'>, interactive: boolean): OutputMode {
  return interactive && !context.json ? 'inherit' : 'stderr'
}

export interface RunSetup {
  action: string
  env?: string
  json: boolean
  notices: {message: string; worker?: string}[]
  rootDir: string
  workers: string[]
  wrangler: Wrangler
}

/**
 * Everything around a run: reporting, the run directory, and the signal handler. They end together on every path. The work
 * can return an exit code, for a result that isn't success and has no error to raise.
 */
export async function withRun(setup: RunSetup, work: (context: RunContext) => Promise<number | void>): Promise<void> {
  const {action, env, json, notices, rootDir, workers, wrangler} = setup
  const sink = createSink(json)
  const runDir = createRunDir(rootDir)
  const interrupts = new Interrupts()

  sink({action, ...(env !== undefined && {env}), type: 'run-started', workers})
  for (const notice of notices) sink({...notice, type: 'notice'})

  try {
    const exitCode = (await work({emit: sink, interrupts, json, runDir, wrangler})) ?? EXIT_OK
    sink({exitCode, status: exitCode === EXIT_OK ? 'ok' : 'failed', type: 'run-finished'})
  } catch (error) {
    if (error instanceof MonocfError) {
      const status = interrupts.received ? 'interrupted' : 'failed'
      sink({exitCode: error.exitCode, status, type: 'run-finished'})
    }

    throw error
  } finally {
    interrupts.dispose()
    runDir.remove()
  }
}
