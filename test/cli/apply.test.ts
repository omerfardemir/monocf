import {createHash} from 'node:crypto'
import {appendFileSync, existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {
  actionsOf,
  activeOf,
  applyPlan,
  callsOf,
  changeConfig,
  commitAll,
  deployFixture,
  eventsOf,
  firstRun,
  lastRunRecord,
  manifestOf,
  newCode,
  planFor,
  readPlan,
  runIds,
  stepOf,
  writePlan,
  writesOf,
} from '../helpers/deploy-fixtures.js'
import {flagValue, releaseOf, runCli, startCli} from '../helpers/harness.js'

const comesBefore = (writes: string[], first: string, second: string) => {
  expect(writes).toContain(first)
  expect(writes).toContain(second)
  expect(writes.indexOf(first)).toBeLessThan(writes.indexOf(second))
}

/** billing is gone from Cloudflare, and the manifest remembers it. */
async function recreated() {
  const fixture = deployFixture()
  const cloudflare = await firstRun(fixture)
  const plan = await planFor(fixture, cloudflare)
  const name = stepOf(plan, 'billing').deployedName
  const {[name]: gone, ...rest} = cloudflare.workers!
  expect(gone).toBeDefined()
  const without = {...cloudflare, workers: rest}
  return {cloudflare: without, fixture, plan: await planFor(fixture, without, {flags: ['--allow-recreate']})}
}

const accountOfCall = ({environment}: {environment: Record<string, string>}) => environment.CLOUDFLARE_ACCOUNT_ID

async function planned() {
  const fixture = deployFixture()
  await planFor(fixture, {}, {flags: ['--first-run']})
  return fixture
}

const refuses = async (fixture: ReturnType<typeof deployFixture>, pattern: RegExp, flags: string[] = [], env: Record<string, string> = {}) => {
  const result = await runCli(fixture, ['apply', 'plan.json', ...flags], {cloudflare: {}, env, noCalls: true})
  expect(result.exitCode, result.stderr).toBe(2)
  expect(result.stderr).toMatch(pattern)
  expect(result.calls).toEqual([])
}

describe('apply, on a first run', () => {
  it('creates callees first, and leaves state and a run record', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    const plan = readPlan(fixture)

    const result = await applyPlan(fixture, {})

    expect(result.exitCode, result.stderr).toBe(0)
    const writes = writesOf(result.calls)
    comesBefore(writes, 'deploy billing', 'deploy orders')
    comesBefore(writes, 'deploy orders', 'deploy gateway')
    expect(writes).toContain('deploy reports')
    const manifest = manifestOf(fixture)
    expect(Object.keys(manifest.workers).sort()).toEqual(['billing', 'gateway', 'orders', 'reports'])
    expect(manifest.workers.orders.versionId).toBe(activeOf(result.cloudflare, stepOf(plan, 'orders')))
    expect(manifest.workers.orders.fingerprint).toBe(stepOf(plan, 'orders').fingerprint)
    expect(manifest.workers.orders.commit).toBe(plan.commit)
    const record = lastRunRecord(fixture)
    expect(record.kind).toBe('apply')
    expect(record.workers.orders).toMatchObject({action: 'create', changed: true, previous: null, result: 'ok'})
    expect(result.stderr).toContain(record.runId)
  })

  it('tags and labels what it deploys, and never keeps stray vars', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    const plan = readPlan(fixture)

    const {calls} = await applyPlan(fixture, {})

    const [deploy] = callsOf(calls, 'deploy billing')
    const sha = plan.commit.slice(0, 7)
    expect(flagValue(deploy, '--tag')).toBe(`monocf:${stepOf(plan, 'billing').fingerprint}`)
    expect(flagValue(deploy, '--env')).toBe('staging')
    expect(flagValue(deploy, '--message')).toMatch(new RegExp(`^monocf \\d{8}T\\d{6}Z-[0-9a-f]{6} ${sha} `))
    expect(releaseOf(deploy)).toBe(sha)
    expect(deploy.argv).not.toContain('--keep-vars')
  })
})

