import {existsSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli} from '../helpers/harness.js'

describe('the account of a read', () => {
  it('runs from outside the project, and without WRANGLER_LOG', async () => {
    const fixture = createFixture({environments: ['staging'], workers: [{name: 'orders'}]})
    mkdirSync(join(fixture.root, 'state'))

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run'], {
      cloudflare: {},
      env: {WRANGLER_LOG: 'debug'},
    })

    expect(result.exitCode, result.stderr).toBe(0)
    const read = result.calls.find(({argv}) => argv.includes('--name'))!
    expect(read.cwd.startsWith(fixture.root)).toBe(false)
    expect(existsSync(read.cwd)).toBe(false)
    expect(read.environment.WRANGLER_LOG).toBeUndefined()
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('goes by the environment when account_id is %s', async (_name, accountId) => {
    const fixture = createFixture({environments: ['staging'], workers: [{config: {account_id: accountId}, name: 'orders'}]})
    mkdirSync(join(fixture.root, 'state'))

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run'], {
      cloudflare: {},
      env: {CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32)},
    })

    expect(result.exitCode, result.stderr).toBe(0)
    const read = result.calls.find(({argv}) => argv.includes('--name'))
    expect(read?.environment.CLOUDFLARE_ACCOUNT_ID).toBe('c'.repeat(32))
  })
})
