import {existsSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {activeOf, applyPlan, changeConfig, deployFixture, firstRun, lastRunRecord, manifestOf, newCode, planFor, stepOf, writesOf} from '../helpers/deploy-fixtures.js'
import {runCli, type Fixture, type WranglerRule} from '../helpers/harness.js'

const broke = '✘ [ERROR] Something broke\n'
const unreadableAfterFirstRead = (name: string): WranglerRule => ({command: 'deployments status', exitCode: 1, skip: 1, stderr: broke, worker: name})
const readState = (fixture: Fixture) => (existsSync(join(fixture.root, 'state', 'staging', 'manifest.json')) ? manifestOf(fixture) : undefined)

describe('live moved between plan and apply', () => {
  // billing takes the upload path, and reports, with a site, a deploy.
  it.each([
    ['billing', 'upload'],
    ['reports', 'full-deploy'],
  ])('%s: the record and a rollback go back to what the run replaced, not what the plan saw (%s)', async (worker, action) => {
    const fixture = deployFixture({workers: [{name: 'billing'}, {config: {site: {bucket: './site'}}, name: 'reports'}]})
    const cloudflare = await firstRun(fixture)
    const plan = await planFor(fixture, cloudflare, {rules: newCode(worker)})
    const step = stepOf(plan, worker)
    expect(step.action).toBe(action)
    const live = cloudflare.workers![step.deployedName]
    live.tags!.moved = null
    live.active = [['moved', 100]]

    const applied = await applyPlan(fixture, cloudflare)

    expect(applied.exitCode, applied.stderr).toBe(0)
    expect(lastRunRecord(fixture).workers[worker].previousVersionId).toBe('moved')
    const rolled = await runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', lastRunRecord(fixture).runId], {cloudflare: applied.cloudflare})
    expect(rolled.exitCode, rolled.stderr).toBe(0)
    expect(activeOf(rolled.cloudflare, step)).toBe('moved')
  })
})

describe('an unknown result across a Durable Object change', () => {
  it('refuses to roll back without --force, though the state still has the old classes', async () => {
    const fixture = deployFixture({workers: [{name: 'reports'}]})
    const cloudflare = await firstRun(fixture)
    const oldDoHash = manifestOf(fixture).workers.reports.doHash
    changeConfig(fixture, 'reports', {durable_objects: {bindings: [{class_name: 'Counter', name: 'COUNTER'}]}, migrations: [{new_sqlite_classes: ['Counter'], tag: 'v1'}]})
    const plan = await planFor(fixture, cloudflare)
    const step = stepOf(plan, 'reports')
    expect(step.action).toBe('full-deploy')
    const deploy: WranglerRule = {command: 'deploy', effectThenFail: true, exitCode: 1, stderr: broke, worker: 'reports'}

    const failed = await applyPlan(fixture, cloudflare, {rules: [deploy, unreadableAfterFirstRead(step.deployedName)]})

    expect(failed.exitCode).toBe(1)
    expect(lastRunRecord(fixture).workers.reports.changed).toBe('unknown')
    expect(manifestOf(fixture).workers.reports.doHash).toBe(oldDoHash)
    const live = activeOf(failed.cloudflare, step)

    const result = await runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', lastRunRecord(fixture).runId], {cloudflare: failed.cloudflare, noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Durable Object classes differ')
    expect(writesOf(result.calls)).toEqual([])
    expect(activeOf(result.cloudflare, step)).toBe(live)
  })
})

describe('the "Uploaded and not promoted" line', () => {
  const LINE = 'Uploaded and not promoted: billing'

  it('is left out when the promote may have taken effect, as the read after it failed', async () => {
    const fixture = deployFixture({workers: [{name: 'billing'}]})
    const cloudflare = await firstRun(fixture)
    const step = stepOf(await planFor(fixture, cloudflare, {rules: newCode('billing')}), 'billing')
    const promote: WranglerRule = {command: 'versions deploy', effectThenFail: true, exitCode: 1, stderr: broke}

    const result = await applyPlan(fixture, cloudflare, {rules: [promote, unreadableAfterFirstRead(step.deployedName)]})

    expect(result.exitCode).toBe(1)
    expect(lastRunRecord(fixture).workers.billing.changed).toBe('unknown')
    expect(result.stderr).not.toContain(LINE)
    expect(result.stderr).toContain('billing may have changed what is live')
  })

  it('is there when the read says nothing moved', async () => {
    const fixture = deployFixture({workers: [{name: 'billing'}]})
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})

    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions deploy', exitCode: 1, stderr: broke}]})

    expect(result.exitCode).toBe(1)
    expect(lastRunRecord(fixture).workers.billing.changed).toBe(false)
    expect(result.stderr).toContain(LINE)
  })
})

/** reports' triggers are behind what its config says, so its step is `triggers`. */
async function aboutToApplyTriggers() {
  const fixture = deployFixture({workers: [{name: 'reports'}]})
  changeConfig(fixture, 'reports', {triggers: {crons: ['0 1 * * *']}})
  const cloudflare = await firstRun(fixture)
  const manifest = manifestOf(fixture)
  manifest.workers.reports = {...manifest.workers.reports, triggersHash: 'earlier'}
  writeFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), JSON.stringify(manifest))
  const step = stepOf(await planFor(fixture, cloudflare), 'reports')
  expect(step.action).toBe('triggers')
  return {cloudflare, fixture, step}
}

