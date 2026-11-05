import {readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {actionsOf, activeOf, applyPlan, callsOf, changeConfig, commitAll, deployFixture, firstRun, lastRunRecord, manifestOf, newCode, planFor, stepOf, waitForWrite, writesOf} from '../helpers/deploy-fixtures.js'
import {runCli, startCli, type FakeCloudflare, type Fixture, type RunOptions, type WranglerRule} from '../helpers/harness.js'

const rollback = (fixture: Fixture, runId: string, cloudflare: FakeCloudflare, {flags = [], ...options}: RunOptions & {flags?: string[]} = {}) =>
  runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', runId, ...flags], {cloudflare, ...options})

const partly: WranglerRule = {
  command: 'deploy',
  effectThenFail: true,
  exitCode: 1,
  failMessage: 'Trigger configuration was only partially updated',
  stderr: '✘ [ERROR] Trigger configuration was only partially updated\n',
  worker: 'reports',
}

/** reports has a site, so its new code takes a deploy. */
async function aboutToDeploy() {
  const fixture = deployFixture({workers: [{config: {site: {bucket: './site'}}, name: 'reports'}]})
  const cloudflare = await firstRun(fixture)
  const old = structuredClone(manifestOf(fixture).workers.reports)
  const plan = await planFor(fixture, cloudflare, {rules: newCode('reports')})
  const step = stepOf(plan, 'reports')
  expect(step.action).toBe('full-deploy')
  return {cloudflare, fixture, name: step.deployedName as string, old, step}
}

describe('a step that changed what is live, and then failed (WP6-6)', () => {
  it('records what is live, and the next plan under fail does not read it as drift', async () => {
    const {cloudflare, fixture, name, old, step} = await aboutToDeploy()

    const result = await applyPlan(fixture, cloudflare, {rules: [partly]})

    expect(result.exitCode).toBe(1)
    const live = activeOf(result.cloudflare, step)
    expect(live).not.toBe(old.versionId)
    expect(lastRunRecord(fixture).workers.reports).toMatchObject({changed: true, newVersionId: live, result: 'failed'})
    expect(manifestOf(fixture).workers.reports).toMatchObject({fingerprint: step.fingerprint, triggersHash: 'not-applied', versionId: live})
    expect(result.cloudflare!.workers![name].active[0][0]).toBe(live)

    const next = await planFor(fixture, result.cloudflare!, {flags: ['--on-drift', 'fail'], rules: newCode('reports')})
    expect(stepOf(next, 'reports')).toMatchObject({action: 'triggers', reasons: ['triggers-changed']})
  })

  it('lets rollback put it back, rather than say no workers', async () => {
    const {cloudflare, fixture, old, step} = await aboutToDeploy()
    const failed = await applyPlan(fixture, cloudflare, {rules: [partly]})
    const {runId} = lastRunRecord(fixture)

    const result = await rollback(fixture, runId, failed.cloudflare!)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).not.toContain('no workers')
    // The triggers too, as the deploy may have got as far as changing them.
    expect(writesOf(result.calls)).toEqual(['promote reports', 'triggers reports'])
    expect(activeOf(result.cloudflare, step)).toBe(old.versionId)
    expect(manifestOf(fixture).workers.reports).toMatchObject({fingerprint: old.fingerprint, versionId: old.versionId})
  })

  it('records unknown when what is live cannot be read, and rollback treats that as changed', async () => {
    const {cloudflare, fixture, old, step} = await aboutToDeploy()
    const unreadable: WranglerRule = {command: 'deployments status', exitCode: 1, skip: 1, stderr: '✘ [ERROR] Something broke\n', worker: step.deployedName}

    const failed = await applyPlan(fixture, cloudflare, {rules: [partly, unreadable]})

    expect(failed.exitCode).toBe(1)
    expect(lastRunRecord(fixture).workers.reports.changed).toBe('unknown')
    expect(failed.stderr).toMatch(/reports may have changed what is live.*Rollback treats each as changed/)

    const dry = await rollback(fixture, lastRunRecord(fixture).runId, failed.cloudflare!, {flags: ['--dry-run'], noCalls: true})
    expect(dry.stderr).toContain(`versions deploy ${old.versionId}@100%`)

    const result = await rollback(fixture, lastRunRecord(fixture).runId, failed.cloudflare!)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(activeOf(result.cloudflare, step)).toBe(old.versionId)
  })

  it('records that nothing changed when a failed step had no effect, and rollback only checks', async () => {
    const {cloudflare, fixture, old, step} = await aboutToDeploy()
    const failed = await applyPlan(fixture, cloudflare, {rules: [{...partly, effectThenFail: false}]})
    expect(lastRunRecord(fixture).workers.reports).toMatchObject({changed: false, result: 'failed'})

    const result = await rollback(fixture, lastRunRecord(fixture).runId, failed.cloudflare!)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual([])
    expect(result.stderr).toContain('Already live, nothing to restore.')
    expect(activeOf(result.cloudflare, step)).toBe(old.versionId)
  })

  it('exits 1 when a failed run left a worker alone and something else has since replaced it', async () => {
    const {cloudflare, fixture, name, step} = await aboutToDeploy()
    const failed = await applyPlan(fixture, cloudflare, {rules: [{...partly, effectThenFail: false}]})
    const worker = failed.cloudflare!.workers![name]
    worker.tags!['someone-else'] = null
    worker.active = [['someone-else', 100]]

    const result = await rollback(fixture, lastRunRecord(fixture).runId, failed.cloudflare!)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("isn't live any more")
    expect(activeOf(result.cloudflare, step)).toBe('someone-else')
  })

  it('treats a failed triggers step as changed, and restores the triggers', async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
    const cloudflare = await firstRun(fixture)
    const path = join(fixture.root, 'state', 'staging', 'manifest.json')
    const manifest = manifestOf(fixture)
    manifest.workers.reports = {...manifest.workers.reports, triggers: {...manifest.workers.reports.triggers, crons: ['0 9 * * *']}, triggersHash: 'earlier'}
    writeFileSync(path, JSON.stringify(manifest))
    expect(stepOf(await planFor(fixture, cloudflare), 'reports').action).toBe('triggers')
    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'triggers deploy', effectThenFail: true, exitCode: 1, stderr: 'partly\n', worker: 'reports'}]})
    expect(lastRunRecord(fixture).workers.reports).toMatchObject({changed: 'unknown', result: 'failed'})

    const result = await rollback(fixture, lastRunRecord(fixture).runId, failed.cloudflare!)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual(['triggers reports'])
    expect(callsOf(result.calls, 'triggers reports')[0].config?.triggers?.crons).toEqual(['0 9 * * *'])
  })

  it('refuses rather than report success for a failed adopt, whose triggers nothing recorded', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    rmSync(join(fixture.root, 'state', 'staging', 'manifest.json'))
    await planFor(fixture, cloudflare)
    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'triggers deploy', exitCode: 1, stderr: 'no\n', worker: 'reports'}]})
    expect(lastRunRecord(fixture).workers.reports.changed).toBe('unknown')

    const result = await rollback(fixture, lastRunRecord(fixture).runId, failed.cloudflare!, {noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Check them by hand')
  })

  it.skipIf(process.platform === 'win32')('names what really happened on a signal, whatever the attempt said', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})
    const running = startCli(fixture, ['apply', 'plan.json'], {cloudflare, rules: [{command: 'versions deploy', holdMs: 3000, ignoreSignals: true, worker: 'billing'}]})
    await waitForWrite(running, 'promote billing')
    running.child.kill('SIGTERM')

    const result = await running.done

    const record = lastRunRecord(fixture).workers.billing
    expect(result.exitCode).toBe(143)
    expect(record).toMatchObject({changed: true, result: 'cancelled'})
    expect(record.newVersionId).toBe(result.cloudflare!.workers![stepOf(JSON.parse(readFileSync(join(fixture.root, 'plan.json'), 'utf8')), 'billing').deployedName].active[0][0])
    expect(result.stderr).not.toContain('Uploaded and not promoted: billing')
  })
})

