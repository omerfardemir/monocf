import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {parse} from 'jsonc-parser'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli} from '../helpers/harness.js'

describe('worker create', () => {
  it('writes a minimal worker, with no network and no install', async () => {
    const fixture = createFixture({base: false, monocfConfig: {baseConfig: undefined}, workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'create', 'billing'], {noCalls: true})

    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([])
    const dir = fixture.worker('billing')
    expect(parse(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8'))).toMatchObject({
      main: 'src/index.ts',
      name: 'billing',
    })
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name).toBe('billing')
    expect(existsSync(join(dir, 'src', 'index.ts'))).toBe(true)
    expect(existsSync(join(dir, 'tsconfig.json'))).toBe(true)
    expect(existsSync(join(dir, 'node_modules'))).toBe(false)
    expect(result.stderr).toContain('Install')
  })

  it('leaves the name and dates to the base config when there is one', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    await runCli(fixture, ['worker', 'create', 'billing'], {noCalls: true})

    expect(parse(readFileSync(join(fixture.worker('billing'), 'wrangler.jsonc'), 'utf8'))).toEqual({main: 'src/index.ts'})
  })

  it('makes a worker the other commands accept', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    await runCli(fixture, ['worker', 'create', 'billing'], {noCalls: true})
    const result = await runCli(fixture, ['worker', 'billing', '-c', 'deploy'])

    expect(result.exitCode).toBe(0)
    expect(result.calls[0].config?.name).toBe('billing-v1')
    expect(result.calls[0].mainSource).toContain('Hello')
  })

  it('adds .wrangler and .monocf to the root .gitignore, once', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})
    const path = join(fixture.root, '.gitignore')
    writeFileSync(path, 'node_modules\n.wrangler')

    await runCli(fixture, ['worker', 'create', 'billing'], {noCalls: true})
    await runCli(fixture, ['worker', 'create', 'gateway'], {noCalls: true})

    expect(readFileSync(path, 'utf8')).toBe('node_modules\n.wrangler\n.monocf\n')
  })

  it('creates the .gitignore when there is none', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})
    rmSync(join(fixture.root, '.gitignore'))

    await runCli(fixture, ['worker', 'create', 'billing'], {noCalls: true})

    expect(readFileSync(join(fixture.root, '.gitignore'), 'utf8')).toBe('.wrangler\n.monocf\n')
  })

  it.each(['Billing', 'bill_ing', '../billing', '-billing', 'bill ing'])('rejects the name %s', async (name) => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'create', '--', name], {noCalls: true})

    expect(result.exitCode).toBe(2)
  })

  it('does not write over a worker that exists', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'create', 'orders'], {noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('already exists')
    expect(readFileSync(join(fixture.worker('orders'), 'src', 'index.ts'), 'utf8')).toContain("Response('orders')")
  })

  it('creates the workers directory when it does not exist', async () => {
    const fixture = createFixture({monocfConfig: {workersDirName: 'services'}, workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'create', 'billing'], {noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(existsSync(join(fixture.root, 'services', 'billing', 'wrangler.jsonc'))).toBe(true)
  })

  it('fails when the root directory does not exist', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'create', 'billing', '--root-dir', 'missing'], {noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("doesn't exist")
  })

  it.each([
    ['--root-dir', '--workers-dir-name'],
    ['--rootDir', '--workersDirName'],
    ['-r', '-w'],
  ])('takes %s and %s', async (root, workers) => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'create', 'billing', root, fixture.root, workers, 'apps'], {cwd: 'workers', noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(existsSync(join(fixture.root, 'apps', 'billing', 'wrangler.jsonc'))).toBe(true)
  })
})