/** The state is gone and the live version carries this bundle's tag, so its step is `adopt`. */
async function aboutToAdopt() {
  const fixture = deployFixture({workers: [{name: 'reports'}]})
  const cloudflare = await firstRun(fixture)
  rmSync(join(fixture.root, 'state', 'staging', 'manifest.json'))
  const step = stepOf(await planFor(fixture, cloudflare), 'reports')
  expect(step.action).toBe('adopt')
  return {cloudflare, fixture, step}
}

describe('a step that writes no version, when live moved after the plan', () => {
  it.each([
    ['triggers', aboutToApplyTriggers],
    ['adopt', aboutToAdopt],
  ])('%s: stops with nothing written, and the state does not name the old version', async (_, setUp) => {
    const {cloudflare, fixture, step} = await setUp()
    const before = readState(fixture)
    const live = cloudflare.workers![step.deployedName]
    live.tags!.moved = null
    live.active = [['moved', 100]]

    const result = await applyPlan(fixture, cloudflare)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/moved is live now\. Plan again/)
    expect(writesOf(result.calls)).toEqual([])
    expect(readState(fixture)?.workers?.reports).toEqual(before?.workers?.reports)
    expect(lastRunRecord(fixture).workers.reports).toMatchObject({changed: false, previousVersionId: 'moved', result: 'failed'})
    expect(activeOf(result.cloudflare, step)).toBe('moved')
  })

  it.each([
    ['triggers', aboutToApplyTriggers],
    ['adopt', aboutToAdopt],
  ])('%s: goes ahead when live is what the plan read', async (_, setUp) => {
    const {cloudflare, fixture, step} = await setUp()

    const result = await applyPlan(fixture, cloudflare)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual(['triggers reports'])
    expect(manifestOf(fixture).workers.reports.versionId).toBe(step.previousVersionId)
  })
})

describe('a retried deploy, when another version went live meanwhile', () => {
  it("doesn't take that version for its own, as its tag isn't this run's", async () => {
    const fixture = deployFixture({workers: [{config: {site: {bucket: './site'}}, name: 'reports'}]})
    const cloudflare = await firstRun(fixture)
    const step = stepOf(await planFor(fixture, cloudflare, {rules: newCode('reports')}), 'reports')
    const lost: WranglerRule = {command: 'deploy', exitCode: 1, otherDeploy: 'someone-else', stderr: '✘ [ERROR] fetch failed\n', times: 1, worker: 'reports'}

    const result = await applyPlan(fixture, cloudflare, {rules: [lost]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual(['deploy reports', 'deploy reports'])
    const live = activeOf(result.cloudflare, step)
    expect(live).not.toBe('someone-else')
    expect(result.cloudflare!.workers![step.deployedName].tags![live]).toBe(`monocf:${step.fingerprint}`)
    expect(lastRunRecord(fixture).workers.reports.newVersionId).toBe(live)
    expect(manifestOf(fixture).workers.reports.versionId).toBe(live)
  })
})

const serving = (versionId: string) => JSON.stringify({versions: [{percentage: 100, version_id: versionId}]})
const statusReads = (calls: {argv: string[]}[]) => calls.filter(({argv}) => argv.join(' ').startsWith('deployments status')).length

async function promoting() {
  const fixture = deployFixture({workers: [{name: 'billing'}]})
  const cloudflare = await firstRun(fixture)
  const step = stepOf(await planFor(fixture, cloudflare, {rules: newCode('billing')}), 'billing')
  return {cloudflare, fixture, step}
}

describe('the read that verifies a promote', () => {
  it('is made again while Cloudflare still names the version the promote replaced', async () => {
    const {cloudflare, fixture, step} = await promoting()
    // The first read is what's live before the promote. The second is the one that verifies it.
    const stale: WranglerRule = {command: 'deployments status', skip: 1, stdout: serving(step.previousVersionId), times: 1, worker: step.deployedName}

    const applied = await applyPlan(fixture, cloudflare, {rules: [stale]})

    expect(applied.exitCode, applied.stderr).toBe(0)
    expect(statusReads(applied.calls)).toBe(3)
    expect(activeOf(applied.cloudflare, step)).not.toBe(step.previousVersionId)
  })

  it('fails at once when it names any other version', async () => {
    const {cloudflare, fixture, step} = await promoting()
    const other: WranglerRule = {command: 'deployments status', skip: 1, stdout: serving('someone-elses'), times: 1, worker: step.deployedName}

    const applied = await applyPlan(fixture, cloudflare, {rules: [other]})

    expect(applied.exitCode).toBe(1)
    expect(applied.stderr).toContain('verify-mismatch')
    // Before, the verify, and the read of what happened that follows any failed step: none in between.
    expect(statusReads(applied.calls)).toBe(3)
  })
})
