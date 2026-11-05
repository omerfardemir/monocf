import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli, type CliResult, type FakeCloudflare, type Fixture, type WranglerCall} from '../helpers/harness.js'

// Bindings don't inherit, so they go under the env the tests plan for.
const workers = [
  {envBindings: {staging: ['billing']}, name: 'gateway'},
  {envBindings: {staging: ['orders']}, name: 'billing'},
  {name: 'orders'},
]

function project(options: Partial<Parameters<typeof createFixture>[0]> = {}): Fixture {
  const fixture = createFixture({environments: ['staging', 'production'], workers, ...options})
  mkdirSync(join(fixture.root, 'state', 'staging'), {recursive: true})
  return fixture
}

const args = ['plan', '-e', 'staging', '--state', 'file:state', '--first-run']

function reads(calls: WranglerCall[], command: string): string[] {
  return calls.filter(({argv}) => argv.join(' ').startsWith(command)).map(({argv}) => argv[argv.indexOf('--name') + 1])
}

function dryRuns(calls: WranglerCall[]): WranglerCall[] {
  return calls.filter(({argv}) => argv.includes('--dry-run'))
}

function planOf(fixture: Fixture, path = join('.monocf', 'plan', 'staging.json')) {
  return JSON.parse(readFileSync(join(fixture.root, path), 'utf8'))
}

function actionsOf(plan: {steps: {action: string; worker: string}[]}): Record<string, string> {
  return Object.fromEntries(plan.steps.map(({action, worker}) => [worker, action]))
}

/** Plans once with nothing deployed, to learn what this fixture's bundles hash to. */
async function learn(fixture: Fixture) {
  const result = await runCli(fixture, args, {cloudflare: {}})
  expect(result.exitCode).toBe(0)
  const plan = planOf(fixture)
  return Object.fromEntries(plan.steps.map((step: {worker: string}) => [step.worker, step])) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

function writeState(fixture: Fixture, steps: Record<string, any>, change: Record<string, unknown> = {}): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  const entries = Object.values(steps).map((step) => [
    step.worker,
    {
      bundleHash: step.bundleHash,
      commit: 'an-old-commit',
      configHash: step.configHash,
      deployedAt: '2026-01-01T00:00:00.000Z',
      deployedName: step.deployedName,
      doHash: step.doHash,
      externalHash: step.externalHash,
      fingerprint: step.fingerprint,
      triggers: step.triggers,
      triggersHash: step.triggersHash,
      versionId: `live-${step.worker}`,
    },
  ])
  const manifest = {env: 'staging', schemaVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z', workers: Object.fromEntries(entries), ...change}
  writeFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), JSON.stringify(manifest))
}

function liveCloudflare(steps: Record<string, any>): Required<Pick<FakeCloudflare, 'workers'>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    workers: Object.fromEntries(
      Object.values(steps).map((step) => [
        step.deployedName,
        {active: [[`live-${step.worker}`, 100]], tags: {[`live-${step.worker}`]: `monocf:${step.fingerprint}`}},
      ]),
    ) as Required<FakeCloudflare>['workers'],
  }
}

async function inSync() {
  const fixture = project()
  const steps = await learn(fixture)
  writeState(fixture, steps)
  return {cloudflare: liveCloudflare(steps), fixture, steps}
}

