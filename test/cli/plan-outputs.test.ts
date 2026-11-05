import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli, type Fixture} from '../helpers/harness.js'

function project(): Fixture {
  const fixture = createFixture({environments: ['staging'], workers: [{name: 'orders'}]})
  mkdirSync(join(fixture.root, 'state', 'staging'), {recursive: true})
  return fixture
}

const outputs = ['--out', 'old-plan.json', '--markdown', 'old-plan.md']

describe('--markdown inside something wrangler uploads', () => {
  it.each([
    ['assets', {assets: {directory: './public'}}, 'workers/billing/public/plan.md'],
    ['a directory under assets', {assets: {directory: './public'}}, 'workers/billing/public/reports/plan.md'],
    ['a site', {site: {bucket: './site'}}, 'workers/billing/site/plan.md'],
  ])('refuses a path in %s, with nothing read from Cloudflare', async (_, config, markdown) => {
    const fixture = createFixture({
      environments: ['staging'],
      files: {'workers/billing/public/index.html': 'x', 'workers/billing/site/index.html': 'x'},
      workers: [{config, name: 'billing'}],
    })
    mkdirSync(join(fixture.root, 'state', 'staging'), {recursive: true})

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--markdown', markdown], {cloudflare: {}, noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/--markdown .*plan\.md is inside .*, which billing uploads/)
    expect(result.calls).toEqual([])
  })

  it('takes a path beside them', async () => {
    const fixture = createFixture({environments: ['staging'], files: {'workers/billing/public/index.html': 'x'}, workers: [{config: {assets: {directory: './public'}}, name: 'billing'}]})
    mkdirSync(join(fixture.root, 'state', 'staging'), {recursive: true})

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--markdown', 'workers/billing/plan.md'], {cloudflare: {}})

    expect(result.exitCode, result.stderr).toBe(0)
  })
})

function withOldOutputs(fixture: Fixture): void {
  writeFileSync(join(fixture.root, 'old-plan.json'), 'old')
  writeFileSync(join(fixture.root, 'old-plan.md'), 'old')
}

function expectOldOutputsGone(fixture: Fixture): void {
  expect(existsSync(join(fixture.root, 'old-plan.json'))).toBe(false)
  expect(existsSync(join(fixture.root, 'old-plan.md'))).toBe(false)
}

describe('a failed plan leaves no older plan or markdown', () => {
  it('after a check error', async () => {
    const fixture = project()
    writeFileSync(join(fixture.worker('orders'), 'wrangler.jsonc'), JSON.stringify({main: 'src/gone.ts'}))
    withOldOutputs(fixture)

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', ...outputs], {noCalls: true})

    expect(result.exitCode).toBe(2)
    expectOldOutputsGone(fixture)
  })

  it('after a state URL that is not supported', async () => {
    const fixture = project()
    withOldOutputs(fixture)

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'nope:state', ...outputs], {noCalls: true})

    expect(result.exitCode).toBe(2)
    expectOldOutputsGone(fixture)
  })

  it('after a project config that cannot be read', async () => {
    const fixture = project()
    writeFileSync(join(fixture.root, 'monocf.config.json'), '{nope')
    withOldOutputs(fixture)

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', ...outputs], {noCalls: true})

    expect(result.exitCode).not.toBe(0)
    expectOldOutputsGone(fixture)
  })

  it('after a state directory that is missing', async () => {
    const fixture = project()
    withOldOutputs(fixture)

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:nowhere', ...outputs], {cloudflare: {}})

    expect(result.exitCode).toBe(3)
    expectOldOutputsGone(fixture)
  })

  it('after a read that fails', async () => {
    const fixture = project()
    withOldOutputs(fixture)

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', ...outputs], {
      cloudflare: {},
      rules: [{command: 'deployments status', exitCode: 1, stderr: 'nope\n'}],
    })

    expect(result.exitCode).toBe(1)
    expectOldOutputsGone(fixture)
  })
})

describe('where a plan writes', () => {
  it('creates the parent of the markdown', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--markdown', 'a/new/dir/plan.md'], {cloudflare: {}})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(readFileSync(join(fixture.root, 'a', 'new', 'dir', 'plan.md'), 'utf8')).toContain('monocf plan')
  })

  it('gives exit 3 for a markdown path it cannot write, and no plan', async () => {
    const fixture = project()
    writeFileSync(join(fixture.root, 'in-the-way'), 'a file')

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--out', 'plan.json', '--markdown', 'in-the-way/plan.md'], {cloudflare: {}, noCalls: true})

    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain("Can't write")
    expect(existsSync(join(fixture.root, 'plan.json'))).toBe(false)
  })

  // Nothing is in the way of removing an older one here, so this is the write itself failing. Root writes anywhere.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('gives exit 3 when the markdown cannot be created, and no plan', async () => {
    const fixture = project()
    const locked = join(fixture.root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)

    try {
      const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--out', 'plan.json', '--markdown', 'locked/plan.md'], {cloudflare: {}})

      expect(result.exitCode).toBe(3)
      expect(result.stderr).toContain("Can't write")
      expect(existsSync(join(fixture.root, 'plan.json'))).toBe(false)
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('gives exit 3 for an output that is a directory', async () => {
    const fixture = project()
    mkdirSync(join(fixture.root, 'adir'))

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'adir'], {noCalls: true})

    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain("Can't write")
  })
})
