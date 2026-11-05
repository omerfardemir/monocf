import {existsSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {argvWithoutConfig, createFixture, flagValue, fromRoot, runCli} from '../helpers/harness.js'

const metacharacters = 'message; with spaces & metachars | $(touch pwned) `touch pwned` > pwned'

const wranglerFile = (root: string, path: string) => join(root, 'node_modules', 'wrangler', path)

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
    expect(fromRoot(fixture, result.calls[0].cwd)).toMatch(/^\.monocf\/runs\/[\da-f]+\/orders$/)
  })

  describe('without a usable wrangler in the project (R3)', () => {
    it('exits 3 when the project has none, with no fallback to the one monocf was installed with', async () => {
      const fixture = createFixture({wrangler: 'none', workers: [{name: 'orders'}]})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'])

      expect(result.exitCode).toBe(3)
      expect(result.stderr).toContain('wrangler')
      expect(existsSync(join(fixture.worker('orders'), 'dist'))).toBe(false)
    })

    it.each([
      ['a corrupt package.json', '{ not json', 'package.json'],
      ['an exports map without package.json', JSON.stringify({exports: {'.': './x.js'}, name: 'wrangler'}), 'package.json'],
      ['a version below the floor', JSON.stringify({name: 'wrangler', version: '4.150.0'}), '4.151.0'],
      ['a version that is not one', JSON.stringify({name: 'wrangler', version: 'latest'}), 'version'],
      ['an unsupported Node', JSON.stringify({engines: {node: '>=99.0.0'}, name: 'wrangler', version: '4.151.0'}), '99'],
    ])('exits 3 with %s', async (_, content, message) => {
      const fixture = createFixture({workers: [{name: 'orders'}]})
      writeFileSync(wranglerFile(fixture.root, 'package.json'), content)

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'], {noCalls: true})

      expect(result.exitCode).toBe(3)
      expect(result.stderr).toContain(message)
      expect(result.calls).toEqual([])
    })

    it('exits 3 when the entry file is missing', async () => {
      const fixture = createFixture({workers: [{name: 'orders'}]})
      rmSync(wranglerFile(fixture.root, join('wrangler-dist', 'cli.js')))

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'], {noCalls: true})

      expect(result.exitCode).toBe(3)
      expect(result.stderr).toContain('cli.js')
    })

    it('reports a config problem before a wrangler problem', async () => {
      const fixture = createFixture({wrangler: 'none', workers: [{name: 'orders'}]})

      const result = await runCli(fixture, ['worker', 'nope', '-c', 'build'])

      expect(result.exitCode).toBe(2)
    })
  })

  describe('-r (R3)', () => {
    it('takes a relative root and locates wrangler from it', async () => {
      const fixture = createFixture({workers: [{name: 'orders'}]})

      const fromRoot_ = await runCli(fixture, ['worker', 'orders', '-c', 'build', '-r', '.'])
      const fromWorker = await runCli(fixture, ['worker', 'orders', '-c', 'build', '-r', '../..'], {
        cwd: 'workers/orders',
      })

      expect(fromRoot_.exitCode).toBe(0)
      expect(fromWorker.exitCode).toBe(0)
      expect(fromRoot(fixture, flagValue(fromWorker.calls[0], '--outdir')!)).toBe('workers/orders/dist')
    })
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
      const fixture = createFixture({...options, wrangler: 'real'})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'])

      expect(result.exitCode).toBe(0)
      expect(statSync(join(fixture.worker('orders'), 'dist', 'index.js')).size).toBeGreaterThan(0)
    })
  })
})