describe('apply, with nothing to do', () => {
  it('writes nothing to Cloudflare and still ends with a run record', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const plan = await planFor(fixture, cloudflare)
    expect(Object.values(actionsOf(plan))).toEqual(['skip', 'skip', 'skip', 'skip'])
    const runs = runIds(fixture).length

    const result = await applyPlan(fixture, cloudflare, {noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.calls).toEqual([])
    expect(runIds(fixture)).toHaveLength(runs + 1)
    expect(lastRunRecord(fixture).workers.orders).toMatchObject({action: 'skip', changed: false, result: 'unchanged'})
  })
})

describe('apply, with new code', () => {
  it('uploads everything before it promotes anything, and promotes callees first', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const plan = await planFor(fixture, cloudflare, {rules: newCode('billing', 'orders', 'gateway')})
    expect(actionsOf(plan)).toEqual({billing: 'upload', gateway: 'upload', orders: 'upload', reports: 'skip'})

    const result = await applyPlan(fixture, cloudflare)

    expect(result.exitCode, result.stderr).toBe(0)
    const writes = writesOf(result.calls)
    expect(writes.slice(0, 3).sort()).toEqual(['upload billing', 'upload gateway', 'upload orders'])
    expect(writes.slice(3)).toEqual(['promote billing', 'promote orders', 'promote gateway'])
  })

  it('holds a promote until the worker it calls has finished', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing', 'orders')})

    const result = await applyPlan(fixture, cloudflare, {flags: ['--json'], rules: [{command: 'versions deploy', delayMs: 1500, worker: 'billing'}]})

    expect(result.exitCode, result.stderr).toBe(0)
    const events = eventsOf(result)
    const billingDone = events.findIndex(({action, type, worker}) => type === 'step-finished' && action === 'promote' && worker === 'billing')
    const ordersStart = events.findIndex(({action, type, worker}) => type === 'step-started' && action === 'promote' && worker === 'orders')
    expect(billingDone).toBeGreaterThan(-1)
    expect(ordersStart).toBeGreaterThan(billingDone)
  })

  it('holds a create until the worker it calls has finished', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})

    const result = await applyPlan(fixture, {}, {flags: ['--json'], rules: [{command: 'deploy', delayMs: 1500, worker: 'billing'}]})

    expect(result.exitCode, result.stderr).toBe(0)
    const events = eventsOf(result)
    const billingDone = events.findIndex(({action, type, worker}) => type === 'step-finished' && action === 'deploy' && worker === 'billing')
    const ordersStart = events.findIndex(({action, type, worker}) => type === 'step-started' && action === 'deploy' && worker === 'orders')
    expect(billingDone).toBeGreaterThan(-1)
    expect(ordersStart).toBeGreaterThan(billingDone)
  })

  it('runs one step at a time with --concurrency 1', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing', 'reports')})

    const result = await applyPlan(fixture, cloudflare, {flags: ['--json', '--concurrency', '1'], rules: [{command: 'versions upload', delayMs: 500}]})

    expect(result.exitCode, result.stderr).toBe(0)
    const uploads = eventsOf(result).filter(({action}) => action === 'upload').map(({type}) => type)
    expect(uploads).toEqual(['step-started', 'step-finished', 'step-started', 'step-finished'])
  })

  it('minifies what it uploads and deploys when the project says so', async () => {
    const fixture = deployFixture({monocfConfig: {minify: true}})
    await planFor(fixture, {}, {flags: ['--first-run']})
    const created = await applyPlan(fixture, {})
    expect(callsOf(created.calls, 'deploy billing')[0].argv).toContain('--minify')
    await planFor(fixture, created.cloudflare!, {rules: newCode('billing')})

    const result = await applyPlan(fixture, created.cloudflare!)

    expect(callsOf(result.calls, 'upload billing')[0].argv).toContain('--minify')
  })

  it('leaves minifying off when the project does not ask for it', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})

    const {calls} = await applyPlan(fixture, {})

    expect(callsOf(calls, 'deploy billing')[0].argv).not.toContain('--minify')
  })

  it('promotes the uploaded version, verifies it and records it', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const previous = manifestOf(fixture).workers.billing
    const plan = await planFor(fixture, cloudflare, {rules: newCode('billing')})

    const result = await applyPlan(fixture, cloudflare)

    const live = activeOf(result.cloudflare, stepOf(plan, 'billing'))
    expect(live).not.toBe(previous.versionId)
    const [promote] = callsOf(result.calls, 'promote billing')
    expect(promote.argv.slice(0, 4)).toEqual(['versions', 'deploy', `${live}@100%`, '--yes'])
    expect(flagValue(promote, '--env')).toBe('staging')
    expect(flagValue(callsOf(result.calls, 'upload billing')[0], '--tag')).toBe(`monocf:${stepOf(plan, 'billing').fingerprint}`)
    expect(result.calls.some(({argv}) => argv.join(' ').startsWith('deployments status'))).toBe(true)
    expect(manifestOf(fixture).workers.billing.versionId).toBe(live)
    expect(lastRunRecord(fixture).workers.billing).toMatchObject({
      changed: true,
      newVersionId: live,
      previous: {versionId: previous.versionId},
      previousVersionId: previous.versionId,
      result: 'ok',
    })
    expect(Object.values(actionsOf(await planFor(fixture, result.cloudflare!, {rules: newCode('billing')})))).toEqual(['skip', 'skip', 'skip', 'skip'])
  })

  it('reports the version on a promote and on a deploy, and never on an upload', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    const created = await applyPlan(fixture, {}, {flags: ['--json']})
    const deploys = eventsOf(created).filter(({action, type}) => type === 'step-finished' && action === 'deploy')
    expect(deploys).toHaveLength(4)
    expect(deploys.every(({versionId}) => typeof versionId === 'string')).toBe(true)

    await planFor(fixture, created.cloudflare!, {rules: newCode('billing')})
    const result = await applyPlan(fixture, created.cloudflare!, {flags: ['--json']})

    const events = eventsOf(result).filter(({type, worker}) => type === 'step-finished' && worker === 'billing')
    expect(events.map(({action}) => action)).toEqual(['upload', 'promote'])
    expect(events[0]).not.toHaveProperty('versionId')
    expect(events[1].versionId).toBe(manifestOf(fixture).workers.billing.versionId)
    expect(eventsOf(result).filter(({action, type, worker}) => type === 'step-started' && worker === 'billing' && action === 'upload')).toHaveLength(1)
  })
})

