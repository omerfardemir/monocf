import {setTimeout as wait} from 'node:timers/promises'

export interface PoolStep<T> {
  /** Steps that must succeed first. */
  dependsOn: string[]
  id: string
  run: () => Promise<T>
}

export type StepResult<T> =
  | {attempts: number; error: unknown; id: string; status: 'failed'}
  | {attempts: number; id: string; status: 'succeeded'; value: T}
  | {id: string; reason: string; status: 'skipped'}
  | {id: string; status: 'cancelled'}

export type FailedStep = Extract<StepResult<unknown>, {status: 'failed'}>

export interface RetryPolicy {
  /** How many times a step may run in total. */
  attempts: number
  /** The wait before the next run, where 1 follows the first run. */
  delayMs(attempt: number): number
  isRetryable(result: FailedStep): boolean
}

export interface PoolOptions<T> {
  concurrency: number
  onFinish?: (result: StepResult<T>) => void
  retry?: RetryPolicy
  /** Once aborted, nothing new starts. Stopping what already runs is up to the caller. */
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await wait(ms, undefined, {signal})
  } catch {
    // Aborted: the caller checks the signal next.
  }
}

/** An unknown dependency or a cycle would leave steps waiting forever, so both are refused before anything starts. */
function validateSteps(steps: PoolStep<unknown>[], concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`Invalid concurrency: ${concurrency}`)

  const ids = new Set(steps.map(({id}) => id))
  if (ids.size !== steps.length) throw new Error('Step IDs must be unique.')

  const done = new Set<string>()
  let remaining = steps
  while (remaining.length > 0) {
    for (const {dependsOn, id} of remaining) {
      const unknown = dependsOn.find((dependency) => !ids.has(dependency))
      if (unknown !== undefined) throw new Error(`Step ${id} depends on unknown step ${unknown}.`)
    }

    const ready = remaining.filter(({dependsOn}) => dependsOn.every((dependency) => done.has(dependency)))
    if (ready.length === 0) throw new Error(`Steps form a cycle: ${remaining.map(({id}) => id).join(', ')}`)
    for (const {id} of ready) done.add(id)
    remaining = remaining.filter(({id}) => !done.has(id))
  }
}

async function runWithRetry<T>(step: PoolStep<T>, {retry, signal, sleep = defaultSleep}: PoolOptions<T>) {
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await step.run()
      return {attempts: attempt, id: step.id, status: 'succeeded' as const, value}
    } catch (error) {
      const failed = {attempts: attempt, error, id: step.id, status: 'failed' as const}
      if (!retry || attempt >= retry.attempts || signal?.aborted || !retry.isRetryable(failed)) return failed
      await sleep(retry.delayMs(attempt), signal)
      if (signal?.aborted) return failed
    }
  }
}

/**
 * Runs steps over a dependency graph, at most `concurrency` at a time, and resolves with a result for every step, in
 * input order. A step starts when its dependencies have succeeded and a slot is free, earlier input first. A failure
 * skips what depends on it, and independent steps carry on.
 */
export function runPool<T>(steps: PoolStep<T>[], options: PoolOptions<T>): Promise<StepResult<T>[]> {
  const {concurrency, onFinish, signal} = options
  validateSteps(steps, concurrency)

  const results = new Map<string, StepResult<T>>()
  const finish = (result: StepResult<T>): void => {
    results.set(result.id, result)
    onFinish?.(result)
  }

  const started = new Set<string>()
  const skipDependents = (id: string, reason: string): void => {
    for (const step of steps) {
      if (step.dependsOn.includes(id) && !results.has(step.id)) {
        finish({id: step.id, reason, status: 'skipped'})
        skipDependents(step.id, reason)
      }
    }
  }

  return new Promise((resolve) => {
    let running = 0
    const pump = (): void => {
      const unfinished = steps.filter(({id}) => !results.has(id) && !started.has(id))
      if (signal?.aborted) {
        for (const {id} of unfinished) finish({id, status: 'cancelled'})
      } else {
        const ready = unfinished.filter(({dependsOn}) =>
          dependsOn.every((dependency) => results.get(dependency)?.status === 'succeeded'),
        )
        for (const step of ready.slice(0, concurrency - running)) start(step)
      }

      if (running === 0 && results.size === steps.length) {
        signal?.removeEventListener('abort', pump)
        resolve(steps.map(({id}) => results.get(id)!))
      }
    }

    const start = (step: PoolStep<T>): void => {
      started.add(step.id)
      running++
      runWithRetry(step, options).then((result) => {
        running--
        finish(result)
        if (result.status === 'failed') skipDependents(step.id, step.id)
        pump()
      })
    }

    signal?.addEventListener('abort', pump)
    pump()
  })
}
