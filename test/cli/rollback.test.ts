import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {
  actionsOf,
  activeOf,
  applyPlan,
  callsOf,
  changeConfig,
  deployFixture,
  firstRun,
  lastRunRecord,
  manifestOf,
  newCode,
  planFor,
  stepOf,
  writesOf,
} from '../helpers/deploy-fixtures.js'
import {flagValue, runCli, type RunOptions} from '../helpers/harness.js'

const STATE = ['-e', 'staging', '--state', 'file:state']

function rollback(fixture: ReturnType<typeof deployFixture>, args: string[], options: RunOptions = {}) {
  return runCli(fixture, ['rollback', ...STATE, ...args], options)
}

/** Everything was deployed once, and then the given workers again. */
async function deployedTwice(workers = ['billing', 'orders', 'gateway']) {
  const fixture = deployFixture()
  const cloudflare = await firstRun(fixture)
  const before = structuredClone(manifestOf(fixture).workers)
  const plan = await planFor(fixture, cloudflare, {rules: newCode(...workers)})
  const applied = await applyPlan(fixture, cloudflare)
  expect(applied.exitCode, applied.stderr).toBe(0)
  return {before, cloudflare: applied.cloudflare!, fixture, plan, runId: lastRunRecord(fixture).runId as string}
}

const refuses = async (args: string[], pattern: RegExp) => {
  const fixture = deployFixture()
  const result = await runCli(fixture, ['rollback', ...STATE, ...args], {cloudflare: {}, noCalls: true})
  expect(result.exitCode).toBe(2)
  expect(result.stderr).toMatch(pattern)
}

describe('rollback --to-run', () => {
  it('restores what the run changed, callers first', async () => {
    const {before, cloudflare, fixture, plan, runId} = await deployedTwice()

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual(['promote gateway', 'promote orders', 'promote billing'])
    expect(activeOf(result.cloudflare, stepOf(plan, 'orders'))).toBe(before.orders.versionId)
    const [promote] = callsOf(result.calls, 'promote orders')
    expect(promote.argv[2]).toBe(`${before.orders.versionId}@100%`)
    expect(flagValue(promote, '--message')).toContain(`rollback ${runId}`)
    expect(activeOf(result.cloudflare, stepOf(plan, 'reports'))).toBe(manifestOf(fixture).workers.reports.versionId)
  })

  it('leaves state saying what the earlier version was, so the next plan has nothing to do', async () => {
    const {before, cloudflare, fixture, runId} = await deployedTwice()

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare})

    expect(manifestOf(fixture).workers.orders).toMatchObject({fingerprint: before.orders.fingerprint, versionId: before.orders.versionId})
    expect(new Set(Object.values(actionsOf(await planFor(fixture, result.cloudflare!))))).toEqual(new Set(['skip']))
  })

  it('leaves a record of its own, which can undo the rollback', async () => {
    const {before, cloudflare, fixture, plan, runId} = await deployedTwice()
    const later = activeOf(cloudflare, stepOf(plan, 'orders'))

    const undone = await rollback(fixture, ['--to-run', runId], {cloudflare})

    const record = lastRunRecord(fixture)
    expect(record.kind).toBe('rollback')
    expect(record.workers.orders).toMatchObject({changed: true, newVersionId: before.orders.versionId, previous: {versionId: later}, previousVersionId: later, result: 'ok'})
    const forward = await rollback(fixture, ['--to-run', record.runId], {cloudflare: undone.cloudflare})
    expect(forward.exitCode, forward.stderr).toBe(0)
    expect(activeOf(forward.cloudflare, stepOf(plan, 'orders'))).toBe(later)
  })

  it('keeps what was live before a retried promote, so its record can still undo the rollback', async () => {
    const {before, cloudflare, fixture, plan, runId} = await deployedTwice(['billing'])
    const later = activeOf(cloudflare, stepOf(plan, 'billing'))
    const dropped = {command: 'versions deploy', effectThenFail: true, exitCode: 1, failMessage: 'fetch failed', stderr: 'fetch failed\n', times: 1}

    const undone = await rollback(fixture, ['--to-run', runId], {cloudflare, rules: [dropped]})

    // The second attempt finds the earlier version live and has nothing to promote, so the run still succeeds.
    expect(undone.exitCode, undone.stderr).toBe(0)
    expect(callsOf(undone.calls, 'promote billing')).toHaveLength(1)
    expect(activeOf(undone.cloudflare, stepOf(plan, 'billing'))).toBe(before.billing.versionId)
    expect(lastRunRecord(fixture).workers.billing).toMatchObject({changed: true, previousVersionId: later})
  })

  it('does not promote what is already active', async () => {
    const {before, cloudflare, fixture, plan, runId} = await deployedTwice(['billing'])
    cloudflare.workers![stepOf(plan, 'billing').deployedName].active = [[before.billing.versionId, 100]]

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual([])
  })

  it('reports a worker the run created, and leaves it alone', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)

    const result = await rollback(fixture, ['--to-run', lastRunRecord(fixture).runId], {cloudflare, noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual([])
    expect(result.stderr).toContain('This run created it')
  })

  it('touches nothing a run left unchanged', async () => {
    const {cloudflare, fixture, runId} = await deployedTwice(['billing'])

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare})

    expect(writesOf(result.calls)).toEqual(['promote billing'])
  })

  it('skips the callees of a caller that failed', async () => {
    const {cloudflare, fixture, runId} = await deployedTwice()

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare, rules: [{command: 'versions deploy', exitCode: 1, worker: 'orders'}]})

    expect(result.exitCode).toBe(1)
    expect(writesOf(result.calls)).toEqual(['promote gateway', 'promote orders'])
    const {workers} = lastRunRecord(fixture)
    expect(workers.orders.result).toBe('failed')
    expect(workers.billing).toMatchObject({reason: 'orders', result: 'skipped'})
  })

  it('fails on a promote that exits 0 and changes nothing', async () => {
    const {cloudflare, fixture, runId} = await deployedTwice(['billing'])

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare, rules: [{command: 'versions deploy', noEffect: true}]})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('verify-mismatch')
  })

  it('reports the code of a version Cloudflare no longer has', async () => {
    const {before, cloudflare, fixture, plan, runId} = await deployedTwice(['billing'])
    delete cloudflare.workers![stepOf(plan, 'billing').deployedName].tags![before.billing.versionId]

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('100146')
  })
})