describe('rollback to a version the state entry does not describe (WP6-4)', () => {
  it('records an unknown entry for a manual hotfix it restores, so the next plan looks again', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const name = stepOf(await planFor(fixture, cloudflare), 'reports').deployedName
    const worker = cloudflare.workers![name]
    worker.tags!['manual-hotfix'] = null
    worker.active = [['manual-hotfix', 100]]
    await planFor(fixture, cloudflare)
    const applied = await applyPlan(fixture, cloudflare)
    expect(applied.exitCode, applied.stderr).toBe(0)

    const result = await rollback(fixture, lastRunRecord(fixture).runId, applied.cloudflare!, {flags: ['--force']})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.cloudflare!.workers![name].active[0][0]).toBe('manual-hotfix')
    expect(manifestOf(fixture).workers.reports).toMatchObject({fingerprint: 'unknown-after-rollback', versionId: 'manual-hotfix'})
    expect(actionsOf(await planFor(fixture, result.cloudflare!, {flags: ['--on-drift', 'fail']})).reports).toBe('upload')
  })

  it('records an unknown entry for a version a crash left, which the old entry has no word on', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const name = stepOf(await planFor(fixture, cloudflare), 'reports').deployedName
    const worker = cloudflare.workers![name]
    worker.tags!['crashed-f2'] = 'monocf:f2'
    worker.active = [['crashed-f2', 100]]
    await planFor(fixture, cloudflare, {flags: ['--on-drift', 'warn'], rules: newCode('reports')})
    const applied = await applyPlan(fixture, cloudflare)
    expect(applied.exitCode, applied.stderr).toBe(0)

    const result = await rollback(fixture, lastRunRecord(fixture).runId, applied.cloudflare!, {flags: ['--force']})

    expect(result.cloudflare!.workers![name].active[0][0]).toBe('crashed-f2')
    expect(manifestOf(fixture).workers.reports.fingerprint).toBe('unknown-after-rollback')
    expect(actionsOf(await planFor(fixture, result.cloudflare!)).reports).toBe('upload')
  })

  it('still writes the known entry when the version is the one the entry names', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const old = structuredClone(manifestOf(fixture).workers.reports)
    await planFor(fixture, cloudflare, {rules: newCode('reports')})
    const applied = await applyPlan(fixture, cloudflare)

    const result = await rollback(fixture, lastRunRecord(fixture).runId, applied.cloudflare!)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(manifestOf(fixture).workers.reports).toMatchObject({fingerprint: old.fingerprint, versionId: old.versionId})
  })
})

