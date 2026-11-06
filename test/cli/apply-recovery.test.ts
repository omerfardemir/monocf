import {rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {activeOf, actionsOf, applyPlan, callsOf, commitAll, deployFixture, firstRun, manifestOf, planFor, readPlan, stepOf, writesOf} from '../helpers/deploy-fixtures.js'
import type {FakeCloudflare, Fixture, WranglerRule} from '../helpers/harness.js'

const dropped = (worker: string): WranglerRule => ({command: 'deploy', effectThenFail: true, exitCode: 1, failMessage: 'fetch failed', stderr: 'fetch failed\n', times: 1, worker})
const refused = (worker: string, command = 'deploy'): WranglerRule => ({command, exitCode: 1, failMessage: 'fetch failed', stderr: 'fetch failed\n', times: 1, worker})

async function live(fixture: Fixture): Promise<FakeCloudflare> {
  const cloudflare = await firstRun(fixture)
  const planned = await planFor(fixture, cloudflare)
  expect(new Set(Object.values(actionsOf(planned)))).toEqual(new Set(['skip']))
  return cloudflare
}

describe('apply, retrying a deploy that took effect', () => {
  it('applies the triggers it may not have reached, and deploys once', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})

    const result = await applyPlan(fixture, {}, {rules: [dropped('billing')]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(callsOf(result.calls, 'deploy billing')).toHaveLength(1)
    expect(callsOf(result.calls, 'triggers billing')).toHaveLength(1)
    expect(writesOf(result.calls).indexOf('deploy billing')).toBeLessThan(writesOf(result.calls).indexOf('triggers billing'))
  })

  it('says the triggers are behind when they fail too, so the next plan applies them', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    const stopped: WranglerRule = {command: 'triggers deploy', exitCode: 1, stderr: 'Invalid cron\n', worker: 'billing'}

    const result = await applyPlan(fixture, {}, {rules: [dropped('billing'), stopped]})

    expect(result.exitCode).toBe(1)
    expect(manifestOf(fixture).workers.billing.triggersHash).toBe('not-applied')
    expect(stepOf(await planFor(fixture, result.cloudflare!), 'billing')).toMatchObject({action: 'triggers', reasons: ['triggers-changed']})
  })
})

/** gateway has a site, so a new version of it takes a deploy. Its code doesn't change, so its old version has the tag it's after. */
async function marked() {
  const fixture = deployFixture({workers: [{config: {site: {bucket: './site'}}, envBindings: {staging: ['billing']}, name: 'gateway'}, {name: 'billing'}]})
  const cloudflare = await live(fixture)
  const before = await planFor(fixture, cloudflare)
  const provider = stepOf(before, 'billing').deployedName
  const {[provider]: gone, ...rest} = cloudflare.workers!
  expect(gone).toBeDefined()
  const without = {...cloudflare, workers: rest}
  const plan = await planFor(fixture, without, {flags: ['--allow-recreate']})
  expect(stepOf(plan, 'gateway')).toMatchObject({action: 'full-deploy', reasons: ['provider-recreated', 'needs-deploy']})
  return {cloudflare: without, fixture, name: stepOf(plan, 'gateway').deployedName, old: activeOf(cloudflare, stepOf(plan, 'gateway'))}
}

describe('apply, retrying the full deploy of a marked caller', () => {
  it("doesn't take the old version for the new one, and deploys again", async () => {
    const {cloudflare, fixture, name, old} = await marked()

    const result = await applyPlan(fixture, cloudflare, {rules: [refused('gateway')]})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(callsOf(result.calls, 'deploy gateway')).toHaveLength(2)
    expect(result.cloudflare!.workers![name].active[0][0]).not.toBe(old)
    expect(manifestOf(fixture).needsNewVersion).toBeUndefined()
  })

  it('keeps the marker when no attempt gets through', async () => {
    const {cloudflare, fixture, name, old} = await marked()
    const always: WranglerRule = {command: 'deploy', exitCode: 1, failMessage: 'fetch failed', stderr: 'fetch failed\n', worker: 'gateway'}

    const result = await applyPlan(fixture, cloudflare, {rules: [always]})

    expect(result.exitCode).toBe(1)
    expect(result.cloudflare!.workers![name].active[0][0]).toBe(old)
    expect(manifestOf(fixture).needsNewVersion).toEqual(['gateway'])
    expect(stepOf(await planFor(fixture, result.cloudflare!), 'gateway').reasons).toContain('provider-recreated')
  })
})

