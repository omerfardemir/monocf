import {readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {applyPlan, commitAll, deployFixture, firstRun, manifestOf, planFor} from '../helpers/deploy-fixtures.js'
import type {FakeCloudflare} from '../helpers/harness.js'

/** billing and reports went out once, and then reports left the repository. */
async function reportsLeft() {
  const fixture = deployFixture({workers: [{name: 'billing'}, {name: 'reports'}]})
  const cloudflare = await firstRun(fixture)
  const {deployedName} = manifestOf(fixture).workers.reports
  expect(manifestOf(fixture).workers.reports.accountHash).toBeDefined()
  rmSync(fixture.worker('reports'), {force: true, recursive: true})
  commitAll(fixture)
  return {cloudflare, deployedName, fixture}
}

function without(cloudflare: FakeCloudflare, name: string): FakeCloudflare {
  const {[name]: gone, ...rest} = cloudflare.workers!
  expect(gone).toBeDefined()
  return {...cloudflare, workers: rest}
}

const kindsOf = (plan: {notes: {kind: string; worker: string}[]}) => plan.notes.map(({kind, worker}) => `${kind} ${worker}`)

describe('a worker gone from the repository', () => {
  it('stays an orphan while it is live, and the note says how it clears', async () => {
    const {cloudflare, fixture} = await reportsLeft()

    const plan = await planFor(fixture, cloudflare)

    expect(kindsOf(plan)).toEqual(['orphan reports'])
    expect(plan.notes[0].message).toContain('Once it is deleted from Cloudflare, the next plan and apply drop it from the state.')
  })

  it('leaves the state once it is deleted from Cloudflare too, and the note clears', async () => {
    const {cloudflare, deployedName, fixture} = await reportsLeft()
    const deleted = without(cloudflare, deployedName)

    const plan = await planFor(fixture, deleted)
    expect(kindsOf(plan)).toEqual(['orphan-gone reports'])
    // Nothing to deploy, so the only change is to the state, which takes no wrangler call.
    const applied = await applyPlan(fixture, deleted, {noCalls: true})

    expect(applied.exitCode, applied.stderr).toBe(0)
    expect(manifestOf(fixture).workers.reports).toBeUndefined()
    expect(manifestOf(fixture).workers.billing).toBeDefined()
    expect(kindsOf(await planFor(fixture, applied.cloudflare!))).toEqual([])
  })

  it("isn't read in an account other than the one its entry recorded, so it stays an orphan", async () => {
    const {cloudflare, deployedName, fixture} = await reportsLeft()
    const path = join(fixture.root, 'state', 'staging', 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.workers.reports.accountHash = 'another-account'
    writeFileSync(path, JSON.stringify(manifest))

    const plan = await planFor(fixture, without(cloudflare, deployedName))

    expect(kindsOf(plan)).toEqual(['orphan reports'])
  })
})