describe('rollback, and Durable Objects', () => {
  const withDo = {
    durable_objects: {bindings: [{class_name: 'Counter', name: 'COUNTER'}]},
    env: {staging: {services: [{binding: 'BILLING', service: 'billing'}]}},
    migrations: [{new_sqlite_classes: ['Counter'], tag: 'v1'}],
  }

  async function acrossClassChange() {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const before = structuredClone(manifestOf(fixture).workers)
    changeConfig(fixture, 'orders', withDo)
    const plan = await planFor(fixture, cloudflare, {rules: newCode('billing', 'gateway')})
    expect(actionsOf(plan).orders).toBe('full-deploy')
    const applied = await applyPlan(fixture, cloudflare)
    expect(applied.exitCode, applied.stderr).toBe(0)
    return {before, cloudflare: applied.cloudflare!, fixture, plan, runId: lastRunRecord(fixture).runId as string}
  }

  it('refuses to cross a class change, and skips what that worker calls', async () => {
    const {cloudflare, fixture, runId} = await acrossClassChange()

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Durable Object')
    expect(writesOf(result.calls)).toEqual(['promote gateway'])
    const {workers} = lastRunRecord(fixture)
    expect(workers.orders.result).toBe('refused')
    expect(workers.billing).toMatchObject({reason: 'orders', result: 'skipped'})
  })

  it('crosses it with --force', async () => {
    const {before, cloudflare, fixture, plan, runId} = await acrossClassChange()

    const result = await rollback(fixture, ['--to-run', runId, '--force'], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(activeOf(result.cloudflare, stepOf(plan, 'orders'))).toBe(before.orders.versionId)
  })

  it('--dry-run says what it would refuse, exits 1 and changes nothing', async () => {
    const {cloudflare, fixture, runId} = await acrossClassChange()
    const state = readFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), 'utf8')

    const result = await rollback(fixture, ['--to-run', runId, '--dry-run'], {cloudflare, noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('would refuse')
    expect(writesOf(result.calls)).toEqual([])
    expect(readFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), 'utf8')).toBe(state)
  })

  it('refuses when the record knows nothing of the earlier version', async () => {
    const {cloudflare, fixture, runId} = await deployedTwice(['billing'])
    const path = join(fixture.root, 'state', 'staging', 'runs', `${runId}.json`)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    record.workers.billing.previous = null
    writeFileSync(path, JSON.stringify(record))

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare, noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('no Durable Object information')
    expect(writesOf(result.calls)).toEqual([])
  })
})

