import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli, type Fixture} from '../helpers/harness.js'

const example = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'basic')

function project(): Fixture {
  const fixture = createFixture({base: false, wrangler: 'real', workers: []})
  for (const file of readdirSync(example, {recursive: true}) as string[]) {
    const target = join(fixture.root, file)
    if (statSync(join(example, file)).isDirectory()) mkdirSync(target, {recursive: true})
    else writeFileSync(target, readFileSync(join(example, file)))
  }

  return fixture
}

describe('examples/basic', {timeout: 180_000}, () => {
  it('graph shows the binding, callee first', async () => {
    const result = await runCli(project(), ['graph', '-e', 'staging', '--json'], {noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    const graph = JSON.parse(result.stdout)
    expect(graph.levels).toEqual([['orders'], ['gateway']])
    expect(graph.edges).toMatchObject([{binding: 'ORDERS', from: 'gateway', kind: 'services', to: 'orders'}])
  })

  it('check finds nothing in any env, even with --strict', async () => {
    const result = await runCli(project(), ['check', '--all-envs', '--strict'], {noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
  })

  it('bundle builds both with real wrangler, with the binding and the placeholder filled in', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['bundle', '-e', 'staging'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('env.ORDERS (orders-staging)')
    expect(result.stderr).toContain('env.GREETING ("hello from staging")')
    const manifestPath = join(fixture.root, '.monocf', 'bundle', 'staging', 'manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    const {workers} = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(Object.keys(workers).sort()).toEqual(['gateway', 'orders'])
    expect(workers.gateway.deployedName).toBe('gateway-staging')
  })

  it('names no account', () => {
    for (const file of ['base.wrangler.jsonc', 'workers/orders/wrangler.jsonc', 'workers/gateway/wrangler.jsonc']) {
      expect(readFileSync(join(example, file), 'utf8')).not.toContain('account_id')
    }
  })
})