/** A failed run: billing went through, and reports failed with nothing changed. */
async function failedWithReportsUntouched() {
  const fixture = deployFixture({workers: [{name: 'billing'}, {config: {site: {bucket: './site'}}, name: 'reports'}]})
  const cloudflare = await firstRun(fixture)
  const old = structuredClone(manifestOf(fixture).workers)
  const plan = await planFor(fixture, cloudflare, {rules: newCode('billing', 'reports')})
  const failed = await applyPlan(fixture, cloudflare, {rules: [{...partly, effectThenFail: false}]})
  expect(failed.exitCode).toBe(1)
  const record = lastRunRecord(fixture)
  expect(record.workers.reports).toMatchObject({changed: false, result: 'failed'})
  expect(record.workers.billing).toMatchObject({changed: true, result: 'ok'})
  return {cloudflare: failed.cloudflare!, fixture, old, plan, runId: record.runId as string}
}

describe('a worker in a failed run that has left the checkout (R6)', () => {
  it('skips one the run left unchanged, says so, and restores the rest', async () => {
    const {cloudflare, fixture, old, plan, runId} = await failedWithReportsUntouched()
    rmSync(fixture.worker('reports'), {force: true, recursive: true})

    const result = await rollback(fixture, runId, cloudflare)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain("reports: This run didn't change it, and this checkout has no such worker")
    expect(writesOf(result.calls)).toEqual(['promote billing'])
    expect(activeOf(result.cloudflare, stepOf(plan, 'billing'))).toBe(old.billing.versionId)
    expect(lastRunRecord(fixture).workers.reports.result).toBe('skipped')
  })

  it('still stops for one the run may have changed, as nothing could put it back', async () => {
    const {cloudflare, fixture, runId} = await failedWithReportsUntouched()
    rmSync(fixture.worker('billing'), {force: true, recursive: true})

    const result = await rollback(fixture, runId, cloudflare, {noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('billing is in the run record, and this checkout has no such worker')
    expect(writesOf(result.calls)).toEqual([])
  })
})

/** billing was gone, and this run created it and gave orders a new version to reach it. */
async function recreatedAndApplied() {
  const fixture = deployFixture()
  const cloudflare = await firstRun(fixture)
  const plan = await planFor(fixture, cloudflare)
  const provider = stepOf(plan, 'billing').deployedName
  const {[provider]: gone, ...rest} = cloudflare.workers!
  expect(gone).toBeDefined()
  const without = {...cloudflare, workers: rest}
  const next = await planFor(fixture, without, {flags: ['--allow-recreate']})
  expect(stepOf(next, 'orders').reasons).toContain('provider-recreated')
  const applied = await applyPlan(fixture, without)
  expect(applied.exitCode, applied.stderr).toBe(0)
  expect(manifestOf(fixture).needsNewVersion).toBeUndefined()
  return {cloudflare: applied.cloudflare!, fixture, runId: lastRunRecord(fixture).runId as string, step: stepOf(next, 'orders')}
}

describe('rollback across a recreated provider (WP6-5)', () => {
  it('refuses without --force, says why and what next, and changes nothing', async () => {
    const {cloudflare, fixture, runId, step} = await recreatedAndApplied()
    const live = activeOf(cloudflare, step)

    const result = await rollback(fixture, runId, cloudflare, {noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/orders: this run recreated billing.*can't reach.*--force.*next plan gives it a new version/)
    expect(writesOf(result.calls)).not.toContain('promote orders')
    expect(activeOf(result.cloudflare, step)).toBe(live)
    expect(manifestOf(fixture).needsNewVersion).toBeUndefined()
    expect(lastRunRecord(fixture).workers.orders.result).toBe('refused')
  })

  it('says so on a dry run too', async () => {
    const {cloudflare, fixture, runId} = await recreatedAndApplied()

    const result = await rollback(fixture, runId, cloudflare, {flags: ['--dry-run'], noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/would refuse: orders: this run recreated billing/)
  })

  it('with --force puts the marker back, so the next plan gives the caller a new version', async () => {
    const {cloudflare, fixture, runId, step} = await recreatedAndApplied()

    const result = await rollback(fixture, runId, cloudflare, {flags: ['--force']})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(activeOf(result.cloudflare, step)).toBe(step.previousVersionId)
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])
    expect(result.stderr).toContain('The next plan gives it a new version.')
    expect(stepOf(await planFor(fixture, result.cloudflare!), 'orders')).toMatchObject({action: 'upload', reasons: expect.arrayContaining(['provider-recreated'])})
  })

  it('puts the marker back for a caller healed in a later run, whose provider this run did not create', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const provider = stepOf(await planFor(fixture, cloudflare), 'billing').deployedName
    const {[provider]: gone, ...rest} = cloudflare.workers!
    expect(gone).toBeDefined()
    await planFor(fixture, {...cloudflare, workers: rest}, {flags: ['--allow-recreate']})
    const first = await applyPlan(fixture, {...cloudflare, workers: rest}, {rules: [{command: 'versions upload', exitCode: 1, worker: 'orders'}]})
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])
    const plan = await planFor(fixture, first.cloudflare!)
    expect(stepOf(plan, 'orders').reasons).toContain('provider-recreated')
    const healed = await applyPlan(fixture, first.cloudflare!)
    expect(manifestOf(fixture).needsNewVersion).toBeUndefined()

    const result = await rollback(fixture, lastRunRecord(fixture).runId, healed.cloudflare!)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])
  })
})

