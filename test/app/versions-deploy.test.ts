import {afterEach, describe, expect, it} from 'vitest'

import {runDeploySteps, STALE_READ_DELAYS_MS, versionsDeploy, type DeployStep, type VersionsDeployOptions} from '../../src/app/deployment.js'
import {failureOf, type RunContext} from '../../src/app/run.js'
import type {ReportEvent} from '../../src/report/events.js'
import {Interrupts} from '../../src/runtime/signals.js'
import type {WranglerResult} from '../../src/wrangler/process.js'
import {isVersionNotFound} from '../../src/wrangler/retry.js'

const UPLOADED = 'version-2-of-worker-a'
// As Cloudflare words it when it doesn't return a version it made seconds before.
const NOT_FOUND_TEXT = 'The requested Worker version could not be found, please check the ID being passed and try again. [code: 100146]'

function failed(change: {code?: number; message?: string; stderr?: string} = {}): WranglerResult {
  const {code, message, stderr = ''} = change
  const failure = code === undefined && message === undefined ? undefined : {...(code !== undefined && {code}), ...(message !== undefined && {message})}
  return {code: 1, output: {entries: [], ...(failure && {failure})}, signal: null, stderr, stdout: ''}
}

const notFound = (): WranglerResult => failed({code: 100_146, message: NOT_FOUND_TEXT, stderr: `✘ [ERROR] A request to the Cloudflare API failed.\n\n  ${NOT_FOUND_TEXT}\n`})
const failure = (result: WranglerResult) => failureOf('worker-a: ', 'versions-deploy', result)

/** A `versions deploy` that fails with each result in turn, then succeeds. */
function deploying(...results: WranglerResult[]): {calls: () => number; deploy: () => Promise<void>} {
  let calls = 0
  return {
    calls: () => calls,
    async deploy() {
      const result = results[calls]
      calls++
      if (result !== undefined) throw failure(result)
    },
  }
}

function options(change: Partial<VersionsDeployOptions> = {}): VersionsDeployOptions & {notices: string[]; waits: number[]} {
  const notices: string[] = []
  const waits: number[] = []
  return {
    isLive: async () => false,
    notice: (message) => notices.push(message),
    notices,
    async sleep(ms) {
      waits.push(ms)
    },
    uploadedVersionId: UPLOADED,
    waits,
    ...change,
  }
}

describe('isVersionNotFound', () => {
  it('reads the code from the command-failed entry, or from the text', () => {
    expect(isVersionNotFound(notFound())).toBe(true)
    expect(isVersionNotFound(failed({code: 100_146}))).toBe(true)
    expect(isVersionNotFound(failed({message: NOT_FOUND_TEXT}))).toBe(true)
    expect(isVersionNotFound(failed({stderr: `✘ [ERROR] ${NOT_FOUND_TEXT}\n`}))).toBe(true)
  })

  it('is false for other codes, a success and a signal', () => {
    expect(isVersionNotFound(failed({code: 10_007, message: 'This Worker does not exist on your account. [code: 10007]'}))).toBe(false)
    expect(isVersionNotFound(failed({stderr: 'code: 1001460'}))).toBe(false)
    expect(isVersionNotFound({...notFound(), code: 0})).toBe(false)
    expect(isVersionNotFound({...notFound(), code: null, signal: 'SIGTERM'})).toBe(false)
  })
})