describe('apply, when a worker fails', () => {
  const allNew = newCode('billing', 'orders', 'gateway', 'reports')

  it('skips what calls an upload that failed, names what was left unpromoted, and carries on elsewhere', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const oldState = manifestOf(fixture).workers
    await planFor(fixture, cloudflare, {rules: allNew})

    const result = await applyPlan(fixture, cloudflare, {
      rules: [{command: 'versions upload', exitCode: 1, failCode: 10_143, failMessage: 'A service binding points at nothing.', worker: 'orders'}],
    })

    expect(result.exitCode).toBe(1)
    const writes = writesOf(result.calls)
    expect(writes).toContain('promote billing')
    expect(writes).toContain('promote reports')
    expect(writes).not.toContain('promote orders')
    expect(writes).not.toContain('promote gateway')
    expect(result.stderr).toMatch(/Uploaded and not promoted: gateway\b/)
    const state = manifestOf(fixture).workers
    expect(state.billing.versionId).not.toBe(oldState.billing.versionId)
    expect(state.orders.versionId).toBe(oldState.orders.versionId)
    expect(state.gateway.versionId).toBe(oldState.gateway.versionId)
    const {workers} = lastRunRecord(fixture)
    expect(workers.orders.result).toBe('failed')
    expect(workers.orders.message).toContain('A service binding points at nothing.')
    expect(workers.gateway).toMatchObject({changed: false, reason: 'orders', result: 'skipped'})
    expect(workers.gateway.uploadedVersionId).toBeDefined()
    expect(workers.gateway.newVersionId).toBeUndefined()
  })

  it('heals on the next plan and apply', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: allNew})
    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions upload', exitCode: 1, worker: 'orders'}]})

    const plan = await planFor(fixture, failed.cloudflare!, {rules: allNew})

    expect(actionsOf(plan)).toEqual({billing: 'skip', gateway: 'upload', orders: 'upload', reports: 'skip'})
    const result = await applyPlan(fixture, failed.cloudflare!)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls).slice(2)).toEqual(['promote orders', 'promote gateway'])
  })

  it('skips the callers of a promote that failed, through a worker with nothing to do', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing', 'gateway', 'reports')})

    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions deploy', exitCode: 1, worker: 'billing'}]})

    expect(result.exitCode).toBe(1)
    const writes = writesOf(result.calls)
    expect(writes).toContain('promote reports')
    expect(writes).not.toContain('promote gateway')
    expect(lastRunRecord(fixture).workers.gateway).toMatchObject({reason: 'billing', result: 'skipped'})
  })

  it('fails a promote that exits 0 and changes nothing', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const previous = manifestOf(fixture).workers.billing.versionId
    await planFor(fixture, cloudflare, {rules: newCode('billing')})

    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions deploy', noEffect: true, worker: 'billing'}]})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('verify-mismatch')
    expect(manifestOf(fixture).workers.billing.versionId).toBe(previous)
    expect(lastRunRecord(fixture).workers.billing.result).toBe('failed')
  })

  it('fails a create that exits 0 and changes nothing', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})

    const result = await applyPlan(fixture, {}, {rules: [{command: 'deploy', noEffect: true, worker: 'billing'}]})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('verify-mismatch')
    expect(writesOf(result.calls)).not.toContain('deploy orders')
    expect(manifestOf(fixture).workers.billing).toBeUndefined()
  })

  it('keeps an account ID out of what it records', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})
    const account = 'abcdef0123456789abcdef0123456789'

    await applyPlan(fixture, cloudflare, {
      flags: ['--summary-file', 'summary.md'],
      rules: [{command: 'versions upload', exitCode: 1, failMessage: `Failed on /accounts/${account}/workers`, worker: 'billing'}],
    })

    expect(JSON.stringify(lastRunRecord(fixture))).not.toContain(account)
    expect(readFileSync(join(fixture.root, 'summary.md'), 'utf8')).not.toContain(account)
  })
})

