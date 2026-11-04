import {existsSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {argvWithoutConfig, createFixture, flagValue, fromRoot, runCli} from '../helpers/harness.js'

const metacharacters = 'message; with spaces & metachars | $(touch pwned) `touch pwned` > pwned'

describe('spawning wrangler', () => {
  it('uses the wrangler installed in the project', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['whoami'])

    expect(result.exitCode).toBe(0)
    expect(result.calls.map((call) => call.argv)).toEqual([['whoami']])
    expect(result.stdout).toContain('fake-user')
  })

  it('resolves wrangler from the project root when run inside a worker directory', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', '-c', 'build'], {cwd: 'workers/orders'})

    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(1)
    expect(fromRoot(fixture, result.calls[0].cwd)).toBe('workers/orders')
  })

  it('falls back to its own wrangler when the project has none', async () => {
    const fixture = createFixture({fakeWrangler: false, workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([])
    expect(statSync(join(fixture.worker('orders'), 'dist', 'index.js')).size).toBeGreaterThan(0)
  })

  it('passes a message with spaces and shell metacharacters as one argument', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f', '-M', metacharacters])

    expect(result.exitCode).toBe(0)
    const deploy = result.calls.find((call) => call.argv[1] === 'deploy')
    expect(deploy && flagValue(deploy, '--message')).toBe(metacharacters)
    expect(existsSync(join(fixture.root, 'pwned'))).toBe(false)
  })

  it('splits subcommands into separate arguments', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'preview'])

    expect(result.exitCode).toBe(0)
    expect(argvWithoutConfig(result.calls[0])).toEqual(['versions', 'upload'])
  })

  it('splits every dev -a argument, including the proxy worker', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'])

    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(2)
    for (const call of result.calls) {
      expect(call.argv[0]).toBe('dev')
      expect(call.argv.filter((arg) => arg.includes(' '))).toEqual([])
      expect(call.config).not.toBeNull()
      expect(Number(flagValue(call, '--port'))).toBeGreaterThan(0)
      expect(Number(flagValue(call, '--inspector-port'))).toBeGreaterThan(0)
    }
  })

  describe('in a project path with a space', () => {
    const options = {parentDirName: 'dir with space', workers: [{name: 'orders'}]}

    it('runs build', async () => {
      const fixture = createFixture(options)

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'])

      expect(result.exitCode).toBe(0)
      expect(result.calls[0].config?.name).toBe('orders-v1')
      expect(readFileSync(join(fixture.worker('orders'), 'dist', 'index.js'), 'utf8')).toContain('orders-v1')
    })

    it('runs dev -a and keeps paths in one argument', async () => {
      const fixture = createFixture(options)

      const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'])

      expect(result.exitCode).toBe(0)
      expect(result.calls).toHaveLength(2)
      for (const call of result.calls) {
        expect(flagValue(call, '--persist-to')).toContain('dir with space')
        expect(flagValue(call, '--config')).toContain('dir with space')
      }
    })

    it('builds with the real wrangler', async () => {
      const fixture = createFixture({...options, fakeWrangler: false})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'])

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(statSync(join(fixture.worker('orders'), 'dist', 'index.js')).size).toBeGreaterThan(0)
    })
  })
})
