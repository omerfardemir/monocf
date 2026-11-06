import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {
  applyPlan,
  changeConfig,
  commitAll,
  deployFixture,
  firstRun,
  lastRunRecord,
  manifestOf,
  newCode,
  planFor,
  stepOf,
  writesOf,
} from '../helpers/deploy-fixtures.js'
import {runCli, type FakeCloudflare, type Fixture} from '../helpers/harness.js'

// Queues, Workflows and tail consumers don't inherit, so they go in the env section.
function staging(fixture: Fixture, section: Record<string, unknown>, top: Record<string, unknown> = {}): void {
  changeConfig(fixture, 'reports', {...top, env: {staging: section}})
}

const consumer = (batch: number) => ({queues: {consumers: [{max_batch_size: batch, queue: 'jobs'}]}})
const workflow = {workflows: [{binding: 'FLOW', class_name: 'Flow', name: 'nightly-flow'}]}
const tail = {tail_consumers: [{service: 'logs'}]}

/** Wrangler refuses to attach a consumer to a queue that doesn't exist. */
async function liveWithJobs(fixture: Fixture): Promise<FakeCloudflare> {
  return {...(await firstRun(fixture)), queues: ['jobs']}
}

async function applyChange(fixture: Fixture, cloudflare: FakeCloudflare, section: Record<string, unknown>, top: Record<string, unknown> = {}) {
  staging(fixture, section, top)
  const plan = await planFor(fixture, cloudflare)
  const result = await applyPlan(fixture, cloudflare)
  expect(result.exitCode, result.stderr).toBe(0)
  return {cloudflare: result.cloudflare!, name: stepOf(plan, 'reports').deployedName as string, plan, result}
}