describe('apply, retrying', () => {
  const outage = {exitCode: 1, stderr: '✘ [ERROR] fetch failed\n', times: 1}

  it('tries a failed upload again after an outage', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})

    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions upload', ...outage}]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(callsOf(result.calls, 'upload billing')).toHaveLength(2)
  })

  it('leaves a failure that an outage does not explain', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})

    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions upload', exitCode: 1, stderr: '✘ [ERROR] A bad binding\n'}]})

    expect(result.exitCode).toBe(1)
    expect(callsOf(result.calls, 'upload billing')).toHaveLength(1)
  })

  it('does not promote again what an earlier attempt already promoted', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})

    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions deploy', effectThenFail: true, ...outage}]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(callsOf(result.calls, 'promote billing')).toHaveLength(1)
    expect(lastRunRecord(fixture).workers.billing.result).toBe('ok')
  })

  it('takes the version an earlier deploy left live, by its tag', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    const plan = readPlan(fixture)

    const result = await applyPlan(fixture, {}, {rules: [{command: 'deploy', effectThenFail: true, worker: 'billing', ...outage}]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(callsOf(result.calls, 'deploy billing')).toHaveLength(1)
    expect(manifestOf(fixture).workers.billing.versionId).toBe(activeOf(result.cloudflare, stepOf(plan, 'billing')))
  })

  it('deploys again when an earlier attempt left nothing of its own live', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})

    const result = await applyPlan(fixture, {}, {rules: [{command: 'deploy', worker: 'billing', ...outage}]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(callsOf(result.calls, 'deploy billing')).toHaveLength(2)
  })

  it('does not promote again when only the triggers failed', async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
    const cloudflare = await firstRun(fixture)
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 2 * * *']}})
    await planFor(fixture, cloudflare)

    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'triggers deploy', ...outage}]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(callsOf(result.calls, 'promote reports')).toHaveLength(1)
    expect(callsOf(result.calls, 'triggers reports')).toHaveLength(2)
  })
})

