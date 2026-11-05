import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {
  applyPlan,
  changeConfig,
  deployFixture,
  firstRun,
  lastRunRecord,
  planFor,
  stepOf,
  writesOf,
} from '../helpers/deploy-fixtures.js'
import {runCli, type FakeCloudflare, type Fixture} from '../helpers/harness.js'

// Queues, Workflows and tail consumers don't inherit, so they go in the env section.
function staging(fixture: Fixture, section: Record<string, unknown>): void {
  changeConfig(fixture, 'reports', {env: {staging: section}})
}

const consumer = (batch: number) => ({queues: {consumers: [{max_batch_size: batch, queue: 'jobs'}]}})
const workflow = {workflows: [{binding: 'FLOW', class_name: 'Flow', name: 'nightly-flow'}]}
const tail = {tail_consumers: [{service: 'logs'}]}

async function applyChange(fixture: Fixture, cloudflare: FakeCloudflare, section: Record<string, unknown>) {
  staging(fixture, section)
  const plan = await planFor(fixture, cloudflare)
  const result = await applyPlan(fixture, cloudflare)
  expect(result.exitCode, result.stderr).toBe(0)
  return {cloudflare: result.cloudflare!, name: stepOf(plan, 'reports').deployedName as string, plan, result}
}

describe('apply, with a queue consumer on a live worker', () => {
  it('attaches one that is added, updates its settings, and detaches it once removed', async () => {
    const fixture = deployFixture()
    const live = await firstRun(fixture)

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

  it('leaves alone a consumer someone already detached, and still finishes', async () => {
    const fixture = deployFixture()
    const {cloudflare, name} = await applyChange(fixture, await firstRun(fixture), consumer(1))
    delete cloudflare.consumers!.jobs[name]

    const removed = await applyChange(fixture, cloudflare, {})

    expect(removed.result.calls.map(({argv}) => argv.slice(0, 3).join(' '))).not.toContain('queues consumer remove')
  })

  it('counts one whose queue is gone as detached, as there is nothing to detach', async () => {
    const fixture = deployFixture()
    const {cloudflare} = await applyChange(fixture, await firstRun(fixture), consumer(1))
    delete cloudflare.consumers!.jobs

    const removed = await applyChange(fixture, cloudflare, {})

    expect(stepOf(removed.plan, 'reports')).toMatchObject({removedConsumers: ['jobs']})
    expect(removed.result.calls.map(({argv}) => argv.slice(0, 3).join(' '))).not.toContain('queues consumer remove')
    expect(stepOf(await planFor(fixture, removed.cloudflare), 'reports')).toMatchObject({action: 'skip'})
  })

  it('fails the worker on any other failure to read the queue', async () => {
    const fixture = deployFixture()
    const {cloudflare} = await applyChange(fixture, await firstRun(fixture), consumer(1))
    staging(fixture, {})
    await planFor(fixture, cloudflare)
    const stderr = '✘ [ERROR] A request to the Cloudflare API (/accounts/0123456789abcdef0123456789abcdef/queues) failed. [code: 10001]\n'

    const failed = await applyPlan(fixture, cloudflare, {rules: [{command: 'queues consumer worker list', exitCode: 1, stderr}]})

    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain('The consumers of queue jobs: wrangler failed with exit code 1')
    expect(stepOf(await planFor(fixture, failed.cloudflare!), 'reports')).toMatchObject({removedConsumers: ['jobs']})
  })

  it('has the next plan detach it, when the detach fails', async () => {
    const fixture = deployFixture()
    const {cloudflare} = await applyChange(fixture, await firstRun(fixture), consumer(1))
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

/** billing consumes jobs, and then one commit moves it to reports. */
async function moved() {
  const fixture = deployFixture()
  const live = await firstRun(fixture)
  changeConfig(fixture, 'billing', {env: {staging: consumer(1)}})
  await planFor(fixture, live)
  const before = await applyPlan(fixture, live)
  expect(before.exitCode, before.stderr).toBe(0)
  writeFileSync(join(fixture.worker('billing'), 'wrangler.jsonc'), JSON.stringify({env: {staging: {}}}))
  changeConfig(fixture, 'reports', {env: {staging: consumer(1)}})
  const plan = await planFor(fixture, before.cloudflare!)
  return {cloudflare: before.cloudflare!, fixture, names: {billing: stepOf(plan, 'billing').deployedName, reports: stepOf(plan, 'reports').deployedName}}
}

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
    const live = await firstRun(fixture)
    const {cloudflare, name} = await applyChange(fixture, live, {...consumer(1), ...tail, ...workflow})
    const {runId} = lastRunRecord(fixture)

    const result = await runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', runId], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.cloudflare!.consumers?.jobs).toEqual({})
    expect(result.cloudflare!.workers![name].tailConsumers).toEqual([])
    expect(result.cloudflare!.workflows?.['nightly-flow']).toBeDefined()
    expect(result.stderr).toContain('wrangler workflows delete')
  })

  it('puts back the consumer settings and tail consumers that the run changed', async () => {
    const fixture = deployFixture()
    const before = await applyChange(fixture, await firstRun(fixture), {...consumer(1), ...tail})
    const {cloudflare, name} = await applyChange(fixture, before.cloudflare, {...consumer(2), tail_consumers: [{service: 'audit'}]})
    const {runId} = lastRunRecord(fixture)

    const result = await runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', runId], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.cloudflare!.consumers?.jobs?.[name]).toMatchObject({max_batch_size: 1})
    expect(result.cloudflare!.workers![name].tailConsumers).toEqual(['logs'])
  })
})
