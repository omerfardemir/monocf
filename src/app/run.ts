import {mkdtempSync, rmSync} from 'node:fs'
import {cpus, tmpdir} from 'node:os'
import {join} from 'node:path'

import {accountIdOf} from '../config/resolve.js'
import type {ResolvedWorker} from '../config/types.js'
import {EXIT_FAILED, EXIT_OK, MonocfError} from '../errors.js'
import type {EventSink} from '../report/events.js'
import {humanSink} from '../report/human.js'
import {ndjsonSink} from '../report/ndjson.js'
import {runPool, type FailedStep} from '../runtime/pool.js'
import {createRunDir, type RunDir} from '../runtime/run-dir.js'
import {Interrupts, signalExitCode} from '../runtime/signals.js'
import {readWorkerEnvironment} from '../runtime/worker-env.js'
import {buildArgv, type ArgvOptions, type Step} from '../wrangler/argv.js'
import type {Wrangler} from '../wrangler/locate.js'
import {spawnWrangler, type OutputMode, type WranglerResult} from '../wrangler/process.js'
import {scrubAccountIds} from '../wrangler/read.js'

export interface RunContext {
  emit: EventSink
  /** What a worker's `.env` files add to its wrangler processes. Empty for anything that isn't a worker. */
  environmentOf: (worker: string) => Record<string, string>
  interrupts: Interrupts
  json: boolean
  /** Empty, and outside the project: from here wrangler finds no config, no cached account and no `.env`. */
  readDir: string
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
  'queue-consumer-remove': 'queues consumer remove',
  'queue-consumers': 'queues consumer worker list',
  'r2-bucket-info': 'r2 bucket info',
  'r2-get': 'r2 object get',
  'r2-put': 'r2 object put',
  'secret-bulk': 'secret bulk',
  'triggers-deploy': 'triggers deploy',
  'version-view': 'versions view',
  'versions-deploy': 'versions deploy',
  'versions-list': 'versions list',
  'versions-of': 'versions list',
  whoami: 'whoami',
}

export function isSuccess({code, signal}: WranglerResult): boolean {
  return code === 0 && signal === null
}

/** Keeps what happened, so a retry policy can tell an outage from an answer. */
export class WranglerFailure extends MonocfError {
  constructor(
    message: string,
    exitCode: number,
    readonly result: WranglerResult,
  ) {
    super(message, exitCode)
  }
}

/** The error for a finished process. A signal keeps its own exit code, so CI can tell a kill from a failure. */
export function failureOf(label: string, action: Step['action'], result: WranglerResult): MonocfError {
  const name = `${label}wrangler ${COMMAND_NAMES[action]}`
  if (result.signal) return new WranglerFailure(`${name} was killed by ${result.signal}.`, signalExitCode(result.signal), result)
  const {code, message} = result.output.failure ?? {}
  const withCode = message && code !== undefined && !message.includes(String(code)) ? `${message} [code: ${code}]` : message
  const detail = withCode ? `: ${scrubAccountIds(withCode)}` : '.'
  return new WranglerFailure(`${name} failed with exit code ${result.code}${detail}`, EXIT_FAILED, result)
}

export interface StepRun {
  /** A worker's own account. Its config says so too, and a config with none leaves it to the environment. */
  accountId?: string
  argvOptions?: ArgvOptions
  mode: OutputMode
  step: Step
  worker: string
}

/** Runs one wrangler process to its end. Exit 0 from an upload isn't proof, so a version ID has to be there too. */
export async function runStep(context: RunContext, {accountId, argvOptions, mode, step, worker}: StepRun) {
  const {environmentOf, interrupts, runDir, wrangler} = context
  interrupts.throwIfInterrupted()
  const running = spawnWrangler(wrangler, buildArgv(step, argvOptions), {
    accountId,
    cwd: runDir.workerDir(worker),
    environment: environmentOf(worker),
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
 * One read or small write, from an empty directory outside the project, with no config. Nothing reaches the terminal, and a failure comes back
 * for the caller to judge, since some failures here are answers. A read for a worker goes where its writes go: to its own
 * account_id, and with what its `.env` files say. The state bucket belongs to no worker, and uses the real environment.
 */
export async function callWrangler(
  context: RunContext,
  step: Step,
  {accountId, persist = false, worker}: {accountId?: string; persist?: boolean; worker?: string} = {},
): Promise<WranglerResult> {
  const {environmentOf, interrupts, readDir, wrangler} = context
  if (!persist) interrupts.throwIfInterrupted()
  const environment = worker === undefined ? undefined : environmentOf(worker)
  const running = spawnWrangler(wrangler, buildArgv(step), {accountId, cwd: readDir, environment, mode: 'quiet'})
  // State has to reach the store after a signal too, so `persist` leaves a signal out of it.
  if (persist) return running.done
  interrupts.track(running.child)
  const result = await running.done
  interrupts.throwIfInterrupted()
  return result
}

/**
 * The account a write of this worker goes to, as wrangler works it out: the config's, then CLOUDFLARE_ACCOUNT_ID, then the
 * deprecated name. For each name the real environment beats the worker's `.env`, as it does in wrangler's own startup.
 */
export function accountOf(
  {environmentOf}: Pick<RunContext, 'environmentOf'>,
  {config, dir}: Pick<ResolvedWorker, 'config' | 'dir'>,
  env: string | undefined,
): string | undefined {
  const added = environmentOf(dir)
  const {CF_ACCOUNT_ID: realOld, CLOUDFLARE_ACCOUNT_ID: real} = process.env
  return [accountIdOf(config, env), real, added.CLOUDFLARE_ACCOUNT_ID, realOld, added.CF_ACCOUNT_ID].map((found) => found?.trim()).find(Boolean)
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
  /** Every worker a wrangler process may run for, so each gets what its `.env` files say. */
  resolved: Pick<ResolvedWorker, 'dir' | 'path'>[]
  rootDir: string
  workers: string[]
  wrangler: Wrangler
}

/**
 * Everything around a run: reporting, the run directory, and the signal handler. They end together on every path. The work
 * can return an exit code, for a result that isn't success and has no error to raise.
 */
export async function withRun(setup: RunSetup, work: (context: RunContext) => Promise<number | void>): Promise<void> {
  const {action, env, json, notices, resolved, rootDir, workers, wrangler} = setup
  const sink = createSink(json)
  const runDir = createRunDir(rootDir)
  const readDir = mkdtempSync(join(tmpdir(), 'monocf-read-'))
  const interrupts = new Interrupts()
  const environments = new Map<string, Record<string, string>>()
  const environmentOf = (worker: string): Record<string, string> => {
    let environment = environments.get(worker)
    if (!environment) {
      const path = resolved.find(({dir}) => dir === worker)?.path
      environment = path === undefined ? {} : readWorkerEnvironment(path, env)
      environments.set(worker, environment)
    }

    return environment
  }

  sink({action, ...(env !== undefined && {env}), type: 'run-started', workers})
  for (const notice of notices) sink({...notice, type: 'notice'})

  try {
    const exitCode = (await work({emit: sink, environmentOf, interrupts, json, readDir, runDir, wrangler})) ?? EXIT_OK
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
    rmSync(readDir, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  }
}