describe('apply, with triggers', () => {
  it('applies new crons after the promote', async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
    const cloudflare = await firstRun(fixture)
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 2 * * *']}})
    const plan = await planFor(fixture, cloudflare)

    const result = await applyPlan(fixture, cloudflare)

    expect(writesOf(result.calls)).toEqual(['upload reports', 'promote reports', 'triggers reports'])
    expect(result.cloudflare!.workers![stepOf(plan, 'reports').deployedName].triggers).toEqual({crons: ['0 2 * * *']})
  })

  it('clears crons a config has dropped', async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
    const cloudflare = await firstRun(fixture)
    changeConfig(fixture, 'reports', {})
    const plan = await planFor(fixture, cloudflare)
    expect(stepOf(plan, 'reports')).toMatchObject({explicitEmptyCrons: true})

    const result = await applyPlan(fixture, cloudflare)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.cloudflare!.workers![stepOf(plan, 'reports').deployedName].triggers).toEqual({crons: []})
  })

  it('keeps the new version and has the next plan apply the triggers, when they fail after a promote', async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
    const cloudflare = await firstRun(fixture)
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 2 * * *']}})
    const plan = await planFor(fixture, cloudflare)

    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'triggers deploy', exitCode: 1}]})

    expect(failed.exitCode).toBe(1)
    const live = activeOf(failed.cloudflare, stepOf(plan, 'reports'))
    expect(manifestOf(fixture).workers.reports.versionId).toBe(live)
    expect(lastRunRecord(fixture).workers.reports).toMatchObject({changed: true, newVersionId: live, result: 'failed'})
    const next = await planFor(fixture, failed.cloudflare!)
    expect(actionsOf(next).reports).toBe('triggers')
    const healed = await applyPlan(fixture, failed.cloudflare!)
    expect(writesOf(healed.calls)).toEqual(['triggers reports'])
    expect(healed.cloudflare!.workers![stepOf(plan, 'reports').deployedName].triggers).toEqual({crons: ['0 2 * * *']})
    expect(manifestOf(fixture).workers.reports.versionId).toBe(live)
    expect(actionsOf(await planFor(fixture, healed.cloudflare!)).reports).toBe('skip')
  })
})

describe('apply, around a recreated provider', () => {
  it('notes the callers before it creates the provider', async () => {
    const {cloudflare, fixture, plan} = await recreated()
    expect(stepOf(plan, 'billing')).toMatchObject({action: 'create', markCallers: ['orders']})

    const running = startCli(fixture, ['apply', 'plan.json'], {cloudflare, rules: [{command: 'deploy', delayMs: 1500, worker: 'billing'}]})
    await running.waitForCalls(1)
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])
    const result = await running.done

    expect(result.exitCode, result.stderr).toBe(0)
    expect(manifestOf(fixture).needsNewVersion).toBeUndefined()
  })

  it('still gives the callers a new version on the next plan, when the create fails', async () => {
    const {cloudflare, fixture} = await recreated()

    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'deploy', exitCode: 1, worker: 'billing'}]})

    expect(failed.exitCode).toBe(1)
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])
    const next = await planFor(fixture, failed.cloudflare!, {flags: ['--allow-recreate']})
    expect(actionsOf(next).orders).toBe('upload')
  })

  it("still gives a caller a new version when the provider exists and the caller's upload failed", async () => {
    const {cloudflare, fixture} = await recreated()

    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions upload', exitCode: 1, worker: 'orders'}]})

    expect(failed.exitCode).toBe(1)
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])
    expect(actionsOf(await planFor(fixture, failed.cloudflare!)).orders).toBe('upload')
    const healed = await applyPlan(fixture, failed.cloudflare!)
    expect(healed.exitCode, healed.stderr).toBe(0)
    expect(manifestOf(fixture).needsNewVersion).toBeUndefined()
  })

  it('creates nothing when the note cannot be written', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const plan = await planFor(fixture, cloudflare)
    const manifest = readFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), 'utf8')
    const {[stepOf(plan, 'billing').deployedName]: gone, ...rest} = cloudflare.workers!
    expect(gone).toBeDefined()
    const without = {
      buckets: {'state-bucket': {'staging/manifest.json': manifest}},
      workers: rest,
    }
    const location = ['--state', 'r2://state-bucket']
    const planned = await runCli(fixture, ['plan', '-e', 'staging', ...location, '--out', 'plan.json', '--allow-recreate'], {cloudflare: without})
    expect(planned.exitCode, planned.stderr).toBe(0)

    const result = await applyPlan(fixture, without, {rules: [{command: 'r2 object put', exitCode: 1, stderr: 'no\n'}]})

    expect(result.exitCode).toBe(1)
    expect(writesOf(result.calls)).toEqual([])
  })
})

