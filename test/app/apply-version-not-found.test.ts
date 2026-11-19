import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {runApply} from '../../src/app/apply.js'
import {runPlan} from '../../src/app/plan.js'
import {tagFor, type Plan} from '../../src/plan/plan.js'
import type {ReportEvent} from '../../src/report/events.js'
import {createFixture, type FakeCloudflare, type WranglerCall} from '../helpers/harness.js'

// No wait takes any time here. The waits still come in order, and each notice still names the one it stands for.
vi.mock('../../src/wrangler/retry.js', async (original) => ({...(await original<typeof import('../../src/wrangler/retry.js')>()), async pause() {}}))

const DEPLOYED = 'worker-a-v1-staging'
const UPLOADED = 'version-1-of-worker-a'
// As Cloudflare words it when it doesn't return a version it made seconds before.
const NOT_FOUND_TEXT = 'The requested Worker version could not be found, please check the ID being passed and try again. [code: 100146]'
const FAILED = `worker-a: wrangler versions deploy failed with exit code 1: ${NOT_FOUND_TEXT}`

/** `versions deploy` gives 100146 this many times, whatever the version, and then behaves as Cloudflare does. */
function notFound(times: number) {
  return {command: 'versions deploy', exitCode: 1, failCode: 100_146, failMessage: NOT_FOUND_TEXT, stderr: `✘ [ERROR] ${NOT_FOUND_TEXT}\n`, times}
}

const lagging = (seconds: number) => ({message: `Cloudflare does not list version ${UPLOADED} yet, trying again in ${seconds} s.`, type: 'notice', worker: 'worker-a'})

/** Live on Cloudflare by hand, with no state entry, so a plan uploads over it and promotes what it uploaded. */
const byHand: FakeCloudflare = {workers: {[DEPLOYED]: {active: [['version-by-hand', 100]], tags: {'version-by-hand': null}}}}

describe('apply when versions deploy meets code 100146', () => {
  const savedEnvironment = {...process.env}
  let dir: string
  let root: string
  let events: ReportEvent[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monocf-apply-'))
    mkdirSync(join(dir, 'state'))
    events = []
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const event = JSON.parse(line)
        delete event.schemaVersion
        events.push(event)
      }

      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = {...savedEnvironment}
    process.exitCode = undefined
    rmSync(dir, {force: true, recursive: true})
  })

  function writeCloudflare(cloudflare: FakeCloudflare): void {
    writeFileSync(join(dir, 'cloudflare.json'), JSON.stringify(cloudflare))
  }

  function setUp(cloudflare: FakeCloudflare, rules: object[], config: Record<string, unknown> = {}): void {
    root = createFixture({environments: ['staging'], workers: [{config, name: 'worker-a'}]}).root
    writeCloudflare(cloudflare)
    writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules))
    process.env.FAKE_WRANGLER_CF = join(dir, 'cloudflare.json')
    process.env.FAKE_WRANGLER_LOG = join(dir, 'calls.ndjson')
    process.env.FAKE_WRANGLER_RULES = join(dir, 'rules.json')
  }

  async function plan(): Promise<Plan> {
    await runPlan({env: 'staging', json: true, rootDir: root, state: `file:${join(dir, 'state')}`})
    return JSON.parse(readFileSync(join(root, '.monocf', 'plan', 'staging.json'), 'utf8'))
  }

  async function apply(): Promise<ReportEvent[]> {
    events = []
    await runApply(join(root, '.monocf', 'plan', 'staging.json'), {json: true, rootDir: root})
    return events
  }

  /** The version each `versions deploy` was given. */
  function deploys(): string[] {
    return readFileSync(join(dir, 'calls.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as WranglerCall).argv)
      .filter(([command, subcommand]) => command === 'versions' && subcommand === 'deploy')
      .map((argv) => argv[2])
  }

  const notices = (run: ReportEvent[]) => run.filter((event) => event.type === 'notice' && event.message.startsWith('Cloudflare does not list'))

  it('promotes the version it uploaded once Cloudflare lists it, with a notice for each retry', async () => {
    setUp(byHand, [notFound(2)])
    expect((await plan()).steps.map(({action}) => action)).toEqual(['upload'])

    const run = await apply()

    expect(deploys()).toEqual([`${UPLOADED}@100%`, `${UPLOADED}@100%`, `${UPLOADED}@100%`])
    expect(notices(run)).toEqual([lagging(2), lagging(4)])
    expect(run).toContainEqual({action: 'promote', status: 'ok', type: 'step-finished', versionId: UPLOADED, worker: 'worker-a'})
    expect(run.at(-1)).toEqual({exitCode: 0, status: 'ok', type: 'run-finished'})
    expect(JSON.parse(readFileSync(join(dir, 'cloudflare.json'), 'utf8')).workers[DEPLOYED].active).toEqual([[UPLOADED, 100]])
  })

  it('fails as before once the waits run out', async () => {
    setUp(byHand, [notFound(10)])
    await plan()

    const run = await apply()

    expect(deploys()).toHaveLength(5)
    expect(notices(run)).toEqual([lagging(2), lagging(4), lagging(8), lagging(16)])
    expect(run).toContainEqual({action: 'promote', message: FAILED, status: 'failed', type: 'step-finished', worker: 'worker-a'})
    expect(run.at(-1)).toEqual({exitCode: 1, status: 'failed', type: 'run-finished'})
  })

  it('fails at once for a version the run did not upload, as when an adopt gives the live version again for its tails', async () => {
    // Its env names a tail consumer and no state entry says it was set, so the adopt sends the live version again.
    setUp(byHand, [notFound(1)], {env: {staging: {tail_consumers: [{service: 'logs'}]}}})
    const {fingerprint} = (await plan()).steps[0]
    writeCloudflare({workers: {[DEPLOYED]: {active: [['version-live', 100]], tags: {'version-live': tagFor(fingerprint)}}}})
    expect((await plan()).steps.map(({action}) => action)).toEqual(['adopt'])

    const run = await apply()

    expect(deploys()).toEqual(['version-live@100%'])
    expect(notices(run)).toEqual([])
    expect(run).toContainEqual({action: 'adopt', message: FAILED, status: 'failed', type: 'step-finished', worker: 'worker-a'})
    expect(run.at(-1)).toEqual({exitCode: 1, status: 'failed', type: 'run-finished'})
  })
})