describe('apply, with a queue consumer on a live worker', () => {
  it('attaches one that is added, updates its settings, and detaches it once removed', async () => {
    const fixture = deployFixture()
    const live = await liveWithJobs(fixture)

    const added = await applyChange(fixture, live, consumer(1))
    expect(stepOf(added.plan, 'reports')).toMatchObject({action: 'upload', triggersChanged: true})
    expect(added.cloudflare.consumers?.jobs?.[added.name]).toMatchObject({max_batch_size: 1})

    const changed = await applyChange(fixture, added.cloudflare, consumer(2))
    expect(changed.cloudflare.consumers?.jobs?.[changed.name]).toMatchObject({max_batch_size: 2})

    const removed = await applyChange(fixture, changed.cloudflare, {})
    expect(stepOf(removed.plan, 'reports')).toMatchObject({removedConsumers: ['jobs'], triggersChanged: true})
    expect(removed.cloudflare.consumers?.jobs).toEqual({})
    expect(removed.result.calls.map(({argv}) => argv.slice(0, 3).join(' '))).toContain('queues consumer remove')

    const after = await planFor(fixture, removed.cloudflare)
    expect(stepOf(after, 'reports')).toMatchObject({action: 'skip'})
  })

  it('fails the worker, and attaches nothing, when the queue does not exist', async () => {
    const fixture = deployFixture()
    const live = await firstRun(fixture)
    staging(fixture, consumer(1))
    await planFor(fixture, live)

    const result = await applyPlan(fixture, live)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Queue "jobs" does not exist.')
    expect(result.cloudflare!.consumers?.jobs).toBeUndefined()
  })

  it('leaves alone a consumer someone already detached, and still finishes', async () => {
    const fixture = deployFixture()
    const {cloudflare, name} = await applyChange(fixture, await liveWithJobs(fixture), consumer(1))
    delete cloudflare.consumers!.jobs[name]

    const removed = await applyChange(fixture, cloudflare, {})

    expect(removed.result.calls.map(({argv}) => argv.slice(0, 3).join(' '))).not.toContain('queues consumer remove')
  })

  it('detaches it from a worker that takes a full deploy too', async () => {
    const fixture = deployFixture({workers: [{config: {site: {bucket: './site'}}, name: 'reports'}]})
    const site = {site: {bucket: './site'}}
    const {cloudflare} = await applyChange(fixture, await liveWithJobs(fixture), consumer(1), site)

    const removed = await applyChange(fixture, cloudflare, {}, site)

    expect(stepOf(removed.plan, 'reports')).toMatchObject({action: 'full-deploy', removedConsumers: ['jobs']})
    expect(removed.cloudflare.consumers?.jobs).toEqual({})
  })

  it('counts one whose queue is gone as detached, as there is nothing to detach', async () => {
    const fixture = deployFixture()
    const {cloudflare} = await applyChange(fixture, await liveWithJobs(fixture), consumer(1))
    delete cloudflare.consumers!.jobs
    cloudflare.queues = []

    const removed = await applyChange(fixture, cloudflare, {})

    expect(stepOf(removed.plan, 'reports')).toMatchObject({removedConsumers: ['jobs']})
    expect(removed.result.calls.map(({argv}) => argv.slice(0, 3).join(' '))).not.toContain('queues consumer remove')
    expect(stepOf(await planFor(fixture, removed.cloudflare), 'reports')).toMatchObject({action: 'skip'})
  })

  it('fails the worker on any other failure to read the queue', async () => {
    const fixture = deployFixture()
    const {cloudflare} = await applyChange(fixture, await liveWithJobs(fixture), consumer(1))
    staging(fixture, {})
    await planFor(fixture, cloudflare)
    const stderr = '✘ [ERROR] A request to the Cloudflare API (/accounts/0123456789abcdef0123456789abcdef/queues) failed. [code: 10001]\n'

    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'queues consumer worker list', exitCode: 1, stderr}]})

    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain('The consumers of queue jobs: wrangler failed with exit code 1')
    expect(stepOf(await planFor(fixture, failed.cloudflare!), 'reports')).toMatchObject({removedConsumers: ['jobs']})
  })

  it('records a worker whose detach went through as skipped, when a worker it calls then fails', async () => {
    const fixture = deployFixture()
    const live = await liveWithJobs(fixture)
    const path = join(fixture.worker('orders'), 'wrangler.jsonc')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    changeConfig(fixture, 'orders', {...config, env: {staging: {...config.env.staging, ...consumer(1)}}})
    await planFor(fixture, live)
    const before = await applyPlan(fixture, live)
    expect(before.exitCode, before.stderr).toBe(0)
    writeFileSync(path, JSON.stringify(config))
    commitAll(fixture)
    const plan = await planFor(fixture, before.cloudflare!, {rules: newCode('billing')})
    expect(stepOf(plan, 'orders')).toMatchObject({dependsOn: ['billing'], removedConsumers: ['jobs']})

    const result = await applyPlan(fixture, before.cloudflare!, {rules: [{command: 'versions upload', exitCode: 1, stderr: 'boom\n', worker: 'billing'}]})

    expect(result.exitCode).toBe(1)
    expect(result.cloudflare!.consumers!.jobs).toEqual({})
    expect(lastRunRecord(fixture).workers.orders).toMatchObject({changed: true, result: 'skipped'})
  })

  it('puts the consumer back on rollback, when the run detached it and its promote then changed nothing', async () => {
    const fixture = deployFixture()
    const {cloudflare, name} = await applyChange(fixture, await liveWithJobs(fixture), consumer(1))
    staging(fixture, {})
    await planFor(fixture, cloudflare)
    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions deploy', exitCode: 1, stderr: 'boom\n', worker: 'reports'}]})
    expect(failed.exitCode).toBe(1)
    expect(failed.cloudflare!.consumers!.jobs).toEqual({})

    const result = await runCli(fixture, rollbackArgs(lastRunRecord(fixture).runId), {cloudflare: failed.cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(Object.keys(result.cloudflare!.consumers!.jobs)).toEqual([name])
  })

  it('has the next plan detach it, when the detach fails', async () => {
    const fixture = deployFixture()
    const {cloudflare} = await applyChange(fixture, await liveWithJobs(fixture), consumer(1))
    staging(fixture, {})
    await planFor(fixture, cloudflare)
    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'queues consumer remove', exitCode: 1, failMessage: 'outage', times: 1}]})
    expect(failed.exitCode).toBe(1)
    // The detach comes first, so its failure stops the worker before its new version goes live.
    expect(writesOf(failed.calls)).toEqual([])

    const plan = await planFor(fixture, failed.cloudflare!)
    expect(stepOf(plan, 'reports')).toMatchObject({action: 'upload', removedConsumers: ['jobs']})
    const healed = await applyPlan(fixture, failed.cloudflare!)
    expect(healed.exitCode, healed.stderr).toBe(0)
    expect(healed.cloudflare!.consumers?.jobs).toEqual({})
  })
})