describe('apply, on what it finds already live', () => {
  it('records state for a worker whose version it recognises, with no state to go on', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const {workers} = manifestOf(fixture)
    rmSync(join(fixture.root, 'state', 'staging', 'manifest.json'))
    const plan = await planFor(fixture, cloudflare)
    expect(new Set(Object.values(actionsOf(plan)))).toEqual(new Set(['adopt']))

    const result = await applyPlan(fixture, cloudflare, {noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual([])
    expect(manifestOf(fixture).workers.orders.versionId).toBe(workers.orders.versionId)
    expect(actionsOf(await planFor(fixture, cloudflare)).orders).toBe('skip')
  })

  it('records a version a crashed run left live, so that the next change is not drift', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const name = stepOf(await planFor(fixture, cloudflare), 'orders').deployedName
    const live = cloudflare.workers![name]
    const left = 'left-by-a-crash'
    live.tags![left] = live.tags![live.active[0][0]]
    live.active = [[left, 100]]
    const plan = await planFor(fixture, cloudflare)
    expect(stepOf(plan, 'orders')).toMatchObject({action: 'skip', previousVersionId: left, recordState: true})

    const result = await applyPlan(fixture, cloudflare, {noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(manifestOf(fixture).workers.orders.versionId).toBe(left)
    expect(stepOf(await planFor(fixture, cloudflare, {rules: newCode('orders')}), 'orders').reasons).not.toContain('drift')
  })

  it('applies the triggers of what it adopts', async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
    const cloudflare = await firstRun(fixture)
    rmSync(join(fixture.root, 'state', 'staging', 'manifest.json'))
    await planFor(fixture, cloudflare)

    const result = await applyPlan(fixture, cloudflare)

    expect(writesOf(result.calls)).toEqual(['triggers reports'])
  })
})

describe('apply, and accounts', () => {
  const ACCOUNT = 'ffff0000000000000000000000005678'
  const withOwnAccount = {account_id: ACCOUNT}

  it("sends every write and read of a worker to that worker's account", async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'billing', withOwnAccount)
    await planFor(fixture, {}, {flags: ['--first-run']})
    const created = await applyPlan(fixture, {})
    const other = '00000000000000000000000000000000'
    expect(accountOfCall(callsOf(created.calls, 'deploy billing')[0])).toBe(ACCOUNT)
    expect(accountOfCall(callsOf(created.calls, 'deploy orders')[0])).toBe(other)

    const plan = await planFor(fixture, created.cloudflare!, {rules: newCode('billing')})
    const result = await applyPlan(fixture, created.cloudflare!)

    expect(accountOfCall(callsOf(result.calls, 'upload billing')[0])).toBe(ACCOUNT)
    expect(accountOfCall(callsOf(result.calls, 'promote billing')[0])).toBe(ACCOUNT)
    const reads = result.calls.filter(({argv}) => argv.includes(stepOf(plan, 'billing').deployedName))
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((call) => accountOfCall(call) === ACCOUNT)).toBe(true)
  })

  it('stores a hash of the account on each entry, and never the ID', async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'billing', withOwnAccount)

    await firstRun(fixture)

    expect(manifestOf(fixture).workers.billing.accountHash).toBe(createHash('sha256').update(ACCOUNT).digest('hex'))
    expect(readFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), 'utf8')).not.toContain(ACCOUNT)
  })

  it('keeps the stored hash when the account can no longer be determined (WP6-13)', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const {accountHash} = manifestOf(fixture).workers.billing
    expect(accountHash).toBeDefined()
    const env = {CLOUDFLARE_ACCOUNT_ID: ''}
    await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json'], {cloudflare, env, rules: newCode('billing')})

    const result = await applyPlan(fixture, cloudflare, {env})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toContain('promote billing')
    expect(manifestOf(fixture).workers.billing.accountHash).toBe(accountHash)
  })

  it("lets a real CLOUDFLARE_ACCOUNT_ID beat a worker's .env, under either name (WP6-14)", async () => {
    const fixture = deployFixture()
    writeFileSync(join(fixture.worker('billing'), '.env'), `CF_ACCOUNT_ID=${ACCOUNT}\n`)
    writeFileSync(join(fixture.worker('orders'), '.env'), `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`)
    writeFileSync(join(fixture.root, '.git', 'info', 'exclude'), 'state\nplan.json\n.env\n')
    const real = '11110000000000000000000000002222'

    await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json', '--first-run'], {cloudflare: {}, env: {CLOUDFLARE_ACCOUNT_ID: real}})
    const result = await applyPlan(fixture, {}, {env: {CLOUDFLARE_ACCOUNT_ID: real}})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(accountOfCall(callsOf(result.calls, 'deploy billing')[0])).toBe(real)
    expect(accountOfCall(callsOf(result.calls, 'deploy orders')[0])).toBe(real)
    expect(manifestOf(fixture).workers.billing.accountHash).toBe(createHash('sha256').update(real).digest('hex'))
  })

  it("takes a worker's .env when the real environment has no account, CLOUDFLARE_ACCOUNT_ID first (WP6-14)", async () => {
    const fixture = deployFixture()
    const other = 'ffff0000000000000000000000009999'
    writeFileSync(join(fixture.worker('billing'), '.env'), `CF_ACCOUNT_ID=${other}\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`)
    writeFileSync(join(fixture.root, '.git', 'info', 'exclude'), 'state\nplan.json\n.env\n')

    await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json', '--first-run'], {cloudflare: {}, env: {CLOUDFLARE_ACCOUNT_ID: ''}})
    const result = await applyPlan(fixture, {}, {env: {CLOUDFLARE_ACCOUNT_ID: ''}})

    expect(accountOfCall(callsOf(result.calls, 'deploy billing')[0])).toBe(ACCOUNT)
  })

  it('reads a padded account as the account, not as another one (WP6-19)', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const {accountHash} = manifestOf(fixture).workers.billing
    const env = {CLOUDFLARE_ACCOUNT_ID: '  00000000000000000000000000000000 '}

    const planned = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json'], {cloudflare, env, rules: newCode('billing')})

    expect(planned.exitCode, planned.stderr).toBe(0)
    const result = await applyPlan(fixture, cloudflare, {env})
    expect(accountOfCall(callsOf(result.calls, 'promote billing')[0])).toBe('00000000000000000000000000000000')
    expect(manifestOf(fixture).workers.billing.accountHash).toBe(accountHash)
  })

  it('has the next plan refuse the state, once the account has changed', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const other = 'eeee0000000000000000000000001111'

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json'], {cloudflare, env: {CLOUDFLARE_ACCOUNT_ID: other}})

    expect(result.exitCode).toBe(3)
    expect(readPlan(fixture).applicable).toBe(false)
  })
})