function eventsOf({stdout}: CliResult): Record<string, any>[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const read = (result: CliResult, name: string) => result.calls.find(({argv}) => argv[0] === 'deployments' && argv.includes(name))!

function statusOf(calls: WranglerCall[]): string[] {
  return reads(calls, 'deployments status')
}

describe('a read that fails for a moment', {timeout: 60_000}, () => {
  it('is tried again after fetch failed, and the plan comes out', async () => {
    const fixture = project()

    const result = await runCli(fixture, args, {
      cloudflare: {},
      rules: [{command: 'deployments status', exitCode: 1, stderr: '✘ [ERROR] fetch failed\n', times: 1, worker: 'orders-v1-staging'}],
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(statusOf(result.calls).filter((name) => name === 'orders-v1-staging')).toHaveLength(2)
    expect(actionsOf(planOf(fixture)).orders).toBe('create')
  })

  it('is tried again after a 5xx from the state bucket', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'r2://monocf-state/ci', '--first-run'], {
      cloudflare: {buckets: {'monocf-state': {}}},
      rules: [{command: 'r2 bucket info', exitCode: 1, stderr: 'A request failed with status: 503\n', times: 1}],
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.calls.filter(({argv}) => argv[0] === 'r2' && argv[1] === 'bucket')).toHaveLength(2)
  })

  it('stops after three attempts', async () => {
    const result = await runCli(project(), args, {
      cloudflare: {},
      rules: [{command: 'deployments status', exitCode: 1, stderr: '✘ [ERROR] fetch failed\n', worker: 'orders-v1-staging'}],
    })

    expect(result.exitCode).toBe(1)
    expect(statusOf(result.calls).filter((name) => name === 'orders-v1-staging')).toHaveLength(3)
  })

  it('is not tried again after an answer', async () => {
    const result = await runCli(project(), args, {
      cloudflare: {},
      rules: [{command: 'deployments status', exitCode: 1, stderr: '✘ [ERROR] Authentication error [code: 10000]\n', worker: 'orders-v1-staging'}],
    })

    expect(result.exitCode).toBe(3)
    expect(statusOf(result.calls).filter((name) => name === 'orders-v1-staging')).toHaveLength(1)
  })
})

describe('monocf plan', () => {
  describe('a first run, with nothing deployed', () => {
    it('plans to create everything, callees first, and asks no more than it must', async () => {
      const fixture = project()

      const result = await runCli(fixture, args, {cloudflare: {}})

      expect(result.exitCode).toBe(0)
      const plan = planOf(fixture)
      expect(plan).toMatchObject({applicable: true, env: 'staging', notes: [], schemaVersion: 1, state: 'file:state', wrangler: '4.151.0'})
      expect(plan.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(plan.steps.map(({worker}: {worker: string}) => worker)).toEqual(['orders', 'billing', 'gateway'])
      expect(plan.steps.map(({action}: {action: string}) => action)).toEqual(['create', 'create', 'create'])
      expect(plan.steps[0]).toMatchObject({
        callers: ['billing'],
        dependsOn: [],
        deployedName: 'orders-v1-staging',
        reasons: ['new'],
        transitiveCallers: ['billing', 'gateway'],
        version: '1.0.0',
      })
      expect(plan.steps[1].dependsOn).toEqual(['orders'])
      expect(plan.steps[2].dependsOn).toEqual(['billing'])
      expect(plan.steps[0].fingerprint).toMatch(/^[0-9a-f]{64}$/)

      expect(reads(result.calls, 'deployments status').sort()).toEqual(['billing-v1-staging', 'gateway-v1-staging', 'orders-v1-staging'])
      expect(reads(result.calls, 'versions view')).toEqual([])
    })

    it('reads by name, with no config, and bundles too', async () => {
      const fixture = project({workers: [{name: 'orders'}]})

      const result = await runCli(fixture, args, {cloudflare: {}})

      const read = result.calls.find(({argv}) => argv[0] === 'deployments')!
      expect(read.argv).toEqual(['deployments', 'status', '--name', 'orders-v1-staging', '--json'])
      expect(read.config).toBeNull()
      expect(result.calls.some(({argv}) => argv.includes('--dry-run'))).toBe(true)
    })

    it('writes the plan path to stdout, and the summary to stderr', async () => {
      const fixture = project()

      const result = await runCli(fixture, args, {cloudflare: {}})

      expect(result.stdout.trim()).toBe(join(fixture.root, '.monocf', 'plan', 'staging.json'))
      expect(result.stderr).toContain('3 create')
      expect(result.stderr).toContain('orders: create (new)')
      expect(result.stderr).toContain('1. orders')
    })

    it('leaves the source tree alone', async () => {
      const fixture = project()

      await runCli(fixture, args, {cloudflare: {}})

      expect(existsSync(join(fixture.worker('orders'), 'dist'))).toBe(false)
      expect(existsSync(join(fixture.root, '.monocf', 'runs'))).toBe(false)
    })
  })

  describe('classification through the CLI', () => {
    it('skips what is in sync, without reading a tag', async () => {
      const {cloudflare, fixture} = await inSync()

      const result = await runCli(fixture, args, {cloudflare})

      expect(result.exitCode).toBe(0)
      expect(actionsOf(planOf(fixture))).toEqual({billing: 'skip', gateway: 'skip', orders: 'skip'})
      expect(reads(result.calls, 'versions view')).toEqual([])
    })

    it('uploads what changed, and only what changed', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      writeState(fixture, {...steps, orders: {...steps.orders, bundleHash: 'old', fingerprint: 'old'}})

      const result = await runCli(fixture, args, {cloudflare})

      expect(result.exitCode).toBe(0)
      const plan = planOf(fixture)
      expect(actionsOf(plan)).toEqual({billing: 'skip', gateway: 'skip', orders: 'upload'})
      expect(plan.steps[0].reasons).toEqual(['bundle-changed'])
      expect(plan.steps[0].previousVersionId).toBe('live-orders')
    })

    it('sees a version nobody recorded as drift, reading only that tag, and warns', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      const name = steps.orders.deployedName
      cloudflare.workers[name] = {active: [['manual', 100]], tags: {manual: null}}

      const result = await runCli(fixture, args, {cloudflare})

      expect(result.exitCode).toBe(0)
      const plan = planOf(fixture)
      expect(actionsOf(plan).orders).toBe('upload')
      expect(plan.steps[0].reasons).toEqual(['drift'])
      expect(plan.notes.map(({kind}: {kind: string}) => kind)).toEqual(['drift'])
      expect(reads(result.calls, 'versions view')).toEqual([name])
      expect(result.stderr).toContain('warning drift: orders')
    })

    it('blocks drift with --on-drift fail: writes the plan, marks it, and exits 1', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      cloudflare.workers[steps.orders.deployedName] = {active: [['manual', 100]], tags: {manual: null}}

      const result = await runCli(fixture, [...args, '--on-drift', 'fail'], {cloudflare})

      expect(result.exitCode).toBe(1)
      const plan = planOf(fixture)
      expect(plan.applicable).toBe(false)
      expect(actionsOf(plan)).toEqual({billing: 'skip', gateway: 'skip', orders: 'blocked'})
      expect(result.stderr).toContain("Blocked: this plan can't be applied")
    })

    it('treats a split rollout as drift', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      cloudflare.workers[steps.orders.deployedName] = {active: [['live-orders', 60], ['other', 40]]}

      const result = await runCli(fixture, args, {cloudflare})

      expect(result.exitCode).toBe(0)
      expect(planOf(fixture).steps[0]).toMatchObject({action: 'upload', reasons: ['drift', 'split']})
      expect(reads(result.calls, 'versions view')).toEqual([])
    })

    it('sees a stale manifest through the tag', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      cloudflare.workers[steps.orders.deployedName] = {active: [['newer', 100]], tags: {newer: `monocf:${steps.orders.fingerprint}`}}

      const result = await runCli(fixture, [...args, '--on-drift', 'fail'], {cloudflare})

      expect(result.exitCode).toBe(0)
      const plan = planOf(fixture)
      expect(plan.steps[0]).toMatchObject({action: 'skip', previousVersionId: 'newer'})
      expect(plan.notes.map(({kind}: {kind: string}) => kind)).toEqual(['state-behind'])
    })

    it('adopts what carries the tag when the state has no entry', async () => {
      const fixture = project()
      const steps = await learn(fixture)

      const result = await runCli(fixture, args, {cloudflare: liveCloudflare(steps)})

      expect(result.exitCode).toBe(0)
      expect(actionsOf(planOf(fixture))).toEqual({billing: 'adopt', gateway: 'adopt', orders: 'adopt'})
      expect(reads(result.calls, 'versions view')).toHaveLength(3)
    })

    it('uploads over what exists with another tag when the state has no entry', async () => {
      const fixture = project()
      const steps = await learn(fixture)
      const cloudflare = liveCloudflare(steps)
      cloudflare.workers[steps.orders.deployedName].tags = {'live-orders': 'by-hand'}

      await runCli(fixture, args, {cloudflare})

      expect(planOf(fixture).steps[0]).toMatchObject({action: 'upload', reasons: ['baseline']})
    })

    it('uploads the callers of a provider that was deleted and is created again', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      delete cloudflare.workers[steps.orders.deployedName]

      await runCli(fixture, args, {cloudflare})

      const plan = planOf(fixture)
      expect(actionsOf(plan)).toEqual({billing: 'upload', gateway: 'skip', orders: 'create'})
      expect(plan.steps[1]).toMatchObject({dependsOn: ['orders'], reasons: ['provider-recreated']})
    })

    it('records that crons have to go when a config drops them', async () => {
      const fixture = project({workers: [{name: 'orders'}]})
      const steps = await learn(fixture)
      const withCrons = {...steps.orders, triggers: {...steps.orders.triggers, crons: ['0 0 * * *']}, triggersHash: 'old'}
      writeState(fixture, {orders: withCrons})

      await runCli(fixture, args, {cloudflare: liveCloudflare(steps)})

      expect(planOf(fixture).steps[0]).toMatchObject({action: 'triggers', explicitEmptyCrons: true})
    })
  })

  describe('reads that fail', () => {
    it('stops on any failure other than 10007, and calls nothing missing', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      const rules = [{command: 'deployments status', exitCode: 1, stderr: 'fetch failed\n', worker: steps.orders.deployedName}]

      const result = await runCli(fixture, args, {cloudflare, rules})

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('fetch failed')
      expect(existsSync(join(fixture.root, '.monocf', 'plan', 'staging.json'))).toBe(false)
    })

    it('removes an older plan, so that apply can not find one after a failure', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      await runCli(fixture, args, {cloudflare})
      expect(existsSync(join(fixture.root, '.monocf', 'plan', 'staging.json'))).toBe(true)

      const rules = [{command: 'deployments status', exitCode: 1, stderr: 'boom\n', worker: steps.orders.deployedName}]
      const result = await runCli(fixture, args, {cloudflare, rules})

      expect(result.exitCode).toBe(1)
      expect(existsSync(join(fixture.root, '.monocf', 'plan', 'staging.json'))).toBe(false)
    })

    it('exits 3 when every read lacks credentials', async () => {
      const fixture = project()
      const stderr = "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable\n"

      const result = await runCli(fixture, args, {cloudflare: {}, rules: [{command: 'deployments status', exitCode: 1, stderr}]})

      expect(result.exitCode).toBe(3)
    })

    it('keeps expected failures off the terminal', async () => {
      const fixture = project()

      const result = await runCli(fixture, args, {cloudflare: {}})

      expect(result.stderr).not.toContain('10007')
    })

    it('fails on a bad answer from wrangler', async () => {
      const fixture = project()

      const result = await runCli(fixture, args, {rules: [{command: 'deployments status', stdout: 'oops'}]})

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("isn't JSON")
    })

    it('reports a kill as a kill', async () => {
      const fixture = project({workers: [{name: 'orders'}]})

      const result = await runCli(fixture, args, {rules: [{command: 'deployments status', signal: 'SIGKILL'}]})

      if (process.platform === 'win32') expect(result.exitCode).toBe(1)
      else expect(result.exitCode).toBe(137)
    })

    it('reads with the account a worker sets for itself', async () => {
      const fixture = project({workers: [{config: {account_id: 'account-of-orders'}, name: 'orders'}, {name: 'billing'}]})

      const result = await runCli(fixture, args, {cloudflare: {}})

      const accountOf = (name: string) =>
        result.calls.find(({argv}) => argv[0] === 'deployments' && argv.includes(name))!.environment.CLOUDFLARE_ACCOUNT_ID
      expect(accountOf('orders-v1-staging')).toBe('account-of-orders')
      expect(accountOf('billing-v1-staging')).toBe('00000000000000000000000000000000')
    })

    it('reads with what a worker .env says, as its writes do, with its own account_id and the real environment first', async () => {
      const fixture = project({
        files: {
          'workers/billing/.env': 'CLOUDFLARE_ACCOUNT_ID=account-of-billing-dotenv\nFROM_DOTENV=billing\n',
          'workers/orders/.env': 'CLOUDFLARE_ACCOUNT_ID=account-of-orders-dotenv\n',
        },
        workers: [{config: {account_id: 'account-of-orders'}, name: 'orders'}, {name: 'billing'}],
      })

      const unset = await runCli(fixture, args, {cloudflare: {}, env: {CLOUDFLARE_ACCOUNT_ID: ''}})
      const set = await runCli(fixture, args, {cloudflare: {}})

      expect(read(unset, 'orders-v1-staging').environment.CLOUDFLARE_ACCOUNT_ID).toBe('account-of-orders')
      expect(read(unset, 'billing-v1-staging').environment.CLOUDFLARE_ACCOUNT_ID).toBe('account-of-billing-dotenv')
      expect(read(unset, 'billing-v1-staging').dotEnvValues).toEqual({FROM_DOTENV: 'billing'})
      expect(read(set, 'billing-v1-staging').environment.CLOUDFLARE_ACCOUNT_ID).toBe('00000000000000000000000000000000')

      const build = unset.calls.find(({argv, config}) => argv.includes('--dry-run') && config?.name === 'billing-v1')!
      expect(build.environment.CLOUDFLARE_ACCOUNT_ID).toBe('account-of-billing-dotenv')
    })

    it('never prints what a worker .env holds', async () => {
      const fixture = project({files: {'workers/orders/.env': 'FROM_SECRET=value-that-stays-out-of-the-log\n'}, workers: [{name: 'orders'}]})

      const text = await runCli(fixture, args, {cloudflare: {}})
      const json = await runCli(fixture, [...args, '--json'], {cloudflare: {}})

      expect(text.calls.some(({dotEnvValues}) => dotEnvValues.FROM_SECRET !== undefined)).toBe(true)
      expect(`${text.stdout}${text.stderr}${json.stdout}${json.stderr}`).not.toContain('value-that-stays-out-of-the-log')
    })
  })

  describe('the state store', () => {
    const r2 = ['plan', '-e', 'staging', '--state', 'r2://monocf-state/ci', '--first-run']

    it('exits 3 on a missing bucket, and never reads it as empty state', async () => {
      const fixture = project()

      const result = await runCli(fixture, r2, {cloudflare: {buckets: {}}})

      expect(result.exitCode).toBe(3)
      expect(result.stderr).toContain('wrangler r2 bucket create monocf-state')
      expect(result.calls.some(({argv}) => argv[0] === 'r2' && argv[1] === 'object')).toBe(false)
      expect(reads(result.calls, 'deployments status')).toEqual([])
    })

    it('takes a missing manifest in a bucket that exists as a first run', async () => {
      const fixture = project()

      const result = await runCli(fixture, r2, {cloudflare: {buckets: {'monocf-state': {}}}})

      expect(result.exitCode).toBe(0)
      expect(result.calls.find(({argv}) => argv[1] === 'object')!.argv).toEqual([
        'r2',
        'object',
        'get',
        'monocf-state/ci/staging/manifest.json',
        '--remote',
        '--pipe',
      ])
      expect(planOf(fixture).state).toBe('r2://monocf-state/ci')
    })

    it('reads the manifest from the bucket', async () => {
      const {cloudflare, fixture} = await inSync()
      const manifest = readFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), 'utf8')

      const result = await runCli(fixture, r2, {
        cloudflare: {...cloudflare, buckets: {'monocf-state': {'ci/staging/manifest.json': manifest}}},
      })

      expect(result.exitCode).toBe(0)
      expect(actionsOf(planOf(fixture))).toEqual({billing: 'skip', gateway: 'skip', orders: 'skip'})
    })

    it('exits 3 on a missing file store directory', async () => {
      const fixture = project()

      const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:nowhere'], {cloudflare: {}})

      expect(result.exitCode).toBe(3)
      expect(reads(result.calls, 'deployments status')).toEqual([])
    })

    it.each(['s3://bucket/key', 'state'])('exits 2 on the scheme of %s, having run nothing', async (state) => {
      const fixture = project()

      const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', state], {noCalls: true})

      expect(result.exitCode).toBe(2)
      expect(result.calls).toEqual([])
    })

    it.each<[string, Record<string, unknown>]>([
      ['a newer schema', {schemaVersion: 2}],
      ['another env', {env: 'production'}],
    ])('exits 3 on a manifest with %s', async (_, change) => {
      const {cloudflare, fixture, steps} = await inSync()
      writeState(fixture, steps, change)

      const result = await runCli(fixture, args, {cloudflare})

      expect(result.exitCode, result.stderr).toBe(3)
      expect(reads(result.calls, 'deployments status')).toEqual([])
    })

    it('exits 3 on a manifest that is not JSON, rather than planning a redeploy', async () => {
      const {cloudflare, fixture} = await inSync()
      writeFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), '')

      const result = await runCli(fixture, args, {cloudflare})

      expect(result.exitCode).toBe(3)
      expect(existsSync(join(fixture.root, '.monocf', 'plan', 'staging.json'))).toBe(false)
    })
  })

  describe('check comes first', () => {
    it('exits 2 on a cycle, having run nothing', async () => {
      const fixture = project({
        workers: [
          {envBindings: {staging: ['billing']}, name: 'orders'},
          {envBindings: {staging: ['orders']}, name: 'billing'},
        ],
      })

      const result = await runCli(fixture, args, {noCalls: true})

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('Binding cycle')
      expect(result.calls).toEqual([])
    })

    it('exits 2 on any error a check would report', async () => {
      const fixture = project({workers: [{config: {main: 'src/missing.ts'}, name: 'orders'}]})

      const result = await runCli(fixture, args, {noCalls: true})

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('missing-main')
    })

    it('exits 2 on an env that does not exist', async () => {
      const fixture = project()

      const result = await runCli(fixture, ['plan', '-e', 'nope', '--state', 'file:state'], {noCalls: true})

      expect(result.exitCode).toBe(2)
    })

    it('reports warnings and carries on', async () => {
      const fixture = project({ignore: ['no-such-worker'], workers: [{name: 'orders'}]})

      const result = await runCli(fixture, args, {cloudflare: {}})

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain('warning ignored-stale')
    })

    it('plans a cycle only a queue closes, without a cycle in the order', async () => {
      const fixture = project({
        workers: [
          {config: {env: {staging: {queues: {consumers: [{queue: 'a'}], producers: [{binding: 'Q', queue: 'b'}]}}}}, name: 'one'},
          {config: {env: {staging: {queues: {consumers: [{queue: 'b'}], producers: [{binding: 'Q', queue: 'a'}]}}}}, name: 'two'},
        ],
      })

      const result = await runCli(fixture, args, {cloudflare: {}})

      expect(result.exitCode).toBe(0)
      expect(planOf(fixture).steps.map(({dependsOn}: {dependsOn: string[]}) => dependsOn)).toEqual([[], []])
    })
  })

  describe('what is left out', () => {
    it('never touches a worker in .monocfignore, even with state for it', async () => {
      const fixture = project({ignore: ['legacy'], workers: [{name: 'orders'}, {name: 'legacy'}]})
      const steps = await learn(fixture)
      writeState(fixture, {...steps, legacy: {...steps.orders, deployedName: 'legacy-v1-staging', worker: 'legacy'}})

      const result = await runCli(fixture, args, {cloudflare: liveCloudflare(steps)})

      expect(result.exitCode).toBe(0)
      const plan = planOf(fixture)
      expect(plan.steps.map(({worker}: {worker: string}) => worker)).toEqual(['orders'])
      expect(plan.notes).toEqual([])
      expect(result.calls.some(({argv}) => argv.includes('legacy-v1-staging'))).toBe(false)
      expect(result.calls.some(({config}) => config?.name?.startsWith('legacy'))).toBe(false)
    })

    it('exits 2 when an ignored worker is named', async () => {
      const fixture = project({ignore: ['legacy'], workers: [{name: 'orders'}, {name: 'legacy'}]})

      const result = await runCli(fixture, [...args, '--workers', 'legacy'], {noCalls: true})

      expect(result.exitCode).toBe(2)
    })

    it('lists a known worker that left the repository as an orphan, and never reads or removes it', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      writeState(fixture, {...steps, gone: {...steps.orders, deployedName: 'gone-v1-staging', worker: 'gone'}})

      const result = await runCli(fixture, args, {cloudflare})

      expect(result.exitCode).toBe(0)
      expect(planOf(fixture).notes).toEqual([expect.objectContaining({deployedName: 'gone-v1-staging', kind: 'orphan', worker: 'gone'})])
      expect(result.calls.some(({argv}) => argv.includes('gone-v1-staging'))).toBe(false)
      expect(result.stderr).toContain('orphan: gone')
    })

    it('plans only --workers, with callers from the whole graph', async () => {
      const {cloudflare, fixture} = await inSync()

      const result = await runCli(fixture, [...args, '--workers', 'orders, billing'], {cloudflare})

      expect(result.exitCode).toBe(0)
      const plan = planOf(fixture)
      expect(plan.steps.map(({worker}: {worker: string}) => worker)).toEqual(['orders', 'billing'])
      expect(plan.steps[1].callers).toEqual(['gateway'])
      expect(reads(result.calls, 'deployments status').sort()).toEqual(['billing-v1-staging', 'orders-v1-staging'])
    })

    it.each(['nope', 'orders,,billing', ''])('exits 2 on --workers %j', async (value) => {
      const fixture = project()

      const result = await runCli(fixture, [...args, '--workers', value], {noCalls: true})

      expect(result.exitCode).toBe(2)
    })
  })

  describe('--bundle-dir', () => {
    async function bundled(fixture: Fixture, env: string, extra: Record<string, string> = {}) {
      const result = await runCli(fixture, ['bundle', '-e', env, '--out', 'built'], {env: extra})
      expect(result.exitCode).toBe(0)
    }

    it('uses a manifest that matches, and builds nothing', async () => {
      const fixture = project()
      await bundled(fixture, 'staging')

      const result = await runCli(fixture, [...args, '--bundle-dir', 'built'], {cloudflare: {}})

      expect(result.exitCode).toBe(0)
      expect(dryRuns(result.calls)).toEqual([])
      expect(planOf(fixture).steps).toHaveLength(3)
    })

    it('uses only the selected workers of a manifest that holds more', async () => {
      const fixture = project()
      await bundled(fixture, 'staging')

      await runCli(fixture, [...args, '--bundle-dir', 'built', '--workers', 'orders'], {cloudflare: {}})

      expect(planOf(fixture).steps.map(({worker}: {worker: string}) => worker)).toEqual(['orders'])
    })

    it.each<[string, {bundleEnv?: string; env?: Record<string, string>}, RegExp]>([
      ['another env', {bundleEnv: 'production'}, /it is for env production/],
      ['another commit', {env: {GITHUB_SHA: 'f'.repeat(40)}}, /it is for another commit/],
    ])('builds again when it is for %s', async (_, {bundleEnv = 'staging', env}, message) => {
      const fixture = project()
      await bundled(fixture, bundleEnv)

      const result = await runCli(fixture, [...args, '--bundle-dir', 'built'], {cloudflare: {}, env})

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toMatch(message)
      expect(dryRuns(result.calls)).toHaveLength(3)
      // The directory it was given stays as it was.
      expect(JSON.parse(readFileSync(join(fixture.root, 'built', 'manifest.json'), 'utf8')).env).toBe(bundleEnv)
    })

    it('builds when the directory holds no manifest', async () => {
      const fixture = project()

      const result = await runCli(fixture, [...args, '--bundle-dir', 'nowhere'], {cloudflare: {}})

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain('it has no readable manifest')
      expect(dryRuns(result.calls)).toHaveLength(3)
    })

    it('still refuses a manifest whose bindings name a missing entrypoint', async () => {
      const fixture = project({
        workers: [
          {config: {env: {staging: {services: [{binding: 'B', entrypoint: 'Nope', service: 'billing'}]}}}, name: 'orders'},
          {name: 'billing'},
        ],
      })
      const rules = [{bundle: 'export {Known};\n', command: 'deploy --dry-run', worker: 'billing'}]
      const built = await runCli(fixture, ['bundle', '-e', 'staging', '--out', 'built'], {rules})
      expect(built.exitCode).toBe(1)

      const result = await runCli(fixture, [...args, '--bundle-dir', 'built'], {cloudflare: {}, noCalls: true})

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('unknown-entrypoint')
      expect(existsSync(join(fixture.root, '.monocf', 'plan', 'staging.json'))).toBe(false)
    })

    it('exits 1 when a build fails, and writes no plan', async () => {
      const fixture = project()

      const result = await runCli(fixture, args, {cloudflare: {}, rules: [{command: 'deploy --dry-run', exitCode: 1, worker: 'orders'}]})

      expect(result.exitCode).toBe(1)
      expect(reads(result.calls, 'deployments status')).toEqual([])
      expect(existsSync(join(fixture.root, '.monocf', 'plan', 'staging.json'))).toBe(false)
    })
  })

  describe('output', () => {
    it('gives identical bytes for the same inputs, apart from createdAt', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      cloudflare.workers[steps.orders.deployedName] = {active: [['manual', 100]], tags: {manual: null}}
      const read = () =>
        readFileSync(join(fixture.root, 'one.json'), 'utf8').replace(/"createdAt": "[^"]*"/, '"createdAt": ""')

      await runCli(fixture, [...args, '--out', 'one.json'], {cloudflare})
      const first = read()
      await runCli(fixture, [...args, '--out', 'one.json'], {cloudflare})

      expect(read()).toBe(first)
      expect(first).toContain('"action": "upload"')
    })

    it('writes the plan with --out and a summary with --markdown', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      writeState(fixture, {...steps, orders: {...steps.orders, bundleHash: 'old', fingerprint: 'old'}})

      const result = await runCli(fixture, [...args, '--out', 'out/plan.json', '--markdown', 'plan.md'], {cloudflare})

      expect(result.exitCode).toBe(0)
      expect(planOf(fixture, join('out', 'plan.json')).steps).toHaveLength(3)
      const markdown = readFileSync(join(fixture.root, 'plan.md'), 'utf8')
      expect(markdown).toContain('| upload | 1 |')
      expect(markdown).toContain('| orders | upload | bundle-changed |')
      expect(markdown).toContain('`billing`')
      expect(markdown).not.toContain('live-orders')
    })

    it('writes the markdown for a blocked plan too', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      cloudflare.workers[steps.orders.deployedName] = {active: [['manual', 100]], tags: {manual: null}}

      await runCli(fixture, [...args, '--on-drift', 'fail', '--markdown', 'plan.md'], {cloudflare})

      expect(readFileSync(join(fixture.root, 'plan.md'), 'utf8')).toContain('**Blocked')
    })

    it('keeps stdout to NDJSON with --json, ending in a plan event', async () => {
      const {cloudflare, fixture} = await inSync()

      const result = await runCli(fixture, [...args, '--json'], {cloudflare})

      expect(result.exitCode).toBe(0)
      const events = eventsOf(result)
      expect(events.at(-1)).toMatchObject({path: join(fixture.root, '.monocf', 'plan', 'staging.json'), schemaVersion: 1, type: 'plan'})
      expect(events.at(-1)!.plan).toEqual(planOf(fixture))
      expect(events.map(({type}) => type)).toContain('run-finished')
      expect(result.stderr).not.toContain('Plan for')
    })

    it('reports a blocked plan as a failed run, still ending in the plan', async () => {
      const {cloudflare, fixture, steps} = await inSync()
      cloudflare.workers[steps.orders.deployedName] = {active: [['manual', 100]], tags: {manual: null}}

      const result = await runCli(fixture, [...args, '--on-drift', 'fail', '--json'], {cloudflare})

      expect(result.exitCode).toBe(1)
      const events = eventsOf(result)
      expect(events.at(-1)).toMatchObject({plan: {applicable: false}, type: 'plan'})
      expect(events.find(({type}) => type === 'run-finished')).toMatchObject({exitCode: 1, status: 'failed'})
    })

    it.each([
      ['--out', ''],
      ['--markdown', ''],
      ['--bundle-dir', ''],
      ['--on-drift', 'maybe'],
    ])('exits 2 on %s %j', async (flag, value) => {
      const fixture = project()

      const result = await runCli(fixture, [...args, flag, value], {noCalls: true})

      expect(result.exitCode).toBe(2)
    })

    it('exits 2 without --state or --env', async () => {
      const fixture = project()

      expect((await runCli(fixture, ['plan', '-e', 'staging'], {noCalls: true})).exitCode).toBe(2)
      expect((await runCli(fixture, ['plan', '--state', 'file:state'], {noCalls: true})).exitCode).toBe(2)
    })
  })
})