/** billing consumes jobs, and then a commit, not yet made, drops it there, and adds `extra` to its config. */
async function billingConsumes(extra: Record<string, unknown> = {}) {
  const fixture = deployFixture()
  const live = await liveWithJobs(fixture)
  changeConfig(fixture, 'billing', {env: {staging: consumer(1)}})
  await planFor(fixture, live)
  const before = await applyPlan(fixture, live)
  expect(before.exitCode, before.stderr).toBe(0)
  writeFileSync(join(fixture.worker('billing'), 'wrangler.jsonc'), JSON.stringify({env: {staging: {}}, ...extra}))
  return {cloudflare: before.cloudflare!, fixture}
}

/** billing consumes jobs, and then one commit moves it to reports. */
async function moved() {
  const {cloudflare, fixture} = await billingConsumes()
  changeConfig(fixture, 'reports', {env: {staging: consumer(1)}})
  const plan = await planFor(fixture, cloudflare)
  return {cloudflare, fixture, names: {billing: stepOf(plan, 'billing').deployedName, reports: stepOf(plan, 'reports').deployedName}}
}

/** billing consumes jobs, and then one commit moves it to ledger, a worker the commit adds. */
async function movedToNewWorker(extra: Record<string, unknown> = {}) {
  const {cloudflare, fixture} = await billingConsumes(extra)
  const dir = fixture.worker('ledger')
  mkdirSync(join(dir, 'src'), {recursive: true})
  writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({env: {staging: consumer(1)}}))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'ledger', version: '1.0.0'}))
  writeFileSync(join(dir, 'src', 'index.ts'), "export default {fetch: () => new Response('ledger')}\n")
  commitAll(fixture)
  const plan = await planFor(fixture, cloudflare)
  expect(stepOf(plan, 'ledger')).toMatchObject({action: 'create'})
  return {cloudflare, fixture, names: {billing: stepOf(plan, 'billing').deployedName, ledger: stepOf(plan, 'ledger').deployedName}}
}

const rollbackArgs = (runId: string) => ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', runId]

describe('apply, moving a queue consumer to another worker in one commit', () => {
  it('detaches it from the worker that drops it before the other attaches it, so one run does it', async () => {
    const {cloudflare, fixture, names} = await moved()
    // A slow detach: one that ran beside the other worker's attach would come after it.
    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'queues consumer remove', delayMs: 3000}]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(Object.keys(result.cloudflare!.consumers!.jobs)).toEqual([names.reports])
    const next = await planFor(fixture, result.cloudflare!)
    expect(next.steps.filter(({action}: {action: string}) => action !== 'skip')).toEqual([])
  })

  it('moves it to a worker the commit creates, in one run', async () => {
    const {cloudflare, fixture, names} = await movedToNewWorker()

    const result = await applyPlan(fixture, cloudflare)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(Object.keys(result.cloudflare!.consumers!.jobs)).toEqual([names.ledger])
  })

  it('attaches it on the next run, when the attach failed after the detach', async () => {
    const {cloudflare, fixture, names} = await moved()
    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'triggers deploy', exitCode: 1, stderr: 'boom\n', worker: 'reports'}]})
    expect(failed.exitCode).toBe(1)
    expect(failed.cloudflare!.consumers!.jobs).toEqual({})

    const plan = await planFor(fixture, failed.cloudflare!)
    expect(stepOf(plan, 'billing')).toMatchObject({action: 'skip'})
    expect(stepOf(plan, 'reports')).toMatchObject({action: 'triggers'})
    const healed = await applyPlan(fixture, failed.cloudflare!)
    expect(healed.exitCode, healed.stderr).toBe(0)
    expect(Object.keys(healed.cloudflare!.consumers!.jobs)).toEqual([names.reports])
  })

  it('attaches it again, when the worker it was detached from fails and the commit is reverted', async () => {
    const {cloudflare, fixture, names} = await moved()
    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions upload', exitCode: 1, stderr: 'boom\n', worker: 'billing'}]})
    expect(failed.exitCode).toBe(1)
    expect(Object.keys(failed.cloudflare!.consumers!.jobs)).toEqual([names.reports])

    writeFileSync(join(fixture.worker('billing'), 'wrangler.jsonc'), JSON.stringify({env: {staging: consumer(1)}}))
    changeConfig(fixture, 'reports', {env: {staging: {}}})
    const plan = await planFor(fixture, failed.cloudflare!)
    expect(stepOf(plan, 'billing')).toMatchObject({action: 'triggers'})
    const reverted = await applyPlan(fixture, failed.cloudflare!)

    expect(reverted.exitCode, reverted.stderr).toBe(0)
    expect(Object.keys(reverted.cloudflare!.consumers!.jobs)).toEqual([names.billing])
  })

  it('rolls back the run that finishes the move, when an earlier run detached the consumer and then failed', async () => {
    const {cloudflare, fixture, names} = await moved()
    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions upload', exitCode: 1, stderr: 'boom\n', worker: 'billing'}]})
    expect(failed.exitCode).toBe(1)
    // The entry says what's attached.
    expect(manifestOf(fixture).workers.billing.triggers.consumers).toEqual([])
    await planFor(fixture, failed.cloudflare!)
    const finished = await applyPlan(fixture, failed.cloudflare!)
    expect(finished.exitCode, finished.stderr).toBe(0)
    const {runId} = lastRunRecord(fixture)

    const result = await runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', runId], {cloudflare: finished.cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(Object.keys(result.cloudflare!.consumers!.jobs)).toEqual([names.reports])
  })
})