describe('apply, refusing a stale plan', () => {
  it('without a readable plan', async () => {
    const fixture = await planned()
    rmSync(join(fixture.root, 'plan.json'))
    await refuses(fixture, /Can't read the plan/)
  })

  it('without valid JSON', async () => {
    const fixture = await planned()
    writeFileSync(join(fixture.root, 'plan.json'), '{')
    await refuses(fixture, /not valid JSON/)
  })

  it('with another schema version', async () => {
    const fixture = await planned()
    writePlan(fixture, {schemaVersion: 99})
    await refuses(fixture, /schema version 99/)
  })

  it('marked as not applicable', async () => {
    const fixture = await planned()
    writePlan(fixture, {applicable: false})
    await refuses(fixture, /not applicable/)
  })

  it('that was refused', async () => {
    const fixture = await planned()
    writePlan(fixture, {applicable: false, refused: 'wrong account'})
    await refuses(fixture, /wrong account/)
  })

  it('for another commit', async () => {
    const fixture = await planned()
    commitAll(fixture)
    await refuses(fixture, /Plan on this commit/)
  })

  it('for another commit, whatever CI says is checked out', async () => {
    const fixture = await planned()
    const {commit} = readPlan(fixture)
    commitAll(fixture)
    await refuses(fixture, /Plan on this commit/, [], {GITHUB_SHA: commit})
  })

  it('with no commit to go on', async () => {
    const fixture = await planned()
    writePlan(fixture, {commit: 'unknown'})
    await refuses(fixture, /Plan on this commit/)
  })

  it('from another wrangler', async () => {
    const fixture = await planned()
    writePlan(fixture, {wrangler: '4.0.0'})
    await refuses(fixture, /wrangler 4\.0\.0/)
  })

  it('when the branch has moved on', async () => {
    const fixture = await planned()
    const {commit} = readPlan(fixture)
    const newer = commitAll(fixture)
    writePlan(fixture, {commit: newer})
    expect(newer).not.toBe(commit)
    await refuses(fixture, /newer commit/, ['--expect-branch-tip', commit])
  })

  it('when the branch tip resolves to nothing', async () => {
    const fixture = await planned()
    await refuses(fixture, /doesn't resolve/, ['--expect-branch-tip', 'no-such-branch'])
  })

  it('with a worker this checkout deploys under another name', async () => {
    const fixture = await planned()
    const plan = readPlan(fixture)
    writePlan(fixture, {steps: plan.steps.map((step: {deployedName: string}) => ({...step, deployedName: `other-${step.deployedName}`}))})
    await refuses(fixture, /Plan again/)
  })

  it('with a worker this checkout does not have', async () => {
    const fixture = await planned()
    const plan = readPlan(fixture)
    writePlan(fixture, {steps: [{...plan.steps[0], worker: 'nothing-here'}]})
    await refuses(fixture, /nothing-here/)
  })

  it('and takes one whose branch tip is its commit', async () => {
    const fixture = await planned()
    const {commit} = readPlan(fixture)

    const result = await applyPlan(fixture, {}, {flags: ['--expect-branch-tip', commit]})

    expect(result.exitCode, result.stderr).toBe(0)
  })
})

describe('apply, and its summary file', () => {
  it('adds to the file, creating its folder', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})
    const path = join('out', 'summary.md')
    // A summary kept in the checkout has to be ignored by git, or the next apply refuses it as a change.
    appendFileSync(join(fixture.root, '.git', 'info', 'exclude'), 'out\nexisting.md\n')
    writeFileSync(join(fixture.root, 'existing.md'), 'before\n')

    const first = await applyPlan(fixture, cloudflare, {flags: ['--summary-file', path]})
    await applyPlan(fixture, first.cloudflare!, {flags: ['--summary-file', 'existing.md'], noCalls: true})

    const summary = readFileSync(join(fixture.root, path), 'utf8')
    expect(summary).toContain('| billing | upload | ok |')
    expect(summary).toContain('| reports | skip | unchanged |')
    expect(readFileSync(join(fixture.root, 'existing.md'), 'utf8').startsWith('before\n## monocf apply')).toBe(true)
  })

  it('only warns when it cannot write the file', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare)
    appendFileSync(join(fixture.root, '.git', 'info', 'exclude'), 'taken\n')
    writeFileSync(join(fixture.root, 'taken'), '')

    const result = await applyPlan(fixture, cloudflare, {flags: ['--summary-file', join('taken', 'summary.md')], noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('Could not write the summary file')
  })
})