describe('versionsDeploy', () => {
  it('tries the version this run uploaded again while Cloudflare does not list it, with a notice each time', async () => {
    const {calls, deploy} = deploying(notFound(), notFound())
    const opts = options()
    await versionsDeploy(UPLOADED, deploy, opts)
    expect(calls()).toBe(3)
    expect(opts.waits).toEqual([2000, 4000])
    expect(opts.notices).toEqual([
      `Cloudflare does not list version ${UPLOADED} yet, trying again in 2 s.`,
      `Cloudflare does not list version ${UPLOADED} yet, trying again in 4 s.`,
    ])
  })

  it('fails at once for a version this run did not upload', async () => {
    for (const uploadedVersionId of [undefined, 'version-1-of-worker-a']) {
      const {calls, deploy} = deploying(notFound())
      const opts = options({uploadedVersionId})
      const error = await versionsDeploy('version-1-of-worker-a-live-before', deploy, opts).catch((error_: unknown) => error_)
      expect(error).toMatchObject({code: 'wrangler-failed', message: `worker-a: wrangler versions deploy failed with exit code 1: ${NOT_FOUND_TEXT}`})
      expect(calls()).toBe(1)
      expect(opts.notices).toEqual([])
    }
  })

  it('fails with the last failure, as before, once the waits run out', async () => {
    const {calls, deploy} = deploying(...Array.from({length: 10}, notFound))
    const opts = options()
    const error = await versionsDeploy(UPLOADED, deploy, opts).catch((error_: unknown) => error_)
    expect(error).toMatchObject({code: 'wrangler-failed', message: `worker-a: wrangler versions deploy failed with exit code 1: ${NOT_FOUND_TEXT}`})
    expect(calls()).toBe(STALE_READ_DELAYS_MS.length + 1)
    expect(opts.waits).toEqual(STALE_READ_DELAYS_MS)
    expect(opts.notices).toHaveLength(STALE_READ_DELAYS_MS.length)
  })

  it('leaves any other failure to the step retries', async () => {
    const {calls, deploy} = deploying(failed({code: 10_013, message: 'Internal error. [code: 10013]'}))
    const opts = options()
    await expect(versionsDeploy(UPLOADED, deploy, opts)).rejects.toThrow('[code: 10013]')
    expect(calls()).toBe(1)
  })

  it('stops once the version is live, as an attempt that took effect leaves it', async () => {
    const {calls, deploy} = deploying(notFound())
    const opts = options({isLive: async () => true})
    await versionsDeploy(UPLOADED, deploy, opts)
    expect(calls()).toBe(1)
    expect(opts.notices).toHaveLength(1)
  })

  it('stops after an abort, with the failure', async () => {
    const controller = new AbortController()
    const {calls, deploy} = deploying(notFound(), notFound())
    const opts = options({
      signal: controller.signal,
      async sleep() {
        controller.abort()
      },
    })
    await expect(versionsDeploy(UPLOADED, deploy, opts)).rejects.toThrow('[code: 100146]')
    expect(calls()).toBe(1)

    const aborted = deploying(notFound())
    await expect(versionsDeploy(UPLOADED, aborted.deploy, options({signal: AbortSignal.abort()}))).rejects.toThrow('[code: 100146]')
    expect(aborted.calls()).toBe(1)
  })
})

describe('a promote that meets 100146', () => {
  const interrupts: Interrupts[] = []

  afterEach(() => {
    for (const each of interrupts.splice(0)) each.dispose()
  })

  async function promote(results: WranglerResult[]): Promise<ReportEvent[]> {
    const events: ReportEvent[] = []
    const context = {emit: (event: ReportEvent) => events.push(event), interrupts: new Interrupts()} as unknown as RunContext
    interrupts.push(context.interrupts)
    const {deploy} = deploying(...results)
    const step: DeployStep = {
      action: 'promote',
      dependsOn: [],
      async run() {
        await versionsDeploy(UPLOADED, deploy, {
          isLive: async () => false,
          notice: (message) => context.emit({message, type: 'notice', worker: 'worker-a'}),
          async sleep() {},
          uploadedVersionId: UPLOADED,
        })
        return UPLOADED
      },
      worker: 'worker-a',
    }
    await runDeploySteps(context, {concurrency: 1, onResult() {}, steps: [step]})
    return events
  }

  it('ends ok once Cloudflare lists the version', async () => {
    const events = await promote([notFound(), notFound()])
    expect(events.filter(({type}) => type === 'notice')).toHaveLength(2)
    expect(events.at(-1)).toEqual({action: 'promote', status: 'ok', type: 'step-finished', versionId: UPLOADED, worker: 'worker-a'})
  })

  it('fails as before when it never does', async () => {
    const events = await promote(Array.from({length: 10}, notFound))
    expect(events.at(-1)).toEqual({
      action: 'promote',
      message: `worker-a: wrangler versions deploy failed with exit code 1: ${NOT_FOUND_TEXT}`,
      status: 'failed',
      type: 'step-finished',
      worker: 'worker-a',
    })
  })
})
