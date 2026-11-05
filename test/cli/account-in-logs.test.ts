import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

import {applyPlan, deployFixture, planFor} from '../helpers/deploy-fixtures.js'
import {createFixture, runCli, type CliResult, type WranglerRule} from '../helpers/harness.js'

const ACCOUNT = 'abcdef0123456789abcdef0123456789'
const OTHER = '0123456789abcdef0123456789abcdef'
const said = `✘ [ERROR] A request to the Cloudflare API (/accounts/${OTHER}/workers/services) failed.\nYour account is ${ACCOUNT}, as ever.\n`

const clean = ({stderr, stdout}: CliResult) => {
  expect(stderr).not.toContain(ACCOUNT)
  expect(stderr).not.toContain(OTHER)
  expect(stdout).not.toContain(ACCOUNT)
  expect(stdout).not.toContain(OTHER)
}

const env = {CLOUDFLARE_ACCOUNT_ID: ACCOUNT}
const stderrRule = (command: string): WranglerRule => ({command, exitCode: 1, stderr: said})

describe('the account ID, in what monocf forwards from wrangler (WP6-10)', () => {
  it('stays out of apply, with several workers at once', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})

    const result = await applyPlan(fixture, {}, {env, rules: [stderrRule('deploy')]})

    expect(result.exitCode).toBe(1)
    clean(result)
    expect(result.stderr).toContain('/accounts/<account>/workers/services')
    expect(result.stderr).toContain('Your account is <account>, as ever.')
  })

  it("stays out of apply's own events under --json", async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})

    const result = await applyPlan(fixture, {}, {env, flags: ['--json'], rules: [stderrRule('deploy')]})

    clean(result)
  })

  it('stays out of a command running alone, whose output is not a terminal here, as in CI', async () => {
    const fixture = createFixture({environments: ['staging'], workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['deploy', 'orders', '-e', 'staging'], {env, rules: [{command: 'deploy', exitCode: 1, stderr: said, stdout: said}]})

    expect(result.exitCode).toBe(1)
    clean(result)
    expect(result.stderr).toContain('/accounts/<account>/workers/services')
    expect(result.stdout).not.toContain('Your account')
  })

  describe('on a terminal (R12)', () => {
    const preload = join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'stderr-is-a-tty.cjs')
    const onTerminal = {...env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`}
    const run = async (extra: Record<string, string>) => {
      const fixture = createFixture({environments: ['staging'], workers: [{name: 'orders'}]})
      return runCli(fixture, ['deploy', 'orders', '-e', 'staging'], {env: {...onTerminal, ...extra}, rules: [{command: 'deploy', exitCode: 1, stderr: said}]})
    }

    it('stays out when CI is set, as a CI can allocate a pty', async () => {
      const result = await run({CI: 'true'})

      expect(result.exitCode).toBe(1)
      clean(result)
      expect(result.stderr).toContain('/accounts/<account>/workers/services')
    })

    it("reaches a person's own terminal as wrangler wrote it, so its colours and prompts stay", async () => {
      const result = await run({CI: ''})

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(`/accounts/${OTHER}/workers/services`)
    })
  })

  it('stays out of a capture, on what passes through', async () => {
    const fixture = createFixture({environments: ['staging'], files: {'workers/orders/.dev.vars.staging': 'TOKEN=abc\n'}, workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders', '-e', 'staging'], {env, rules: [{command: 'deployments status', exitCode: 1, stderr: said}]})

    expect(result.exitCode).not.toBe(0)
    clean(result)
  })

  it('leaves other 32-character hex alone, as it may be a version or a key', async () => {
    const fixture = createFixture({environments: ['staging'], workers: [{name: 'orders'}]})
    const digest = 'fedcba9876543210fedcba9876543210'

    const result = await runCli(fixture, ['build', 'orders', '-e', 'staging'], {env, rules: [{command: 'deploy', exitCode: 1, stderr: `The hash is ${digest}.\n`}]})

    expect(result.stderr).toContain(digest)
  })
})