describe('rollback, and crons', () => {
  it('restores them, as they do not follow a version, through a config holding nothing else', async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
    const cloudflare = await firstRun(fixture)
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 2 * * *']}})
    const plan = await planFor(fixture, cloudflare)
    const applied = await applyPlan(fixture, cloudflare)
    const {runId} = lastRunRecord(fixture)

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare: applied.cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual(['promote reports', 'triggers reports'])
    const name = stepOf(plan, 'reports').deployedName
    expect(result.cloudflare!.workers![name].triggers).toEqual({crons: ['0 1 * * *']})
    const [{config}] = callsOf(result.calls, 'triggers reports')
    expect(config).toMatchObject({name, triggers: {crons: ['0 1 * * *']}})
    expect(config).not.toHaveProperty('main')
    expect(config).not.toHaveProperty('services')
  })

  it('removes crons the earlier version had none of', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 2 * * *']}})
    const plan = await planFor(fixture, cloudflare)
    const applied = await applyPlan(fixture, cloudflare)

    const result = await rollback(fixture, ['--to-run', lastRunRecord(fixture).runId], {cloudflare: applied.cloudflare})

    expect(result.cloudflare!.workers![stepOf(plan, 'reports').deployedName].triggers).toEqual({crons: []})
  })
})

/** reports' code is what the state says, and its triggers are behind, so the run only runs `triggers deploy`. */
async function triggersOnlyRun() {
  const fixture = deployFixture()
  changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
  const cloudflare = await firstRun(fixture)
  const manifest = manifestOf(fixture)
  manifest.workers.reports = {...manifest.workers.reports, triggers: {...manifest.workers.reports.triggers, crons: ['0 9 * * *']}, triggersHash: 'earlier'}
  writeFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), JSON.stringify(manifest))
  const plan = await planFor(fixture, cloudflare)
  expect(stepOf(plan, 'reports').action).toBe('triggers')
  const applied = await applyPlan(fixture, cloudflare)
  expect(applied.exitCode, applied.stderr).toBe(0)
  return {cloudflare: applied.cloudflare!, fixture, plan, runId: lastRunRecord(fixture).runId as string}
}

describe('rollback of a run that only changed triggers', () => {
  it('records what was live, though it restores no version', async () => {
    const {cloudflare, fixture, plan, runId} = await triggersOnlyRun()
    const live = activeOf(cloudflare, stepOf(plan, 'reports'))

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual(['triggers reports'])
    expect(lastRunRecord(fixture).workers.reports).toMatchObject({changed: true, previousVersionId: live, result: 'ok'})
  })

  it('can be undone by a later --to-run, which puts the triggers forward again', async () => {
    const {cloudflare, fixture, plan, runId} = await triggersOnlyRun()
    const step = stepOf(plan, 'reports')
    const live = activeOf(cloudflare, step)
    const back = await rollback(fixture, ['--to-run', runId], {cloudflare})
    expect(back.cloudflare!.workers![step.deployedName].triggers).toEqual({crons: ['0 9 * * *']})

    const forward = await rollback(fixture, ['--to-run', lastRunRecord(fixture).runId], {cloudflare: back.cloudflare})

    expect(forward.exitCode, forward.stderr).toBe(0)
    expect(writesOf(forward.calls)).toEqual(['triggers reports'])
    expect(forward.cloudflare!.workers![step.deployedName].triggers).toEqual({crons: ['0 1 * * *']})
    expect(activeOf(forward.cloudflare, step)).toBe(live)
    expect(manifestOf(fixture).workers.reports).toMatchObject({triggersHash: step.triggersHash, versionId: live})
  })
})

