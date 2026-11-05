import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {
  argvWithoutConfig,
  createFixture,
  deployedNames,
  effectiveConfig,
  flagValue,
  fromRoot,
  runCli,
  type WranglerCall,
} from '../helpers/harness.js'

const environments = ['staging', 'production']

function vars(call: WranglerCall): Record<string, unknown> {
  return effectiveConfig(call).vars
}

function mergedConfig(base: Record<string, unknown>, worker: Record<string, unknown>) {
  const fixture = createFixture({base, workers: [{config: worker, name: 'orders'}]})
  return runCli(fixture, ['worker', 'orders', '-c', 'deploy']).then((result) => {
    expect(result.exitCode).toBe(0)
    return result.calls[0].config!
  })
}

describe('single worker', () => {
  const options = {environments, workers: [{name: 'orders', version: '1.4.0'}]}

  it('build runs a dry-run deploy into the worker dist directory', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'build', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(1)
    const [call] = result.calls
    expect(call.argv.slice(0, 2)).toEqual(['deploy', '--dry-run'])
    expect(fromRoot(fixture, flagValue(call, '--outdir')!)).toBe('workers/orders/dist')
    expect(flagValue(call, '--env')).toBe('staging')
    expect(effectiveConfig(call).name).toBe('orders-v1-staging')
    expect(existsSync(join(fixture.worker('orders'), 'dist', 'index.js'))).toBe(true)
  })

  it('build writes no config next to the bundle (F39)', async () => {
    const fixture = createFixture(options)

    await runCli(fixture, ['worker', 'orders', '-c', 'build'])

    expect(existsSync(join(fixture.worker('orders'), 'dist', 'wrangler.jsonc'))).toBe(false)
  })

  it('build passes --minify only with -m', async () => {
    const fixture = createFixture(options)

    const plain = await runCli(fixture, ['worker', 'orders', '-c', 'build'])
    const minified = await runCli(fixture, ['worker', 'orders', '-c', 'build', '-m'])

    expect(plain.calls[0].argv).not.toContain('--minify')
    expect(minified.calls[0].argv).toContain('--minify')
  })

  it('deploy runs wrangler deploy with the env flag', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'production'])

    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(1)
    expect(argvWithoutConfig(result.calls[0])).toEqual(['deploy', '--env', 'production'])
    expect(effectiveConfig(result.calls[0]).name).toBe('orders-v1-production')
  })

  it('deploy without an env uses the plain name', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'])

    expect(argvWithoutConfig(result.calls[0])).toEqual(['deploy'])
    expect(result.calls[0].config?.name).toBe('orders-v1')
  })

  it('preview uploads a version', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'preview', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    expect(argvWithoutConfig(result.calls[0])).toEqual(['versions', 'upload', '--env', 'staging'])
    expect(effectiveConfig(result.calls[0]).name).toBe('orders-v1-staging')
  })

  it('dev runs wrangler dev', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    expect(argvWithoutConfig(result.calls[0])).toEqual(['dev', '--env', 'staging'])
    expect(effectiveConfig(result.calls[0]).name).toBe('orders-v1-staging')
  })

  it.each([
    ['build', 'deploy'],
    ['deploy', 'deploy'],
    ['preview', 'versions'],
    ['dev', 'dev'],
  ])('%s injects NAME, ENVIRONMENT and VERSION', async (command, subcommand) => {
    const fixture = createFixture(options)

    const withEnv = await runCli(fixture, ['worker', 'orders', '-c', command, '-e', 'staging'])
    const withoutEnv = await runCli(fixture, ['worker', 'orders', '-c', command])

    expect(withEnv.calls[0].argv[0]).toBe(subcommand)
    expect(vars(withEnv.calls[0])).toMatchObject({ENVIRONMENT: 'staging', NAME: 'orders-v1', VERSION: '1.4.0'})
    expect(vars(withoutEnv.calls[0])).toMatchObject({ENVIRONMENT: 'dev', NAME: 'orders-v1', VERSION: '1.4.0'})
  })

  it('infers the worker from the current directory', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['worker', '-c', 'deploy'], {cwd: 'workers/orders/src'})

    expect(result.exitCode).toBe(0)
    expect(deployedNames(result.calls, 'deploy')).toEqual(['orders-v1'])
  })

  it('leaves no temp config in the source tree after a run', async () => {
    const fixture = createFixture(options)

    await runCli(fixture, ['worker', 'orders', '-c', 'deploy'])

    expect(existsSync(join(fixture.worker('orders'), '.temp.wrangler.jsonc'))).toBe(false)
    expect(existsSync(join(fixture.worker('orders'), '.temp.base.wrangler.jsonc'))).toBe(false)
  })
})

