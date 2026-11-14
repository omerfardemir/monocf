import {describe, expect, it} from 'vitest'

import {changeConfig, deployFixture, eventsOf, firstRun, stepOf} from '../helpers/deploy-fixtures.js'
import {runCli, type Fixture, type RunOptions} from '../helpers/harness.js'

/**
 * What an agent with only the CLI and the skill does: read the JSON, look up each code with explain, act on its advice. Nothing
 * here matches English text, apart from what explain advises.
 */
const STATE = ['-e', 'staging', '--state', 'file:state', '--out', 'plan.json']

async function json(fixture: Fixture, args: string[], options: RunOptions = {}) {
  const result = await runCli(fixture, [...args, '--json'], options)
  return {events: eventsOf(result), exitCode: result.exitCode}
}

async function explain(fixture: Fixture, code: string) {
  const result = await runCli(fixture, ['explain', code, '--json'], {noCalls: true})
  return JSON.parse(result.stdout).entries as {kind: string; next?: string}[]
}

describe('an agent', () => {
  it('finds why there is no plan, fixes the config, and plans again', async () => {
    const fixture = deployFixture()
    changeConfig(fixture, 'billing', {main: 'src/missing.ts'})

    const refused = await json(fixture, ['plan', ...STATE, '--first-run'], {cloudflare: {}, noCalls: true})
    expect(refused.exitCode).toBe(2)
    const error = refused.events.at(-1)!
    expect(error).toMatchObject({code: 'check-failed', type: 'error'})
    expect(error.hint).toContain('monocf check')

    const check = JSON.parse((await runCli(fixture, ['check', '-e', 'staging', '--json'], {noCalls: true})).stdout)
    const finding = check.findings.find(({level}: {level: string}) => level === 'error')
    expect(finding).toMatchObject({rule: 'missing-main', worker: 'billing'})
    expect((await explain(fixture, finding.rule))[0]).toMatchObject({kind: 'check-rule', next: expect.stringContaining('main')})

    changeConfig(fixture, 'billing', {})
    const planned = await json(fixture, ['plan', ...STATE, '--first-run'], {cloudflare: {}})
    expect(planned.exitCode).toBe(0)
    expect(planned.events.at(-1)).toMatchObject({plan: {applicable: true}, type: 'plan'})
  }, 300_000)

  it('finds why a plan is blocked, and leaves the decision to a person', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    const [name, live] = Object.entries(cloudflare.workers!).find(([deployed]) => deployed.startsWith('billing'))!
    // Someone deploys billing by hand.
    live.active = [['by-hand', 100]]
    live.tags = {...live.tags, 'by-hand': null}

    const blocked = await json(fixture, ['plan', ...STATE, '--on-drift', 'fail'], {cloudflare})
    expect(blocked.exitCode).toBe(1)
    const {plan} = blocked.events.at(-1) as {plan: {applicable: boolean; notes: {kind: string; worker: string}[]; steps: {action: string; deployedName: string; reasons: string[]; worker: string}[]}}
    expect(plan.applicable).toBe(false)
    const step = stepOf(plan, 'billing')
    expect(step).toMatchObject({action: 'blocked', deployedName: name})
    expect(step.reasons).toContain('drift')
    expect(plan.notes).toContainEqual(expect.objectContaining({kind: 'drift', worker: 'billing'}))
    expect((await explain(fixture, 'drift')).find(({kind}) => kind === 'plan-reason')!.next).toContain('a person')

    const refused = await json(fixture, ['apply', 'plan.json'], {cloudflare, noCalls: true})
    expect(refused.exitCode).toBe(2)
    expect(refused.events.at(-1)).toMatchObject({code: 'plan-blocked', type: 'error'})

    // The person agrees to deploy over it.
    const planned = await json(fixture, ['plan', ...STATE, '--on-drift', 'warn'], {cloudflare})
    expect(planned.exitCode).toBe(0)
    expect(stepOf((planned.events.at(-1) as {plan: {steps: []}}).plan, 'billing')).toMatchObject({action: 'upload', reasons: expect.arrayContaining(['drift'])})
  }, 300_000)
})
