import {randomBytes} from 'node:crypto'

import type {ResolvedWorker} from '../config/types.js'
import {EXIT_FAILED, MonocfError} from '../errors.js'
import {runPool, type RetryPolicy, type StepResult} from '../runtime/pool.js'
import {accountHash, manifestKey, parseStateManifest, runKey, STATE_SCHEMA_VERSION, type StateManifest, type StateWorker} from '../state/manifest.js'
import type {RunRecord} from '../state/run-record.js'
import type {StateStore} from '../state/store.js'
import {readActiveVersion, type ActiveInfo, type WranglerCall} from '../wrangler/read.js'
import {isTransient, MAX_ATTEMPTS, retryDelayMs, withReadRetries} from '../wrangler/retry.js'
import {accountOf, callWrangler, WranglerFailure, type RunContext} from './run.js'

export const DEFAULT_CONCURRENCY = 6

/** Sorts by time, and fits in a state key, a version message and a workflow input. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/** A read for one worker: its account and `.env`, and the retry policy. */
export function workerCall(context: RunContext, dir: string): WranglerCall {
  return withReadRetries((step, accountId) => callWrangler(context, step, {accountId, worker: dir}), context.interrupts.signal)
}

/** State has to reach the store after a signal too, or the next run knows less than it could. */
export function stateCall(context: RunContext): WranglerCall {
  return withReadRetries((step) => callWrangler(context, step, {persist: true}))
}

export async function readManifest(store: StateStore, env: string): Promise<StateManifest> {
  const body = await store.read(manifestKey(env))
  if (body !== null) return parseStateManifest(body, env)
  return {env, schemaVersion: STATE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), workers: {}}
}

/** The hash of the account a worker's writes go to, when that's known. */
export function accountMarker(context: RunContext, worker: Pick<ResolvedWorker, 'config' | 'dir'>, env: string): string | undefined {
  const account = accountOf(context, worker, env)
  return account && accountHash(account)
}

/**
 * Keeps the store up to date as steps finish. Writes go one at a time, and whatever finished meanwhile goes in the next one,
 * so a slow store can't race with itself or hold up a deploy. A failed write isn't a failed deploy, but it has to be told.
 */
export class StateWriter {
  readonly failures: string[] = []
  private dirty = false
  private draining?: Promise<void>

  constructor(
    private readonly store: StateStore,
    private readonly env: string,
    readonly manifest: StateManifest,
  ) {}

  /** A worker's new entry. With `newVersion`, it no longer needs one for the sake of a recreated provider. */
  update(worker: string, entry: StateWorker, {newVersion = false}: {newVersion?: boolean} = {}): void {
    this.manifest.workers[worker] = entry
    if (newVersion) this.clearMark(worker)
    this.flush()
  }

  /** Written before what it protects against can happen, so a failure here stops the run. */
  async mark(callers: string[]): Promise<void> {
    await this.settled()
    this.manifest.needsNewVersion = [...new Set([...(this.manifest.needsNewVersion ?? []), ...callers])].sort()
    try {
      await this.store.write(manifestKey(this.env), this.body())
    } catch (error) {
      throw new MonocfError(`Nothing was changed, as the state store took no note of which callers will need a new version: ${(error as Error).message}`, EXIT_FAILED)
    }
  }

  async settled(): Promise<void> {
    await this.draining
  }

  private body(): string {
    this.manifest.updatedAt = new Date().toISOString()
    return `${JSON.stringify(this.manifest, null, 2)}\n`
  }

  private clearMark(worker: string): void {
    const rest = this.manifest.needsNewVersion?.filter((name) => name !== worker) ?? []
    if (rest.length > 0) this.manifest.needsNewVersion = rest
    else delete this.manifest.needsNewVersion
  }

  private async drain(): Promise<void> {
    while (this.dirty) {
      this.dirty = false
      try {
        await this.store.write(manifestKey(this.env), this.body())
      } catch (error) {
        this.failures.push((error as Error).message)
      }
    }

    this.draining = undefined
  }

  private flush(): void {
    this.dirty = true
    this.draining ??= this.drain()
  }
}

/** Returns what stopped it, for the exit code and the summary. */
export async function writeRunRecord(store: StateStore, record: RunRecord): Promise<string | undefined> {
  try {
    await store.write(runKey(record.env, record.runId), `${JSON.stringify(record, null, 2)}\n`)
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

function describeActive(active: ActiveInfo): string {
  if (active.state === 'missing') return 'nothing'
  if (active.state === 'active') return active.versionId
  return active.shares.map(({percentage, versionId}) => `${versionId} at ${percentage}%`).join(', ')
}

/** Exit 0 isn't proof: parallel writes to one worker all exit 0, with a silent winner. */
export async function verifyActive(
  call: WranglerCall,
  {accountId, deployedName, dir}: {accountId?: string; deployedName: string; dir: string},
  expected: string,
): Promise<void> {
  const active = await readActiveVersion(call, deployedName, accountId)
  if (active.state !== 'active' || active.versionId !== expected) {
    throw new MonocfError(`${dir}: verify-mismatch: expected ${expected} at 100%, and Cloudflare serves ${describeActive(active)}.`, EXIT_FAILED)
  }
}

const WRITE_RETRY: RetryPolicy = {
  attempts: MAX_ATTEMPTS,
  delayMs: (attempt) => retryDelayMs(attempt),
  isRetryable: ({error}) => error instanceof WranglerFailure && isTransient(error.result),
}

export interface DeployStep {
  action: string
  dependsOn: string[]
  /** Attempt 2 or later means an earlier one may have taken effect. Returns the version this leaves live, if it does. */
  run: (attempt: number) => Promise<string | undefined | void>
  worker: string
}

export type DeployResult = StepResult<string | undefined | void>

/** Runs one phase over the pool, with retries and one pair of events per step. A wrangler killed from outside stops new steps. */
export async function runDeploySteps(
  context: RunContext,
  {concurrency, onResult, steps}: {concurrency: number; onResult: (step: DeployStep, result: DeployResult) => void; steps: DeployStep[]},
): Promise<void> {
  const {emit, interrupts} = context
  const byWorker = new Map(steps.map((step) => [step.worker, step]))
  const attempts = new Map<string, number>()
  await runPool(
    steps.map((step) => ({
      dependsOn: step.dependsOn,
      id: step.worker,
      async run() {
        const attempt = (attempts.get(step.worker) ?? 0) + 1
        attempts.set(step.worker, attempt)
        if (attempt === 1) emit({action: step.action, type: 'step-started', worker: step.worker})
        else emit({message: `Trying ${step.action} again, attempt ${attempt} of ${MAX_ATTEMPTS}.`, type: 'notice', worker: step.worker})
        try {
          return await step.run(attempt)
        } catch (error) {
          if ((error as {exitCode?: number}).exitCode! > 128) interrupts.halt()
          throw error
        }
      },
    })),
    {
      concurrency,
      onFinish(result) {
        const step = byWorker.get(result.id)!
        const base = {action: step.action, type: 'step-finished' as const, worker: result.id}
        switch (result.status) {
          case 'succeeded': {
            emit({...base, status: 'ok', ...(result.value && {versionId: result.value})})
            break
          }

          case 'failed': {
            emit({...base, message: (result.error as Error).message, status: 'failed'})
            break
          }

          case 'skipped': {
            emit({...base, reason: result.reason, status: 'skipped'})
            break
          }

          default: {
            emit({...base, status: 'cancelled'})
          }
        }

        onResult(step, result)
      },
      retry: WRITE_RETRY,
      signal: interrupts.signal,
    },
  )
}