describe('apply, when the state store fails', () => {
  it('exits 1 and says so, as what was deployed is no longer recorded', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const plan = await planFor(fixture, cloudflare, {rules: newCode('billing')})
    const manifest = readFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), 'utf8')
    const remote = {...cloudflare, buckets: {'state-bucket': {'staging/manifest.json': manifest}}}
    const planned = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'r2://state-bucket', '--out', 'plan.json'], {cloudflare: remote, rules: newCode('billing')})
    expect(planned.exitCode, planned.stderr).toBe(0)

    const result = await applyPlan(fixture, remote, {rules: [{command: 'r2 object put', exitCode: 1, stderr: 'no\n'}]})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('State was not written')
    expect(result.stderr).toContain('The run record was not written')
    expect(activeOf(result.cloudflare, stepOf(plan, 'billing'))).not.toBe(manifestOf(fixture).workers.billing.versionId)
    expect(existsSync(join(fixture.root, 'state', 'staging', 'manifest.json'))).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('apply, on a signal', () => {
  it('stops starting, records what it did, and keeps the exit code', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const planned = await planFor(fixture, cloudflare, {rules: newCode('billing', 'orders')})

    const running = startCli(fixture, ['apply', 'plan.json'], {cloudflare, rules: [{command: 'versions deploy', holdMs: 20_000, worker: 'billing'}]})
    const seen = await running.waitForCalls(3)
    expect(writesOf(seen).at(-1)).toBe('promote billing')
    running.child.kill('SIGTERM')
    const result = await running.done

    expect(result.exitCode).toBe(143)
    expect(writesOf(result.calls)).not.toContain('promote orders')
    const {workers} = lastRunRecord(fixture)
    expect(workers.billing.uploadedVersionId).toBeDefined()
    expect(workers.orders.uploadedVersionId).toBeDefined()
    expect(result.stderr).toMatch(/Uploaded and not promoted: .*orders/)
    expect(stepOf(planned, 'orders').action).toBe('upload')
    const next = await planFor(fixture, result.cloudflare!, {rules: newCode('billing', 'orders')})
    expect(actionsOf(next).orders).toBe('upload')
  })
})
