import {describe, expect, it} from 'vitest'

import {actionsOf, applyPlan, deployFixture, firstRun, readPlan, stepOf} from '../helpers/deploy-fixtures.js'
import {runCli, type FakeCloudflare, type Fixture} from '../helpers/harness.js'

const plan = ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json', '--on-drift', 'fail']

async function deployed(): Promise<{cloudflare: FakeCloudflare; fixture: Fixture; name: string}> {
  const fixture = deployFixture()
  const cloudflare = await firstRun(fixture)
  const planned = await runCli(fixture, plan, {cloudflare})
  expect(planned.exitCode, planned.stderr).toBe(0)
  return {cloudflare: planned.cloudflare!, fixture, name: stepOf(readPlan(fixture), 'billing').deployedName}
}

/** What `wrangler secret bulk` leaves: a new version with no tag, from the latest upload, made live. */
function rotateSecret(cloudflare: FakeCloudflare, name: string, id = 'secret-version'): FakeCloudflare {
  const worker = cloudflare.workers![name]
  return {
    ...cloudflare,
    workers: {
      ...cloudflare.workers,
      [name]: {...worker, active: [[id, 100]], tags: {...worker.tags, [id]: null}, triggeredBy: {...worker.triggeredBy, [id]: 'secret'}},
    },
  }
}

/** A deploy from someone's own machine, with no tag from monocf. */
function manualDeploy(cloudflare: FakeCloudflare, name: string): FakeCloudflare {
  const worker = cloudflare.workers![name]
  const id = 'manual-version'
  return {...cloudflare, workers: {...cloudflare.workers, [name]: {...worker, active: [[id, 100]], tags: {...worker.tags, [id]: null}, triggeredBy: {...worker.triggeredBy, [id]: 'upload'}}}}
}

describe('plan --on-drift fail, with a version a secret command made (WP6-9)', () => {
  it('takes a rotation on known code as routine', async () => {
    const {cloudflare, fixture, name} = await deployed()

    const result = await runCli(fixture, plan, {cloudflare: rotateSecret(cloudflare, name)})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(stepOf(readPlan(fixture), 'billing')).toMatchObject({action: 'upload', reasons: ['secret-changed']})
  })

  it('takes two rotations in a row as routine', async () => {
    const {cloudflare, fixture, name} = await deployed()
    const twice = rotateSecret(rotateSecret(cloudflare, name), name, 'second-secret-version')

    const result = await runCli(fixture, plan, {cloudflare: twice})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(actionsOf(readPlan(fixture)).billing).toBe('upload')
  })

  it("blocks a manual deploy that a secret change came after, and doesn't overwrite it", async () => {
    const {cloudflare, fixture, name} = await deployed()
    const hidden = rotateSecret(manualDeploy(cloudflare, name), name)

    const result = await runCli(fixture, plan, {cloudflare: hidden})

    expect(result.exitCode).toBe(1)
    const planned = readPlan(fixture)
    expect(planned.applicable).toBe(false)
    expect(stepOf(planned, 'billing')).toMatchObject({action: 'blocked', reasons: ['drift']})
    expect(planned.notes.find(({worker}: {worker: string}) => worker === 'billing').message).toContain('code the state manifest')

    const applied = await applyPlan(fixture, hidden, {noCalls: true})
    expect(applied.exitCode).toBe(2)
    expect(applied.calls).toEqual([])
  })

  it('reads as drift when the version it came from is not in the list', async () => {
    const {cloudflare, fixture, name} = await deployed()
    const result = await runCli(fixture, plan, {
      cloudflare: rotateSecret(cloudflare, name),
      rules: [{command: 'versions list', stdout: JSON.stringify([{annotations: {'workers/triggered_by': 'secret'}, id: 'secret-version', number: 2}]), worker: name}],
    })

    expect(result.exitCode).toBe(1)
    expect(actionsOf(readPlan(fixture)).billing).toBe('blocked')
  })

  it('stops the plan when the list cannot be read, rather than guess', async () => {
    const {cloudflare, fixture, name} = await deployed()

    const result = await runCli(fixture, plan, {
      cloudflare: rotateSecret(cloudflare, name),
      rules: [{command: 'versions list', exitCode: 1, stderr: '✘ [ERROR] Authentication error [code: 10000]\n'}],
    })

    expect(result.exitCode).toBe(3)
  })
})
