import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli, type Fixture} from '../helpers/harness.js'

const ACCOUNT = 'abcd0000000000000000000000001234'

function project(config: Record<string, unknown> = {}): Fixture {
  const fixture = createFixture({environments: ['staging'], workers: [{config, name: 'orders'}]})
  mkdirSync(join(fixture.root, 'state', 'staging'), {recursive: true})
  return fixture
}

const args = ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json', '--markdown', 'plan.md']
const planOf = (fixture: Fixture) => JSON.parse(readFileSync(join(fixture.root, 'plan.json'), 'utf8'))

describe('plan, against what looks like the wrong account', () => {
  it('exits 3 and writes a plan that is not applicable, naming the flag', async () => {
    const fixture = project()

    const result = await runCli(fixture, args, {cloudflare: {}, env: {CLOUDFLARE_ACCOUNT_ID: ACCOUNT}})

    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('--first-run')
    expect(planOf(fixture).applicable).toBe(false)
  })

  it('exits 0 with --first-run', async () => {
    const fixture = project()

    const result = await runCli(fixture, [...args, '--first-run'], {cloudflare: {}})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(planOf(fixture).applicable).toBe(true)
  })

  it('shows the mask, and never the ID, in the plan, the markdown and the output', async () => {
    const fixture = project()

    const result = await runCli(fixture, [...args, '--first-run'], {cloudflare: {}, env: {CLOUDFLARE_ACCOUNT_ID: ACCOUNT}})

    const markdown = readFileSync(join(fixture.root, 'plan.md'), 'utf8')
    expect(markdown).toContain('abcd…1234')
    expect(result.stderr).toContain('abcd…1234')
    const planText = readFileSync(join(fixture.root, 'plan.json'), 'utf8')
    expect(`${markdown}${planText}${result.stderr}${result.stdout}`).not.toContain(ACCOUNT)
  })

  it('says when wrangler chooses the account', async () => {
    const fixture = project()

    const result = await runCli(fixture, [...args, '--first-run'], {cloudflare: {}, env: {CF_ACCOUNT_ID: '', CLOUDFLARE_ACCOUNT_ID: ''}})

    expect(result.stderr).toContain('chosen by wrangler')
    expect(readFileSync(join(fixture.root, 'plan.md'), 'utf8')).toContain('chosen by wrangler')
  })

  it('takes the environment for the mask, when the account_id is blank', async () => {
    const fixture = project({account_id: '   '})

    const result = await runCli(fixture, [...args, '--first-run'], {cloudflare: {}, env: {CLOUDFLARE_ACCOUNT_ID: ACCOUNT}})

    expect(result.stderr).toContain('abcd…1234')
  })

  it("takes a worker's own account_id for the mask", async () => {
    const fixture = project({account_id: 'ffff0000000000000000000000005678'})

    const result = await runCli(fixture, [...args, '--first-run'], {cloudflare: {}})

    expect(result.stderr).toContain('ffff…5678')
  })

  it('leaves no plan behind that apply could take for a good one', async () => {
    const fixture = project()
    writeFileSync(join(fixture.root, 'plan.json'), JSON.stringify({applicable: true}))

    await runCli(fixture, args, {cloudflare: {}})

    expect(planOf(fixture).applicable).toBe(false)
  })
})