describe('whoami', () => {
  it('runs wrangler whoami', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['whoami'])

    expect(result.calls.map((call) => call.argv)).toEqual([['whoami']])
  })
})

describe('-a', () => {
  it('runs every worker that is not ignored', async () => {
    const fixture = createFixture({
      ignore: ['gateway'],
      workers: [{name: 'billing'}, {name: 'gateway'}, {name: 'orders'}],
    })

    const deploy = await runCli(fixture, ['worker', '-a', '-c', 'deploy'])
    const build = await runCli(fixture, ['worker', '-a', '-c', 'build'])
    const preview = await runCli(fixture, ['worker', '-a', '-c', 'preview'])

    expect(deploy.exitCode).toBe(0)
    expect(deployedNames(deploy.calls, 'deploy')).toEqual(['billing-v1', 'orders-v1'])
    expect(build.exitCode).toBe(0)
    expect(deployedNames(build.calls, 'deploy')).toEqual(['billing-v1', 'orders-v1'])
    expect(preview.exitCode).toBe(0)
    expect(deployedNames(preview.calls, 'versions upload')).toEqual(['billing-v1', 'orders-v1'])
  })

  it('ignores workers by path and by glob', async () => {
    const fixture = createFixture({
      ignore: ['workers/gateway', '**/exp-*'],
      workers: [{name: 'exp-one'}, {name: 'gateway'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', '-a', '-c', 'deploy'])

    expect(deployedNames(result.calls, 'deploy')).toEqual(['orders-v1'])
  })

  it('dev starts every worker and then a proxy on the requested port', async () => {
    const fixture = createFixture({workers: [{name: 'billing'}, {name: 'orders'}]})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev', '-p', '8123'])

    expect(result.exitCode).toBe(0)
    const names = result.calls.map((call) => call.config?.name).sort()
    expect(names).toEqual(['billing-v1', 'orders-v1', 'proxy-worker'])
    const proxy = result.calls.find((call) => call.config?.name === 'proxy-worker')
    expect(flagValue(proxy!, '--port')).toBe('8123')
  })
})

describe('-d', () => {
  it('deploys bindings before the worker, each once', async () => {
    const fixture = createFixture({
      workers: [
        {bindings: ['billing', 'orders'], name: 'gateway'},
        {bindings: ['billing'], name: 'orders'},
        {name: 'billing'},
      ],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-d'])

    expect(result.exitCode).toBe(0)
    expect(deployedNames(result.calls, 'deploy')).toEqual(['billing-v1', 'orders-v1', 'gateway-v1'])
  })

  it('does not deploy bindings without -d', async () => {
    const fixture = createFixture({workers: [{bindings: ['orders'], name: 'gateway'}, {name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy'])

    expect(deployedNames(result.calls, 'deploy')).toEqual(['gateway-v1'])
  })

  it('follows bindings set in monocf.config.json', async () => {
    const fixture = createFixture({
      monocfConfig: {deployBindings: true},
      workers: [{bindings: ['orders'], name: 'gateway'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy'])

    expect(deployedNames(result.calls, 'deploy')).toEqual(['orders-v1', 'gateway-v1'])
  })

  it('handles a binding cycle on deploy', async () => {
    const fixture = createFixture({
      workers: [
        {bindings: ['orders'], name: 'gateway'},
        {bindings: ['gateway'], name: 'orders'},
      ],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-d'])

    expect(result.exitCode).toBe(0)
    expect(deployedNames(result.calls, 'deploy').sort()).toEqual(['gateway-v1', 'orders-v1'])
  })
})

describe('service bindings', () => {
  const options = {
    environments,
    workers: [
      {
        bindings: ['orders'],
        envBindings: {production: ['orders'], staging: ['orders']},
        name: 'gateway',
      },
      {name: 'orders'},
    ],
  }

  it('deploy points bindings at the deployed name of the env', async () => {
    const fixture = createFixture(options)

    const staging = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-e', 'staging'])
    const production = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-e', 'production'])

    expect(effectiveConfig(staging.calls[0]).services).toEqual([{binding: 'ORDERS', service: 'orders-v1-staging'}])
    expect(effectiveConfig(production.calls[0]).services).toEqual([
      {binding: 'ORDERS', service: 'orders-v1-production'},
    ])
  })

  it('deploy without an env points bindings at the plain deployed name', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy'])

    expect(effectiveConfig(result.calls[0]).services).toEqual([{binding: 'ORDERS', service: 'orders-v1'}])
  })

  it('preview points bindings at the deployed name of the env', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'preview', '-e', 'staging'])

    expect(effectiveConfig(result.calls[0]).services).toEqual([{binding: 'ORDERS', service: 'orders-v1-staging'}])
  })

  it('keeps entrypoints on rewritten bindings', async () => {
    const fixture = createFixture({
      workers: [
        {
          config: {services: [{binding: 'ORDERS', entrypoint: 'Api', service: 'orders'}]},
          name: 'gateway',
        },
        {name: 'orders'},
      ],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'build'])

    expect(effectiveConfig(result.calls[0]).services).toEqual([
      {binding: 'ORDERS', entrypoint: 'Api', service: 'orders-v1'},
    ])
  })

  it.each(['build', 'dev'])('%s points bindings at the deployed name of the env', async (command) => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['worker', 'gateway', '-c', command, '-e', 'staging'])

    expect(effectiveConfig(result.calls[0]).services).toEqual([{binding: 'ORDERS', service: 'orders-v1-staging'}])
  })

  it('dev passes the config of every transitive binding to wrangler', async () => {
    const fixture = createFixture({
      workers: [{bindings: ['orders'], name: 'gateway'}, {bindings: ['billing'], name: 'orders'}, {name: 'billing'}],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'dev'])

    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0].configs.map((config) => config.name)).toEqual(['gateway-v1', 'billing-v1', 'orders-v1'])
  })
})

describe('merging base and worker config', () => {
  it('concatenates arrays, base first', async () => {
    const config = await mergedConfig({compatibility_flags: ['from_base']}, {compatibility_flags: ['from_worker']})

    expect(config.compatibility_flags).toEqual(['from_base', 'from_worker'])
  })

  it('merges nested objects', async () => {
    const config = await mergedConfig(
      {observability: {enabled: true, logs: {invocation_logs: true}}},
      {observability: {head_sampling_rate: 1, logs: {enabled: true}}},
    )

    expect(config.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      logs: {enabled: true, invocation_logs: true},
    })
  })

  it('lets the scalars of the worker win', async () => {
    const config = await mergedConfig({compatibility_date: '2025-01-09'}, {compatibility_date: '2025-06-01'})

    expect(config.compatibility_date).toBe('2025-06-01')
  })

  it('drops empty arrays and objects', async () => {
    const config = await mergedConfig({observability: {enabled: true}}, {kv_namespaces: [], limits: {}})

    expect(config).not.toHaveProperty('kv_namespaces')
    expect(config).not.toHaveProperty('limits')
    expect(config.observability).toEqual({enabled: true})
  })

  it('resolves placeholders from variables and the worker name', async () => {
    const config = await mergedConfig({vars: {API_URL: 'https://example.com/{version}/{workerName}'}}, {})

    expect(config.name).toBe('orders-v1')
    expect(config.vars.API_URL).toBe('https://example.com/v1/orders')
  })

  it('merges env sections from base and worker', async () => {
    const fixture = createFixture({
      base: {env: {staging: {vars: {FROM_BASE: '1'}}}},
      workers: [{config: {env: {staging: {vars: {FROM_WORKER: '2'}}}}, name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'staging'])

    expect(vars(result.calls[0])).toMatchObject({FROM_BASE: '1', FROM_WORKER: '2'})
  })
})
