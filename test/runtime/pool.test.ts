import {describe, expect, it, vi} from 'vitest'

import {runPool, type PoolOptions, type PoolStep, type StepResult} from '../../src/runtime/pool.js'

async function tick() {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

/** Steps that finish only when the test says so, so nothing here depends on timing. */
function controlled(definitions: Record<string, string[]>) {
  const log: string[] = []
  const settle = new Map<string, {reject(error: unknown): void; resolve(value: string): void}>()
  const steps: PoolStep<string>[] = Object.entries(definitions).map(([id, dependsOn]) => ({
    dependsOn,
    id,
    run: () =>
      new Promise<string>((resolve, reject) => {
        log.push(id)
        settle.set(id, {reject, resolve})
      }),
  }))

  return {
    async fail(id: string) {
      settle.get(id)!.reject(new Error(`${id} broke`))
      await tick()
    },
    log,
    async pass(id: string) {
      settle.get(id)!.resolve(`${id} ok`)
      await tick()
    },
    steps,
  }
}

function byId<T>(results: StepResult<T>[]) {
  return Object.fromEntries(results.map((result) => [result.id, result.status]))
}

const instant = (id: string, dependsOn: string[] = []): PoolStep<string> => ({
  dependsOn,
  id,
  run: async () => id,
})

describe('runPool', () => {
  it('returns a result for every step, in input order', async () => {
    const results = await runPool([instant('b'), instant('a', ['b'])], {concurrency: 2})
    expect(results).toEqual([
      {attempts: 1, id: 'b', status: 'succeeded', value: 'b'},
      {attempts: 1, id: 'a', status: 'succeeded', value: 'a'},
    ])
  })

  it('resolves at once with no steps', async () => {
    await expect(runPool([], {concurrency: 1})).resolves.toEqual([])
  })

  it('starts no more than the limit, in input order, and fills a slot when one frees', async () => {
    const {log, pass, steps} = controlled({a: [], b: [], c: [], d: []})
    const done = runPool(steps, {concurrency: 2})

    expect(log).toEqual(['a', 'b'])
    await pass('b')
    expect(log).toEqual(['a', 'b', 'c'])
    await pass('a')
    expect(log).toEqual(['a', 'b', 'c', 'd'])
    await pass('c')
    await pass('d')
    expect(byId(await done)).toEqual({a: 'succeeded', b: 'succeeded', c: 'succeeded', d: 'succeeded'})
  })

  it('runs one at a time at concurrency 1', async () => {
    const {log, pass, steps} = controlled({a: [], b: []})
    const done = runPool(steps, {concurrency: 1})

    expect(log).toEqual(['a'])
    await pass('a')
    expect(log).toEqual(['a', 'b'])
    await pass('b')
    await done
  })

  it('waits for every dependency, even with free slots', async () => {
    const {log, pass, steps} = controlled({a: [], b: [], c: ['a', 'b']})
    const done = runPool(steps, {concurrency: 8})

    expect(log).toEqual(['a', 'b'])
    await pass('a')
    expect(log).toEqual(['a', 'b'])
    await pass('b')
    expect(log).toEqual(['a', 'b', 'c'])
    await pass('c')
    await done
  })

  it('skips transitive dependents of a failure, naming it, and continues with independent branches', async () => {
    const {fail, log, pass, steps} = controlled({a: [], b: ['a'], c: ['b'], d: []})
    const done = runPool(steps, {concurrency: 2})

    await fail('a')
    await pass('d')
    const results = await done

    expect(log).toEqual(['a', 'd'])
    expect(results.find(({id}) => id === 'a')).toMatchObject({status: 'failed'})
    expect(results.find(({id}) => id === 'b')).toEqual({id: 'b', reason: 'a', status: 'skipped'})
    expect(results.find(({id}) => id === 'c')).toEqual({id: 'c', reason: 'a', status: 'skipped'})
    expect(results.find(({id}) => id === 'd')).toMatchObject({status: 'succeeded'})
  })

  it('finishes a diamond once, when two paths reach a skipped step', async () => {
    const {fail, steps} = controlled({a: [], b: ['a'], c: ['a'], d: ['b', 'c']})
    const finished: string[] = []
    const done = runPool(steps, {concurrency: 2, onFinish: ({id}) => finished.push(id)})

    await fail('a')

    expect(byId(await done)).toEqual({a: 'failed', b: 'skipped', c: 'skipped', d: 'skipped'})
    expect(finished.sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('starts nothing new after a signal, lets running steps finish, and cancels the rest', async () => {
    const controller = new AbortController()
    const {log, pass, steps} = controlled({a: [], b: [], c: ['a'], d: []})
    const done = runPool(steps, {concurrency: 1, signal: controller.signal})

    expect(log).toEqual(['a'])
    controller.abort()
    await pass('a')

    expect(log).toEqual(['a'])
    expect(byId(await done)).toEqual({a: 'succeeded', b: 'cancelled', c: 'cancelled', d: 'cancelled'})
  })

  it('cancels everything when the signal already fired', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = vi.fn(async () => 'x')
    const results = await runPool([{dependsOn: [], id: 'a', run}], {concurrency: 1, signal: controller.signal})
    expect(results).toEqual([{id: 'a', status: 'cancelled'}])
    expect(run).not.toHaveBeenCalled()
  })

  it('cancels a dependent when the signal comes before its dependency fails', async () => {
    const controller = new AbortController()
    const {fail, steps} = controlled({a: [], b: ['a']})
    const done = runPool(steps, {concurrency: 1, signal: controller.signal})

    controller.abort()
    await fail('a')

    expect(byId(await done)).toEqual({a: 'failed', b: 'cancelled'})
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses a concurrency of %s', (concurrency) => {
    expect(() => runPool([], {concurrency})).toThrow('Invalid concurrency')
  })

  it('refuses a cycle, an unknown dependency and a repeated ID before starting anything', () => {
    const options = {concurrency: 1}
    expect(() => runPool([instant('a', ['b']), instant('b', ['a'])], options)).toThrow('cycle')
    expect(() => runPool([instant('a', ['a'])], options)).toThrow('cycle')
    expect(() => runPool([instant('a', ['nope'])], options)).toThrow('unknown step nope')
    expect(() => runPool([instant('a'), instant('a')], options)).toThrow('unique')
  })
})

function flaky(failures: number) {
  let calls = 0
  return {
    calls: () => calls,
    step: {
      dependsOn: [],
      id: 'a',
      async run() {
        calls++
        if (calls <= failures) throw new Error(`failure ${calls}`)
        return 'done'
      },
    },
  }
}

function retry(attempts: number, isRetryable: () => boolean = () => true) {
  const delays: number[] = []
  const options: Pick<PoolOptions<string>, 'retry' | 'sleep'> = {
    retry: {attempts, delayMs: (attempt) => attempt * 100, isRetryable},
    async sleep(ms) {
      delays.push(ms)
    },
  }
  return {delays, options}
}

describe('runPool retry', () => {
  it('does not retry without a policy', async () => {
    const {calls, step} = flaky(1)
    const [result] = await runPool([step], {concurrency: 1})
    expect(result).toMatchObject({attempts: 1, status: 'failed'})
    expect(calls()).toBe(1)
  })

  it('retries until it succeeds, with the delay for each attempt', async () => {
    const {calls, step} = flaky(2)
    const {delays, options} = retry(3)
    const [result] = await runPool([step], {concurrency: 1, ...options})
    expect(result).toEqual({attempts: 3, id: 'a', status: 'succeeded', value: 'done'})
    expect(calls()).toBe(3)
    expect(delays).toEqual([100, 200])
  })

  it('stops at the attempt limit and reports the last error', async () => {
    const {calls, step} = flaky(5)
    const {options} = retry(2)
    const [result] = await runPool([step], {concurrency: 1, ...options})
    expect(result).toMatchObject({attempts: 2, status: 'failed'})
    expect((result as {error: Error}).error.message).toBe('failure 2')
    expect(calls()).toBe(2)
  })

  it('does not retry what is not retryable, and asks with the failed result', async () => {
    const {calls, step} = flaky(5)
    const isRetryable = vi.fn(() => false)
    const {delays, options} = retry(3, isRetryable)
    await runPool([step], {concurrency: 1, ...options})
    expect(calls()).toBe(1)
    expect(delays).toEqual([])
    expect(isRetryable).toHaveBeenCalledWith(expect.objectContaining({attempts: 1, id: 'a', status: 'failed'}))
  })

  it('holds dependents until the retries are over', async () => {
    const {step} = flaky(1)
    const {options} = retry(2)
    const log: string[] = []
    const dependent = {
      dependsOn: ['a'],
      id: 'b',
      async run() {
        log.push('b')
        return 'b'
      },
    }
    const results = await runPool([step, dependent], {concurrency: 2, ...options})
    expect(byId(results)).toEqual({a: 'succeeded', b: 'succeeded'})
    expect(log).toEqual(['b'])
  })

  it('does not start another attempt after a signal', async () => {
    const controller = new AbortController()
    const {calls, step} = flaky(5)
    const {options} = retry(3)
    const results = await runPool([step], {
      concurrency: 1,
      ...options,
      async sleep() {
        controller.abort()
      },
      signal: controller.signal,
    })
    expect(calls()).toBe(1)
    expect(results[0]).toMatchObject({attempts: 1, status: 'failed'})
  })
})
