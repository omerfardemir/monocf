import {describe, expect, it} from 'vitest'

import {deployFixture, eventsOf, firstRun, newCode, planFor} from '../helpers/deploy-fixtures.js'
import {createFixture, runCli} from '../helpers/harness.js'

describe('whoami --json', () => {
  it('gives the accounts with their IDs masked', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['whoami', '--json'])

    expect(result.exitCode).toBe(0)
    expect(result.calls.map(({argv}) => argv)).toEqual([['whoami', '--json']])
    expect(eventsOf(result)).toEqual([
      {
        accounts: [{account: '0123…cdef', name: 'Fake account'}],
        authType: 'User API Token',
        email: 'fake@example.com',
        schemaVersion: 1,
        type: 'whoami',
      },
    ])
    expect(result.stdout).not.toContain('0123456789abcdef0123456789abcdef')
  })

  it('is an environment error when wrangler is not logged in', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['whoami', '--json'], {rules: [{command: 'whoami', exitCode: 1, stdout: '{"loggedIn":false}'}]})

    expect(result.exitCode).toBe(3)
    expect(eventsOf(result)).toEqual([expect.objectContaining({code: 'not-authenticated', exitCode: 3, type: 'error'})])
  })
})

describe('worker create --json', () => {
  it('names the new worker', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'create', 'billing', '--json'], {noCalls: true})

    expect(result.exitCode).toBe(0)
    expect(eventsOf(result)).toEqual([{path: fixture.worker('billing'), schemaVersion: 1, type: 'worker-created', worker: 'billing'}])
  })

  it('gives an error event for a name that exists', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'create', 'orders', '--json'], {noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(eventsOf(result)).toEqual([expect.objectContaining({code: 'worker-exists', type: 'error'})])
  })
})

describe('apply --json', () => {
  it('gives the run ID in run-started', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})

    const result = await runCli(fixture, ['apply', 'plan.json', '--json'], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(eventsOf(result)[0]).toMatchObject({action: 'apply', runId: expect.stringMatching(/^\d{8}T\d{6}Z-/), type: 'run-started'})
  })
})

describe('a stdin that stays open', () => {
  it.each([
    ['deploy', ['deploy', 'orders']],
    ['whoami', ['whoami']],
    ['check', ['check']],
  ])('does not hold up %s', async (_, args) => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, args, {noCalls: args[0] === 'check', openStdin: true})

    expect(result.exitCode, result.stderr).toBe(0)
  })
})
