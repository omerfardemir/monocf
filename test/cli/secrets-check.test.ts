import {describe, expect, it} from 'vitest'

import {eventsOf} from '../helpers/deploy-fixtures.js'
import {createFixture, runCli, type FakeCloudflare, type Fixture} from '../helpers/harness.js'

const VALUE = 'a-value-nobody-should-see'

function project(config: Record<string, unknown>, files: Record<string, string> = {}): Fixture {
  return createFixture({environments: ['staging'], files, workers: [{config, name: 'orders'}]})
}

const required = (...names: string[]) => ({env: {staging: {secrets: {required: names}}}})

function live(secrets: string[], active: [string, number][] = [['v1', 100]]): FakeCloudflare {
  return {workers: {'orders-v1-staging': {active, secrets, tags: Object.fromEntries(active.map(([id]) => [id, null]))}}}
}

const check = (fixture: Fixture, cloudflare: FakeCloudflare, flags: string[] = []) => runCli(fixture, ['secrets', 'check', '-e', 'staging', ...flags], {cloudflare})

describe('secrets check', () => {
  it('exits 0 when the active version has every name', async () => {
    const result = await check(project(required('API_KEY')), live(['API_KEY']))

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('has API_KEY')
  })

  it('exits 1 and names what is missing', async () => {
    const result = await check(project(required('API_KEY', 'OTHER')), live(['API_KEY']))

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('missing OTHER')
  })

  it('takes names from .dev.vars.example too, and never prints a value', async () => {
    const fixture = project(required('API_KEY'), {'workers/orders/.dev.vars.example': `FROM_EXAMPLE=${VALUE}\n`})

    const result = await check(fixture, live(['API_KEY']), ['--json'])

    expect(result.exitCode).toBe(1)
    expect(eventsOf(result).find(({type}) => type === 'secrets-check')).toMatchObject({missing: ['FROM_EXAMPLE'], present: ['API_KEY'], worker: 'orders'})
    expect(`${result.stdout}${result.stderr}`).not.toContain(VALUE)
    expect(`${result.stdout}${result.stderr}`).not.toContain('never-printed')
  })

  it('warns about a name nothing expects, and exits 0', async () => {
    const result = await check(project(required('API_KEY')), live(['API_KEY', 'LEFTOVER']))

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('warning: not expected LEFTOVER')
  })

  it('does not count a plain var as a secret', async () => {
    const result = await check(project(required('PLAIN')), live([]))

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('missing PLAIN')
  })

  it('reports a worker that does not exist, and exits 1', async () => {
    const result = await check(project(required('API_KEY')), {})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('does not exist')
  })

  it('says so when nothing says what to expect, reads nothing and exits 0', async () => {
    const result = await runCli(project({}), ['secrets', 'check', '-e', 'staging'], {cloudflare: {}, noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('nothing to check against')
    expect(result.calls).toEqual([])
  })

  it('asks the version with the largest share during a split', async () => {
    const cloudflare = live(['API_KEY'], [['small', 10], ['large', 90]])

    const {calls} = await check(project(required('API_KEY')), cloudflare)

    const views = calls.filter(({argv}) => argv[0] === 'versions' && argv[1] === 'view')
    expect(views.map(({argv}) => argv[2])).toEqual(['large'])
  })

  it("asks in the worker's own account", async () => {
    const account = 'ffff0000000000000000000000005678'
    const {calls} = await check(project({account_id: account, ...required('API_KEY')}), live(['API_KEY']))

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(({environment}) => environment.CLOUDFLARE_ACCOUNT_ID === account)).toBe(true)
  })

  it('needs an env', async () => {
    const result = await runCli(project({}), ['secrets', 'check'], {noCalls: true})

    expect(result.exitCode).toBe(2)
  })
})
