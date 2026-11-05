import {execFileSync} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli, type CliResult, type Fixture, type WranglerCall} from '../helpers/harness.js'

function project(): Fixture {
  const fixture = createFixture({environments: ['staging'], files: {'other.jsonc': JSON.stringify({compatibility_date: '2024-02-02', env: {staging: {}}, main: 'src/index.ts', name: '{workerName}-{version}'})}, workers: [{name: 'orders'}]})
  mkdirSync(join(fixture.root, 'state'))
  return fixture
}

const plan = ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--bundle-dir', join('.monocf', 'bundle', 'staging')]
const built = (calls: WranglerCall[]) => calls.filter(({argv}) => argv.includes('--dry-run')).length

function commit(fixture: Fixture): void {
  execFileSync('git', ['add', '.'], {cwd: fixture.root})
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'next'], {cwd: fixture.root})
}

async function bundled(fixture: Fixture, env: Record<string, string> = {}): Promise<CliResult> {
  const result = await runCli(fixture, ['bundle', '-e', 'staging'], {env})
  expect(result.exitCode, result.stderr).toBe(0)
  return result
}

describe('plan --bundle-dir', () => {
  it.each(['configHash', 'doHash', 'triggersHash'])('bundles again when %s is not what this config gives', async (field) => {
    const fixture = project()
    await bundled(fixture)
    const path = join(fixture.root, '.monocf', 'bundle', 'staging', 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    manifest.workers.orders[field] = 'something-else'
    writeFileSync(path, JSON.stringify(manifest))

    const result = await runCli(fixture, plan, {cloudflare: {}})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(built(result.calls)).toBe(1)
  })

  it('reuses a bundle of this very checkout', async () => {
    const fixture = project()
    await bundled(fixture)

    const result = await runCli(fixture, plan, {cloudflare: {}})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(built(result.calls)).toBe(0)
  })

  it('does not count its own directory as a change in the checkout', async () => {
    const fixture = project()
    const out = await runCli(fixture, ['bundle', '-e', 'staging', '--out', 'built'])
    expect(out.exitCode, out.stderr).toBe(0)

    const again = await runCli(fixture, ['bundle', '-e', 'staging', '--out', 'built'])
    expect(again.exitCode, again.stderr).toBe(0)
    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--bundle-dir', 'built'], {cloudflare: {}})

    expect(built(result.calls)).toBe(0)
  })

  it('builds again after a code edit with nothing committed', async () => {
    const fixture = project()
    await bundled(fixture)
    writeFileSync(join(fixture.worker('orders'), 'src', 'index.ts'), 'export default {}\n')

    const result = await runCli(fixture, plan, {cloudflare: {}})

    expect(built(result.calls)).toBe(1)
    expect(result.stderr).toContain('this checkout has changes')
  })

  it('builds again after a config edit with nothing committed', async () => {
    const fixture = project()
    await bundled(fixture)
    writeFileSync(join(fixture.worker('orders'), 'wrangler.jsonc'), JSON.stringify({triggers: {crons: ['0 0 * * *']}}))

    const result = await runCli(fixture, plan, {cloudflare: {}})

    expect(built(result.calls)).toBe(1)
  })

  it('builds again with another base config at the same commit', async () => {
    const fixture = project()
    await bundled(fixture)

    const result = await runCli(fixture, [...plan, '--base-config', 'other.jsonc'], {cloudflare: {}})

    expect(built(result.calls)).toBe(1)
    expect(result.stderr).toContain("doesn't describe orders")
  })

  it('builds again when the bundle came from a dirty tree', async () => {
    const fixture = project()
    writeFileSync(join(fixture.worker('orders'), 'src', 'index.ts'), 'export default {}\n')
    await bundled(fixture)

    const result = await runCli(fixture, plan, {cloudflare: {}})

    expect(built(result.calls)).toBe(1)
    expect(result.stderr).toContain('its checkout had changes')
  })

  it('builds again when GITHUB_SHA stayed and the checkout moved on', async () => {
    const fixture = project()
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: fixture.root, encoding: 'utf8'}).trim()
    await bundled(fixture, {GITHUB_SHA: sha})
    writeFileSync(join(fixture.worker('orders'), 'src', 'index.ts'), 'export default {}\n')
    commit(fixture)

    const result = await runCli(fixture, plan, {cloudflare: {}, env: {GITHUB_SHA: sha}})

    expect(built(result.calls)).toBe(1)
    expect(result.stderr).toContain('another commit was checked out')
  })
})