describe('apply, recovering what a crash left live', () => {
  it('runs triggers deploy on adopt for a worker with no crons or routes, as workers_dev goes that way', async () => {
    const fixture = deployFixture()
    const cloudflare = await live(fixture)
    rmSync(join(fixture.root, 'state', 'staging', 'manifest.json'))
    const plan = await planFor(fixture, cloudflare)
    expect(stepOf(plan, 'reports')).toMatchObject({action: 'adopt', triggersChanged: true})

    const result = await applyPlan(fixture, cloudflare)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(callsOf(result.calls, 'triggers reports')).toHaveLength(1)
    expect(writesOf(result.calls).every((write) => write.startsWith('triggers '))).toBe(true)
  })

  it('runs triggers deploy for a state-behind worker whose triggers look the same', async () => {
    const fixture = deployFixture()
    const cloudflare = await live(fixture)
    const name = stepOf(readPlan(fixture), 'orders').deployedName
    const worker = cloudflare.workers![name]
    const left = 'left-by-a-crash'
    worker.tags![left] = worker.tags![worker.active[0][0]]
    worker.active = [[left, 100]]
    const plan = await planFor(fixture, cloudflare)
    expect(stepOf(plan, 'orders')).toMatchObject({action: 'triggers', previousVersionId: left, recordState: true, reasons: ['state-behind'], triggersChanged: true})

    const result = await applyPlan(fixture, cloudflare)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(writesOf(result.calls)).toEqual(['triggers orders'])
    expect(manifestOf(fixture).workers.orders.versionId).toBe(left)
    expect(stepOf(await planFor(fixture, result.cloudflare!), 'orders').action).toBe('skip')
  })

  it("leaves a recovery's failure where the next plan finds it", async () => {
    const fixture = deployFixture()
    const cloudflare = await live(fixture)
    rmSync(join(fixture.root, 'state', 'staging', 'manifest.json'))
    await planFor(fixture, cloudflare)

    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'triggers deploy', exitCode: 1, stderr: 'no\n', worker: 'reports'}]})

    expect(result.exitCode).toBe(1)
    expect(manifestOf(fixture).workers.reports).toBeUndefined()
    expect(stepOf(await planFor(fixture, result.cloudflare!), 'reports').action).toBe('adopt')
  })
})

describe('apply, and the marker', () => {
  it('marks a caller in .monocfignore when its provider is recreated, and acts once it is selected', async () => {
    const fixture = deployFixture()
    const cloudflare = await live(fixture)
    writeFileSync(join(fixture.root, '.monocfignore'), 'gateway\norders\n')
    commitAll(fixture)
    const provider = stepOf(await planFor(fixture, cloudflare), 'billing').deployedName
    const {[provider]: gone, ...rest} = cloudflare.workers!
    expect(gone).toBeDefined()
    const plan = await planFor(fixture, {...cloudflare, workers: rest}, {flags: ['--allow-recreate']})
    expect(stepOf(plan, 'billing').markCallers).toEqual(['orders'])
    expect(plan.notes.find(({kind}: {kind: string}) => kind === 'caller-ignored').message).toContain("once it's selected")

    const applied = await applyPlan(fixture, {...cloudflare, workers: rest})

    expect(applied.exitCode, applied.stderr).toBe(0)
    expect(writesOf(applied.calls)).not.toContain('upload orders')
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])

    const stillIgnored = await planFor(fixture, applied.cloudflare!)
    expect(stillIgnored.steps.map(({worker}: {worker: string}) => worker)).not.toContain('orders')
    await applyPlan(fixture, applied.cloudflare!, {noCalls: true})
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])

    writeFileSync(join(fixture.root, '.monocfignore'), 'gateway\n')
    commitAll(fixture)
    expect(stepOf(await planFor(fixture, applied.cloudflare!), 'orders')).toMatchObject({action: 'upload', reasons: ['provider-recreated']})
  })

  it('drops a marker for a worker gone from the repository, and keeps the rest', async () => {
    const fixture = deployFixture()
    const cloudflare = await live(fixture)
    const path = join(fixture.root, 'state', 'staging', 'manifest.json')
    writeFileSync(path, JSON.stringify({...manifestOf(fixture), needsNewVersion: ['long-gone', 'orders']}))
    await planFor(fixture, cloudflare, {flags: ['--workers', 'billing']})

    const result = await applyPlan(fixture, cloudflare, {noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(manifestOf(fixture).needsNewVersion).toEqual(['orders'])
  })
})

describe('apply, a marked caller that needed adopt', () => {
  it('gets a new version, and the triggers an adopt would have run', async () => {
    const fixture = deployFixture()
    const cloudflare = await live(fixture)
    const manifest = manifestOf(fixture)
    delete manifest.workers.orders
    writeFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), JSON.stringify({...manifest, needsNewVersion: ['orders']}))
    const plan = await planFor(fixture, cloudflare)
    expect(stepOf(plan, 'orders')).toMatchObject({action: 'upload', reasons: ['provider-recreated'], triggersChanged: true})

    const result = await applyPlan(fixture, cloudflare)

    expect(result.exitCode, result.stderr).toBe(0)
    const writes = writesOf(result.calls)
    expect(writes.indexOf('upload orders')).toBeLessThan(writes.indexOf('promote orders'))
    expect(writes.indexOf('promote orders')).toBeLessThan(writes.indexOf('triggers orders'))
    expect(manifestOf(fixture).needsNewVersion).toBeUndefined()
  })
})