/** billing's new code is live, and its rollback is about to go wrong. */
async function aboutToRollBack() {
  const fixture = deployFixture({workers: [{name: 'billing'}]})
  const cloudflare = await firstRun(fixture)
  const old = structuredClone(manifestOf(fixture).workers.billing)
  const plan = await planFor(fixture, cloudflare, {rules: newCode('billing')})
  const applied = await applyPlan(fixture, cloudflare)
  expect(applied.exitCode, applied.stderr).toBe(0)
  const step = stepOf(plan, 'billing')
  return {cloudflare: applied.cloudflare!, fixture, later: activeOf(applied.cloudflare, step), old, runId: lastRunRecord(fixture).runId as string, step}
}

describe('a rollback that fails (reads what is live, as apply does)', () => {
  const noPromote: WranglerRule = {command: 'versions deploy', exitCode: 1, stderr: '✘ [ERROR] Something broke\n'}
  const unreadable = (step: {deployedName: string}): WranglerRule => ({command: 'deployments status', exitCode: 1, skip: 1, stderr: '✘ [ERROR] Something broke\n', worker: step.deployedName})

  it('says nothing changed when nothing did, and a later rollback only checks', async () => {
    const {cloudflare, fixture, later, runId, step} = await aboutToRollBack()

    const result = await rollback(fixture, runId, cloudflare, {rules: [noPromote]})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toContain('may have changed what is live')
    expect(lastRunRecord(fixture).workers.billing).toMatchObject({changed: false, previousVersionId: later, result: 'failed'})
    expect(activeOf(result.cloudflare, step)).toBe(later)

    const again = await rollback(fixture, lastRunRecord(fixture).runId, result.cloudflare!)
    expect(again.exitCode, again.stderr).toBe(0)
    expect(writesOf(again.calls)).toEqual([])
  })

  it('says what it restored when the restore took effect and then failed', async () => {
    const {cloudflare, fixture, old, runId, step} = await aboutToRollBack()

    const result = await rollback(fixture, runId, cloudflare, {rules: [{...noPromote, effectThenFail: true}]})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toContain('may have changed what is live')
    expect(activeOf(result.cloudflare, step)).toBe(old.versionId)
    expect(lastRunRecord(fixture).workers.billing).toMatchObject({changed: true, newVersionId: old.versionId, result: 'failed'})
  })

  it('stays unknown when what is live cannot be read, and a later rollback treats that as changed', async () => {
    const {cloudflare, fixture, later, old, runId, step} = await aboutToRollBack()

    const result = await rollback(fixture, runId, cloudflare, {rules: [{...noPromote, effectThenFail: true}, unreadable(step)]})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('billing may have changed what is live')
    expect(lastRunRecord(fixture).workers.billing).toMatchObject({changed: 'unknown', result: 'failed'})
    expect(activeOf(result.cloudflare, step)).toBe(old.versionId)

    const undone = await rollback(fixture, lastRunRecord(fixture).runId, result.cloudflare!)
    expect(undone.exitCode, undone.stderr).toBe(0)
    expect(writesOf(undone.calls)).toEqual(['promote billing'])
    expect(activeOf(undone.cloudflare, step)).toBe(later)
  })

  it('stays unknown when something else is live by then', async () => {
    const {cloudflare, fixture, runId, step} = await aboutToRollBack()

    const result = await rollback(fixture, runId, cloudflare, {
      rules: [{command: 'versions deploy', exitCode: 1, otherDeploy: 'someone-else', stderr: '✘ [ERROR] Something broke\n'}],
    })

    expect(result.exitCode).toBe(1)
    expect(activeOf(result.cloudflare, step)).toBe('someone-else')
    expect(lastRunRecord(fixture).workers.billing.changed).toBe('unknown')
  })

  it('keeps unknown for a failed triggers restore, which cannot be read back', async () => {
    const fixture = deployFixture({workers: [{name: 'reports'}]})
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
    const cloudflare = await firstRun(fixture)
    changeConfig(fixture, 'reports', {triggers: {crons: ['0 2 * * *']}})
    await planFor(fixture, cloudflare)
    const applied = await applyPlan(fixture, cloudflare)

    const result = await rollback(fixture, lastRunRecord(fixture).runId, applied.cloudflare!, {rules: [{command: 'triggers deploy', exitCode: 1, stderr: 'no\n'}]})

    expect(result.exitCode).toBe(1)
    expect(lastRunRecord(fixture).workers.reports.changed).toBe('unknown')
  })
})

