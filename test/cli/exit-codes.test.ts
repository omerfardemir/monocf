import {describe, expect, it} from 'vitest'

import {applyPlan, deployFixture, firstRun, lastRunRecord, newCode, planFor} from '../helpers/deploy-fixtures.js'
import {createFixture, deployedNames, runCli} from '../helpers/harness.js'

const isWindows = process.platform === 'win32'
const workers = [{name: 'billing'}, {name: 'orders'}]

describe('exit codes', () => {
  it('exits 0 when wrangler succeeds', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'])

    expect(result.exitCode).toBe(0)
  })

  it('exits 1 when wrangler fails, and names its exit code', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'], {
      rules: [{command: 'deploy', exitCode: 7}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('exit code 7')
  })

  // Windows has no signals: killing a process ends it with a plain non-zero exit code.
  it('fails when wrangler is killed by a signal', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'], {
      rules: [{command: 'deploy', signal: 'SIGKILL'}],
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode).not.toBeNull()
    if (!isWindows) {
      expect(result.exitCode).toBe(128 + 9)
      expect(result.stderr).toContain('SIGKILL')
    }
  })

  it.skipIf(isWindows)('exits 128 + signal number for SIGTERM too', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'], {
      rules: [{command: 'deploy', signal: 'SIGTERM'}],
    })

    expect(result.exitCode).toBe(128 + 15)
  })

  it('stops a bulk deploy at a killed worker', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'deploy'], {
      rules: [{command: 'deploy', signal: 'SIGKILL', worker: 'billing'}],
    })

    expect(result.exitCode).not.toBe(0)
    const names = deployedNames(result.calls, 'deploy')
    expect(names[0]).toBe('billing-v1')
    // On Windows a kill looks like exit 1, which is an ordinary failure, so independent workers carry on.
    if (!isWindows) expect(names).toEqual(['billing-v1'])
  })

  it.skipIf(isWindows)('apply exits 128 + n when a wrangler is killed from outside, and records the step as cancelled', async () => {
    const fixture = deployFixture({workers: [{name: 'billing'}]})
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})

    const result = await applyPlan(fixture, cloudflare, {rules: [{command: 'versions upload', signal: 'SIGKILL'}]})

    expect(result.exitCode).toBe(128 + 9)
    expect(lastRunRecord(fixture).workers.billing.result).toBe('cancelled')
  })

  it.skipIf(isWindows)('rollback exits 128 + n when a wrangler is killed from outside', async () => {
    const fixture = deployFixture({workers: [{name: 'billing'}]})
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})
    const applied = await applyPlan(fixture, cloudflare)
    const runId = lastRunRecord(fixture).runId as string

    const result = await runCli(fixture, ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', runId], {
      cloudflare: applied.cloudflare!,
      rules: [{command: 'versions deploy', signal: 'SIGTERM'}],
    })

    expect(result.exitCode).toBe(128 + 15)
  })

  it('fails when wrangler whoami fails', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['whoami'], {rules: [{command: 'whoami', exitCode: 4}]})

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('exit code 4')
  })

  it('parses output written after wrangler has exited, by a process that still holds the pipe', async () => {
    const fixture = createFixture({workers})
    const versions = JSON.stringify([{id: 'version-written-late'}])

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f'], {
      rules: [{command: 'versions list', stdoutAfterExit: versions}],
    })

    expect(result.exitCode).toBe(0)
    expect(result.calls.find((call) => call.argv[1] === 'deploy')?.argv).toContain('version-written-late@100%')
  })

  describe('versions list in deploy -f', () => {
    it('fails when listing versions fails', async () => {
      const fixture = createFixture({workers})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f'], {
        rules: [{command: 'versions list', exitCode: 5}],
      })

      expect(result.exitCode).toBe(1)
      expect(result.calls.map((call) => call.argv.slice(0, 2).join(' '))).toEqual(['versions list'])
    })

    it('fails when listing versions is killed', async () => {
      const fixture = createFixture({workers})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f'], {
        rules: [{command: 'versions list', signal: 'SIGKILL'}],
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.calls.map((call) => call.argv.slice(0, 2).join(' '))).toEqual(['versions list'])
    })

    it('reads output larger than one pipe chunk', async () => {
      const fixture = createFixture({workers})
      const versions = Array.from({length: 2000}, (_, index) => ({
        annotations: [],
        id: `version-${index}`,
        metadata: {},
        number: index,
      }))

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f'], {
        rules: [{command: 'versions list', stdout: JSON.stringify(versions)}],
      })

      expect(result.exitCode).toBe(0)
      const deploy = result.calls.find((call) => call.argv[1] === 'deploy')
      expect(deploy?.argv).toContain('version-1999@100%')
    })
  })
})