describe('rollback <worker> --to', () => {
  it('asks for --force, because no record can vouch for the version', async () => {
    const {before, cloudflare, fixture} = await deployedTwice(['billing'])

    const result = await rollback(fixture, ['billing', '--to', before.billing.versionId], {cloudflare, noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--force')
  })

  it('puts the version back, warns, and has the next plan upload over it', async () => {
    const {before, cloudflare, fixture, plan} = await deployedTwice(['billing'])

    const result = await rollback(fixture, ['billing', '--to', before.billing.versionId, '--force'], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain("can't be checked")
    expect(writesOf(result.calls)).toEqual(['promote billing'])
    expect(activeOf(result.cloudflare, stepOf(plan, 'billing'))).toBe(before.billing.versionId)
    const entry = manifestOf(fixture).workers.billing
    expect(entry.versionId).toBe(before.billing.versionId)
    expect(actionsOf(await planFor(fixture, result.cloudflare!)).billing).toBe('upload')
  })

  it('uploads over it even for the very code that was live before', async () => {
    const {before, cloudflare, fixture} = await deployedTwice(['billing'])

    const result = await rollback(fixture, ['billing', '--to', before.billing.versionId, '--force'], {cloudflare})

    expect(actionsOf(await planFor(fixture, result.cloudflare!, {rules: newCode('billing')})).billing).toBe('upload')
  })

  it('keeps the triggers state as it was, so that only the code comes up again', async () => {
    const {before, cloudflare, fixture} = await deployedTwice(['billing'])
    const {triggersHash} = manifestOf(fixture).workers.billing

    await rollback(fixture, ['billing', '--to', before.billing.versionId, '--force'], {cloudflare})

    expect(manifestOf(fixture).workers.billing.triggersHash).toBe(triggersHash)
  })

  it('reports the code when Cloudflare has no such version', async () => {
    const {cloudflare, fixture} = await deployedTwice(['billing'])

    const result = await rollback(fixture, ['billing', '--to', 'no-such-version', '--force'], {cloudflare})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('100146')
  })
})

describe('rollback, with what it cannot use', () => {
  it('neither form', () => refuses([], /--to-run/))

  it('both forms', () => refuses(['billing', '--to', 'a', '--to-run', 'b', '--force'], /not both/))

  it('a worker with no version', () => refuses(['billing', '--force'], /--to/))

  it('a version with no worker', () => refuses(['--to', 'a', '--force'], /--to/))

  it('a run ID that could leave its folder', () => refuses(['--to-run', '../../other'], /isn't a run ID/))

  it('a worker that does not exist', () => refuses(['nothing-here', '--to', 'a', '--force'], /nothing-here/))

  it('a run that does not exist', () => refuses(['--to-run', 'no-such-run'], /no run no-such-run/))

  it('a record that is not JSON, with exit 3', async () => {
    const {cloudflare, fixture, runId} = await deployedTwice(['billing'])
    writeFileSync(join(fixture.root, 'state', 'staging', 'runs', `${runId}.json`), '{')

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare, noCalls: true})

    expect(result.exitCode).toBe(3)
    expect(writesOf(result.calls)).toEqual([])
  })

  it('a record from a newer monocf, with exit 3', async () => {
    const {cloudflare, fixture, runId} = await deployedTwice(['billing'])
    writeFileSync(join(fixture.root, 'state', 'staging', 'runs', `${runId}.json`), JSON.stringify({env: 'staging', schemaVersion: 99, workers: {}}))

    const result = await rollback(fixture, ['--to-run', runId], {cloudflare, noCalls: true})

    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('Upgrade monocf')
  })
})
