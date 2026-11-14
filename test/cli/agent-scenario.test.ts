import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {changeConfig, deployFixture, eventsOf, firstRun, stepOf} from '../helpers/deploy-fixtures.js'
import {runCli, type Fixture, type RunOptions} from '../helpers/harness.js'
import {packPackage, type Packed} from '../helpers/packed.js'

/**
 * What an agent with only the installed package and its skill does: read the JSON, look up each code with explain, act on its
 * advice. It runs what `npm pack` publishes, not this checkout. Nothing here matches English text, apart from what explain advises.
 */
const STATE = ['-e', 'staging', '--state', 'file:state', '--out', 'plan.json']

let packed: Packed

beforeAll(() => {
  packed = packPackage()
}, 120_000)

afterAll(() => {
  packed?.remove()
})

function cli(fixture: Fixture, args: string[], options: RunOptions = {}) {
  return runCli(fixture, args, {...options, bin: packed.bin})
}

async function json(fixture: Fixture, args: string[], options: RunOptions = {}) {
  const result = await cli(fixture, [...args, '--json'], options)
  return {events: eventsOf(result), exitCode: result.exitCode}
}

async function explain(fixture: Fixture, code: string) {
  const result = await cli(fixture, ['explain', code, '--json'], {noCalls: true})
  return JSON.parse(result.stdout).entries as {kind: string; next?: string}[]
}

describe('the package', () => {
  it('ships the CLI, every command, the docs and the skill, and no source', () => {
    for (const file of ['bin/run.js', 'dist/app/main.js', 'dist/commands/plan/index.js', 'dist/commands/explain/index.js', 'dist/commands/secrets/check.js', 'docs/json-output.md', 'skills/monocf/SKILL.md']) {
      expect(packed.files, file).toContain(file)
    }

    expect(packed.files.filter((file) => file.endsWith('.d.ts') || /^(src|test)\//.test(file))).toEqual([])
  })

  it('ships the manifest prepack writes, with what monocf commands reads from it', () => {
    const {files, scripts} = JSON.parse(readFileSync(join(packed.dir, 'package.json'), 'utf8'))
    expect(files).toContain('./oclif.manifest.json')
    expect(scripts.prepack).toBe('oclif manifest')
    const {commands} = JSON.parse(readFileSync(join(packed.dir, 'oclif.manifest.json'), 'utf8')) as {commands: Record<string, {exitCodes?: object; safety?: string}>}
    expect(Object.keys(commands).length).toBeGreaterThan(15)
    expect(Object.entries(commands).filter(([, {exitCodes, safety}]) => exitCodes === undefined || safety === undefined)).toEqual([])
  })
})

describe('an agent', () => {
  it('finds the command, why there is no plan, fixes the config, and plans again', async () => {
    const skill = readFileSync(join(packed.dir, 'skills', 'monocf', 'SKILL.md'), 'utf8')
    for (const command of ['monocf commands --json', 'monocf check -e <env> --json', 'monocf explain <code>']) expect(skill).toContain(command)

    const fixture = deployFixture()
    const listed = JSON.parse((await cli(fixture, ['commands', '--json'], {noCalls: true})).stdout)
    expect(listed.commands.find(({id}: {id: string}) => id === 'plan')).toMatchObject({requiredFlags: ['env', 'state'], safety: 'reads-cloudflare'})
    changeConfig(fixture, 'billing', {main: 'src/missing.ts'})

    const refused = await json(fixture, ['plan', ...STATE, '--first-run'], {cloudflare: {}, noCalls: true})
    expect(refused.exitCode).toBe(2)
    const error = refused.events.at(-1)!
    expect(error).toMatchObject({code: 'check-failed', type: 'error'})
    expect(error.hint).toContain('monocf check')

    const check = JSON.parse((await cli(fixture, ['check', '-e', 'staging', '--json'], {noCalls: true})).stdout)
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