describe('rollback across a recreated provider, of a caller with its own full-deploy (R4)', () => {
  const withDo = {
    durable_objects: {bindings: [{class_name: 'Counter', name: 'COUNTER'}]},
    env: {staging: {services: [{binding: 'BILLING', service: 'billing'}]}},
    migrations: [{new_sqlite_classes: ['Counter'], tag: 'v1'}],
  }

  /** orders gets a Durable Object in the same run that recreates billing, which it calls. */
  async function recreatedWithClassChange() {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const old = structuredClone(manifestOf(fixture).workers.orders)
    const provider = stepOf(await planFor(fixture, cloudflare), 'billing').deployedName
    const original = readFileSync(join(fixture.worker('orders'), 'wrangler.jsonc'), 'utf8')
    changeConfig(fixture, 'orders', withDo)
    const {[provider]: gone, ...rest} = cloudflare.workers!
    expect(gone).toBeDefined()
    const without = {...cloudflare, workers: rest}
    const plan = await planFor(fixture, without, {flags: ['--allow-recreate']})
    const applied = await applyPlan(fixture, without)
    expect(applied.exitCode, applied.stderr).toBe(0)
    return {cloudflare: applied.cloudflare!, fixture, old, original, runId: lastRunRecord(fixture).runId as string, step: stepOf(plan, 'orders')}
  }

  it('gives the step both reasons', async () => {
    const {step} = await recreatedWithClassChange()

    expect(step).toMatchObject({action: 'full-deploy', reasons: ['do-changed', 'provider-recreated']})
  })

  it('names the recreated provider when it refuses', async () => {
    const {cloudflare, fixture, runId, step} = await recreatedWithClassChange()

    const result = await rollback(fixture, runId, cloudflare, {noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/this run recreated billing/)
    expect(activeOf(result.cloudflare, step)).toBe(activeOf(cloudflare, step))
  })

  it('after a forced rollback and a revert, the next plan still gives the caller a new version, and that heals it', async () => {
    const {cloudflare, fixture, old, original, runId, step} = await recreatedWithClassChange()

    const forced = await rollback(fixture, runId, cloudflare, {flags: ['--force']})

    expect(forced.exitCode, forced.stderr).toBe(0)
    expect(activeOf(forced.cloudflare, step)).toBe(old.versionId)
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])

    writeFileSync(join(fixture.worker('orders'), 'wrangler.jsonc'), original)
    commitAll(fixture)
    const next = await planFor(fixture, forced.cloudflare!)
    expect(stepOf(next, 'orders')).toMatchObject({action: 'upload', reasons: ['provider-recreated']})

    const healed = await applyPlan(fixture, forced.cloudflare!)
    expect(healed.exitCode, healed.stderr).toBe(0)
    expect(activeOf(healed.cloudflare, step)).not.toBe(old.versionId)
    expect(manifestOf(fixture).needsNewVersion).toBeUndefined()
    expect(actionsOf(await planFor(fixture, healed.cloudflare!)).orders).toBe('skip')
  })
})

describe('rollback across an added route (WP6-15)', () => {
  const routes = ['example.com/*']

  it('says the route stays, and the state says so too', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    changeConfig(fixture, 'reports', {routes})
    await planFor(fixture, cloudflare)
    const applied = await applyPlan(fixture, cloudflare)
    expect(applied.exitCode, applied.stderr).toBe(0)

    const result = await rollback(fixture, lastRunRecord(fixture).runId, applied.cloudflare!)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('a route that stays attached')
    expect(callsOf(result.calls, 'triggers reports')[0].config).not.toHaveProperty('routes')
    expect(manifestOf(fixture).workers.reports.triggers.routes).toEqual(routes)
    expect(lastRunRecord(fixture).workers.reports.message).toContain('Remove it by hand')

    changeConfig(fixture, 'reports', {})
    const next = await planFor(fixture, result.cloudflare!)
    expect(next.notes.map(({kind}: {kind: string}) => kind)).toContain('routes-removed')
  })
})