describe('rollback, of a run that moved a queue consumer', () => {
  it('puts it back in one rollback, as the worker that took it lets it go before anything attaches it', async () => {
    const {cloudflare, fixture, names} = await moved()
    const applied = await applyPlan(fixture, cloudflare)
    expect(applied.exitCode, applied.stderr).toBe(0)

    // A slow detach: one that ran beside the other worker's attach would come after it.
    const result = await runCli(fixture, rollbackArgs(lastRunRecord(fixture).runId), {cloudflare: applied.cloudflare, rules: [{command: 'queues consumer remove', delayMs: 3000}]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(Object.keys(result.cloudflare!.consumers!.jobs)).toEqual([names.billing])
  })

  it('detaches it from a worker the run created, which otherwise stays, and the next run moves it again', async () => {
    const {cloudflare, fixture, names} = await movedToNewWorker()
    const applied = await applyPlan(fixture, cloudflare)
    expect(applied.exitCode, applied.stderr).toBe(0)

    const result = await runCli(fixture, rollbackArgs(lastRunRecord(fixture).runId), {cloudflare: applied.cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(Object.keys(result.cloudflare!.consumers!.jobs)).toEqual([names.billing])
    expect(result.cloudflare!.workers![names.ledger]).toBeDefined()
    expect(lastRunRecord(fixture).workers.ledger).toMatchObject({changed: true, result: 'skipped'})
    expect(lastRunRecord(fixture).workers.ledger.message).toContain('Its consumer of jobs was detached')

    const plan = await planFor(fixture, result.cloudflare!)
    expect(stepOf(plan, 'ledger')).toMatchObject({action: 'triggers'})
    const again = await applyPlan(fixture, result.cloudflare!)
    expect(again.exitCode, again.stderr).toBe(0)
    expect(Object.keys(again.cloudflare!.consumers!.jobs)).toEqual([names.ledger])
  })

  it('can itself be rolled back, when it detached a consumer and its promote then changed nothing', async () => {
    const fixture = deployFixture()
    const {cloudflare, name} = await applyChange(fixture, await liveWithJobs(fixture), consumer(1))
    const failed = await runCli(fixture, rollbackArgs(lastRunRecord(fixture).runId), {cloudflare, rules: [{command: 'versions deploy', exitCode: 1, stderr: 'boom\n', worker: 'reports'}]})
    expect(failed.exitCode).toBe(1)
    expect(failed.cloudflare!.consumers!.jobs).toEqual({})

    const result = await runCli(fixture, rollbackArgs(lastRunRecord(fixture).runId), {cloudflare: failed.cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(Object.keys(result.cloudflare!.consumers!.jobs)).toEqual([name])
  })

  it('says so in a dry run', async () => {
    const {cloudflare, fixture} = await movedToNewWorker()
    const applied = await applyPlan(fixture, cloudflare)
    expect(applied.exitCode, applied.stderr).toBe(0)

    const result = await runCli(fixture, [...rollbackArgs(lastRunRecord(fixture).runId), '--dry-run'], {cloudflare: applied.cloudflare, noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('ledger: detach it from queue jobs, as a worker this rollback puts back takes it again')
  })
})

describe('rollback, when a worker that took a consumer fails to let it go', () => {
  const outage = {command: 'queues consumer remove', exitCode: 1, failMessage: 'outage', stderr: 'outage\n'}

  it('skips the workers that caller waits for, and restores its callers', async () => {
    const fixture = deployFixture()
    const live = await liveWithJobs(fixture)
    const path = join(fixture.worker('orders'), 'wrangler.jsonc')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    changeConfig(fixture, 'orders', {...config, env: {staging: {...config.env.staging, ...consumer(1)}}})
    const plan = await planFor(fixture, live, {rules: newCode('billing', 'gateway')})
    const applied = await applyPlan(fixture, live)
    expect(applied.exitCode, applied.stderr).toBe(0)

    const result = await runCli(fixture, rollbackArgs(lastRunRecord(fixture).runId), {cloudflare: applied.cloudflare, rules: [outage]})

    expect(result.exitCode).toBe(1)
    expect(writesOf(result.calls)).toEqual(['promote gateway'])
    expect(lastRunRecord(fixture).workers).toMatchObject({billing: {reason: 'orders', result: 'skipped'}, gateway: {result: 'ok'}, orders: {result: 'failed'}})
    expect(Object.keys(result.cloudflare!.consumers!.jobs)).toEqual([stepOf(plan, 'orders').deployedName])
  })
})

describe('rollback, when the worker that would take a queue back is refused', () => {
  it('leaves the consumer on a worker the run created', async () => {
    const withDurableObject = {durable_objects: {bindings: [{class_name: 'Counter', name: 'COUNTER'}]}, migrations: [{new_sqlite_classes: ['Counter'], tag: 'v1'}]}
    const {cloudflare, fixture, names} = await movedToNewWorker(withDurableObject)
    const applied = await applyPlan(fixture, cloudflare)
    expect(applied.exitCode, applied.stderr).toBe(0)

    // billing is refused, so nothing takes jobs back, and the rollback calls nothing.
    const result = await runCli(fixture, rollbackArgs(lastRunRecord(fixture).runId), {cloudflare: applied.cloudflare, noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(lastRunRecord(fixture).workers.billing).toMatchObject({result: 'refused'})
    expect(Object.keys(result.cloudflare!.consumers!.jobs)).toEqual([names.ledger])
  })
})

describe('apply, with a Workflow on a live worker', () => {
  it('registers one that is added', async () => {
    const fixture = deployFixture()
    const {cloudflare, name, plan} = await applyChange(fixture, await firstRun(fixture), workflow)

    expect(stepOf(plan, 'reports')).toMatchObject({triggersChanged: true})
    expect(cloudflare.workflows?.['nightly-flow']).toEqual({className: 'Flow', script: name})
  })

  it("says that a removed one stays registered, as nothing deletes it", async () => {
    const fixture = deployFixture()
    const {cloudflare} = await applyChange(fixture, await firstRun(fixture), workflow)
    staging(fixture, {})

    const plan = await planFor(fixture, cloudflare)
    const notes = plan.notes.filter(({kind}: {kind: string}) => kind === 'workflow-removed')
    expect(notes).toHaveLength(1)
    expect(notes[0].message).toContain('wrangler workflows delete nightly-flow')
    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state'], {cloudflare})
    expect(result.stderr).toContain('workflow-removed: reports')
  })
})

describe('apply, with tail consumers on a live worker', () => {
  it('attaches them, and clears them once the config drops them', async () => {
    const fixture = deployFixture()
    const added = await applyChange(fixture, await firstRun(fixture), tail)
    expect(added.cloudflare.workers![added.name].tailConsumers).toEqual(['logs'])

    const removed = await applyChange(fixture, added.cloudflare, {})
    expect(stepOf(removed.plan, 'reports')).toMatchObject({explicitEmptyTails: ['tail_consumers'], triggersChanged: true})
    expect(removed.cloudflare.workers![removed.name].tailConsumers).toEqual([])
  })

  it('clears streaming tail consumers once the config drops them', async () => {
    const fixture = deployFixture()
    const added = await applyChange(fixture, await firstRun(fixture), {streaming_tail_consumers: [{service: 'logs'}]})
    expect(added.cloudflare.workers![added.name].streamingTailConsumers).toEqual(['logs'])

    const removed = await applyChange(fixture, added.cloudflare, {})

    expect(stepOf(removed.plan, 'reports')).toMatchObject({explicitEmptyTails: ['streaming_tail_consumers']})
    expect(removed.cloudflare.workers![removed.name].streamingTailConsumers).toEqual([])
  })

  it('fails the step when the read after giving the live version again for them names another', async () => {
    const fixture = deployFixture()
    const live = await firstRun(fixture)
    staging(fixture, tail)
    await planFor(fixture, live)
    const killed = await applyPlan(fixture, live, {rules: [{command: 'versions deploy', effectThenFail: true, exitCode: 1, noSettings: true, times: 1}]})
    const next = await planFor(fixture, killed.cloudflare!)
    const step = stepOf(next, 'reports')
    expect(step).toMatchObject({action: 'triggers'})
    // The first read checks that what's live is what the plan saw. The second verifies the tails' promote.
    const versions = [{percentage: 100, version_id: 'someone-elses'}]
    const other = {command: 'deployments status', skip: 1, stdout: JSON.stringify({versions}), times: 1, worker: step.deployedName}

    const result = await applyPlan(fixture, killed.cloudflare!, {rules: [other]})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('verify-mismatch')
  })

  it('gives the live version again for them when an adopted worker has no state entry', async () => {
    const fixture = deployFixture()
    staging(fixture, tail)
    const live = await firstRun(fixture)
    const path = join(fixture.root, 'state', 'staging', 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    delete manifest.workers.reports
    writeFileSync(path, JSON.stringify(manifest))

    const plan = await planFor(fixture, live)
    expect(stepOf(plan, 'reports')).toMatchObject({action: 'adopt'})
    const result = await applyPlan(fixture, live)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual(['promote reports', 'triggers reports'])
  })

  it('sets them on the next run, when a promote went live without them', async () => {
    const fixture = deployFixture()
    const live = await firstRun(fixture)
    staging(fixture, tail)
    const plan = await planFor(fixture, live)
    const name = stepOf(plan, 'reports').deployedName
    const killed = await applyPlan(fixture, live, {rules: [{command: 'versions deploy', effectThenFail: true, exitCode: 1, noSettings: true, times: 1}]})
    expect(killed.exitCode).toBe(1)
    expect(killed.cloudflare!.workers![name].tailConsumers).toBeUndefined()

    const next = await planFor(fixture, killed.cloudflare!)
    expect(stepOf(next, 'reports')).toMatchObject({action: 'triggers'})
    const healed = await applyPlan(fixture, killed.cloudflare!)

    expect(healed.exitCode, healed.stderr).toBe(0)
    expect(writesOf(healed.calls)).toEqual(['promote reports', 'triggers reports'])
    expect(healed.cloudflare!.workers![name].tailConsumers).toEqual(['logs'])
    expect(stepOf(await planFor(fixture, healed.cloudflare!), 'reports')).toMatchObject({action: 'skip'})
  })
})

describe('rollback, across these', () => {
  it('detaches the consumer, clears the tail consumers, and names the Workflow, that the run added', async () => {
    const fixture = deployFixture()
    const live = await liveWithJobs(fixture)
    const {cloudflare, name} = await applyChange(fixture, live, {...consumer(1), ...tail, ...workflow})
    const {runId} = lastRunRecord(fixture)

    const result = await runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', runId], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.cloudflare!.consumers?.jobs).toEqual({})
    expect(result.cloudflare!.workers![name].tailConsumers).toEqual([])
    expect(result.cloudflare!.workflows?.['nightly-flow']).toBeDefined()
    expect(result.stderr).toContain('wrangler workflows delete')
  })

  it('puts back the Workflow class that the run changed', async () => {
    const fixture = deployFixture()
    const before = await applyChange(fixture, await firstRun(fixture), workflow)
    const {cloudflare} = await applyChange(fixture, before.cloudflare, {workflows: [{...workflow.workflows[0], class_name: 'Flow2'}]})
    expect(cloudflare.workflows?.['nightly-flow']?.className).toBe('Flow2')
    const {runId} = lastRunRecord(fixture)

    const result = await runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', runId], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.cloudflare!.workflows?.['nightly-flow']?.className).toBe('Flow')
  })

  it('puts back the consumer settings and tail consumers that the run changed', async () => {
    const fixture = deployFixture()
    const before = await applyChange(fixture, await liveWithJobs(fixture), {...consumer(1), ...tail})
    const {cloudflare, name} = await applyChange(fixture, before.cloudflare, {...consumer(2), tail_consumers: [{service: 'audit'}]})
    const {runId} = lastRunRecord(fixture)

    const result = await runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', runId], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.cloudflare!.consumers?.jobs?.[name]).toMatchObject({max_batch_size: 1})
    expect(result.cloudflare!.workers![name].tailConsumers).toEqual(['logs'])
  })
})
