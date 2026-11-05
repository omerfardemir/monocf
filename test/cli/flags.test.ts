import {rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {
  argvWithoutConfig,
  createFixture,
  deployedNames,
  effectiveConfig,
  expectConfigFor,
  flagValue,
  releaseOf,
  runCli,
  type CliResult,
  type Fixture,
} from '../helpers/harness.js'

const environments = ['staging', 'production']

function expectUsageError(result: CliResult, message: string): void {
  expect(result.stderr.replaceAll(/\s+/g, ' ')).toContain(message)
  expect(result.exitCode).toBe(2)
  expect(result.calls).toEqual([])
}

function runRejected(fixture: Fixture, args: string[]): Promise<CliResult> {
  return runCli(fixture, args, {noCalls: true})
}

describe('blank flag values (R1, R2)', () => {
  const workers = [{name: 'orders'}]

  it.each([
    ['worker build', ['worker', 'orders', '-c', 'build']],
    ['worker deploy', ['worker', 'orders', '-c', 'deploy']],
    ['worker preview', ['worker', 'orders', '-c', 'preview']],
    ['worker dev', ['worker', 'orders', '-c', 'dev']],
    ['secrets deploy', ['secrets', 'deploy', 'orders']],
  ])('%s rejects -e ""', async (_, args) => {
    const fixture = createFixture({environments, files: {'workers/orders/.dev.vars': 'KEY=1'}, workers})

    expectUsageError(await runRejected(fixture, [...args, '-e', '']), '--env must not be empty')
  })

  it.each([
    ['-M', ['worker', 'orders', '-c', 'deploy', '-M', ''], '--message'],
    ['-r', ['worker', 'orders', '-c', 'deploy', '-r', ''], '--root-dir'],
    ['-w', ['worker', 'orders', '-c', 'deploy', '-w', ''], '--workers-dir-name'],
    ['-b', ['worker', 'orders', '-c', 'deploy', '-b', ''], '--base-config'],
    ['a blank -e', ['worker', 'orders', '-c', 'deploy', '-e', '  '], '--env'],
  ])('rejects an empty %s', async (_, args, flag) => {
    const fixture = createFixture({workers})

    expectUsageError(await runRejected(fixture, args), `${flag} must not be empty`)
  })

  it('-f -F "" fails and never promotes the latest version', async () => {
    const fixture = createFixture({workers})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-f', '-F', ''])

    expectUsageError(result, '--deploy-from-version-id must not be empty')
  })

  it('-F "" without -f fails too', async () => {
    const fixture = createFixture({workers})

    expectUsageError(await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-F', '']), '--deploy-from-version-id')
  })
})

describe('worker names (R4)', () => {
  it.each(['orders/', './orders', '../workers/orders', 'ORDERS', 'Orders'])(
    'rejects %s, which only resembles a directory name',
    async (name) => {
      const fixture = createFixture({workers: [{name: 'orders'}]})

      expectUsageError(await runRejected(fixture, ['worker', name, '-c', 'deploy']), 'Worker not found')
    },
  )

  it.each(['legacy/', './legacy', 'LEGACY'])('%s does not get around .monocfignore', async (name) => {
    const fixture = createFixture({ignore: ['legacy'], workers: [{name: 'legacy'}, {name: 'orders'}]})

    expectUsageError(await runRejected(fixture, ['worker', name, '-c', 'deploy']), 'Worker not found')
    expectUsageError(await runRejected(fixture, ['secrets', 'deploy', name]), 'Worker not found')
  })
})

function project(): Fixture {
  return createFixture({
    base: false,
    files: {
      'workers/orders/.dev.vars': 'KEY=dev',
      'workers/orders/.dev.vars.production': 'KEY=production',
    },
    monocfConfig: {},
    workers: [{config: {env: {production: {}}}, name: 'orders'}],
  })
}

function withoutConfig(fixture: Fixture): Fixture {
  writeFileSync(join(fixture.root, 'monocf.config.json'), '{}')
  return fixture
}

describe('without monocf.config.json (R5)', () => {
  it('honours -e and -w', async () => {
    const fixture = withoutConfig(project())

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders', '-e', 'production', '-w', 'workers'])

    expect(result.exitCode).toBe(0)
    const upload = result.calls.find((call) => call.secretFile)!
    expect(flagValue(upload, '--env')).toBe('production')
    expect(upload.secretFile?.vars).toEqual({KEY: 'production'})
  })

  it('rejects an env that nothing defines, rather than uploading anywhere', async () => {
    const fixture = withoutConfig(project())

    const result = await runRejected(fixture, ['secrets', 'deploy', 'orders', '-e', 'typo', '-w', 'workers'])

    expectUsageError(result, 'Unknown environment "typo"')
  })

  it('works with no project file at all', async () => {
    const fixture = project()
    rmSync(join(fixture.root, 'monocf.config.json'))

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders', '-e', 'production', '-w', 'workers'])

    expect(result.exitCode).toBe(0)
    expect(flagValue(result.calls.find((call) => call.secretFile)!, '--env')).toBe('production')
  })
})

describe('what each wrangler call carries (R8)', () => {
  const versionWorkers = [{config: {env: {staging: {}}}, name: 'orders'}]

  it('-f -e keeps the env and the config on every call', async () => {
    const fixture = createFixture({workers: versionWorkers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    expect(result.calls.map((call) => call.argv.slice(0, 2).join(' '))).toEqual([
      'versions list',
      'versions deploy',
      'triggers deploy',
    ])
    for (const call of result.calls) {
      expect(flagValue(call, '--env')).toBe('staging')
      expectConfigFor(call, 'orders-v1-staging')
    }
  })

  it('secret bulk gets the config of the right worker, with the env', async () => {
    const fixture = createFixture({
      environments,
      files: {
        'workers/billing/.dev.vars.staging': 'KEY=billing',
        'workers/orders/.dev.vars.staging': 'KEY=orders',
      },
      workers: [{name: 'billing'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['secrets', 'deploy', '-a', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    const uploads = result.calls.filter((call) => call.secretFile)
    expect(uploads).toHaveLength(2)
    expectConfigFor(uploads[0], 'billing-v1-staging')
    expectConfigFor(uploads[1], 'orders-v1-staging')
    expect(uploads[0].secretFile?.vars).toEqual({KEY: 'billing'})
    expect(uploads[1].secretFile?.vars).toEqual({KEY: 'orders'})
    for (const call of result.calls) expect(flagValue(call, '--env')).toBe('staging')
  })

  it.each([
    ['deploy', 'deploy'],
    ['preview', 'versions'],
    ['build', 'deploy'],
  ])('-m reaches %s', async (command, subcommand) => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', command, '-m'])

    expect(result.calls[0].argv[0]).toBe(subcommand)
    expect(result.calls[0].argv).toContain('--minify')
  })

  it('--no-minify overrides minify in the project file', async () => {
    const fixture = createFixture({monocfConfig: {minify: true}, workers: [{name: 'orders'}]})

    const fromFile = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'])
    const fromFlag = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '--no-minify'])

    expect(fromFile.calls[0].argv).toContain('--minify')
    expect(fromFlag.calls[0].argv).not.toContain('--minify')
  })

  it('dev -a -e keeps the env and skips ignored workers', async () => {
    const fixture = createFixture({
      environments,
      ignore: ['legacy'],
      workers: [{name: 'billing'}, {name: 'legacy'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    const workers = result.calls.filter((call) => call.config?.name !== 'proxy-worker')
    expect(workers.map((call) => effectiveConfig(call).name).sort()).toEqual(['billing-v1-staging', 'orders-v1-staging'])
    for (const call of workers) expect(flagValue(call, '--env')).toBe('staging')
    const proxy = result.calls.find((call) => call.config?.name === 'proxy-worker')!
    expect(proxy.argv).not.toContain('--env')
    expect(releaseOf(proxy)).toBeUndefined()
  })

  it('dev -a passes RELEASE to each worker, and not to the proxy', async () => {
    const fixture = createFixture({workers: [{name: 'billing'}, {name: 'orders'}]})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'], {env: {GITHUB_SHA: 'abcdef1234567'}})

    const workers = result.calls.filter((call) => call.config?.name !== 'proxy-worker')
    expect(workers.map((call) => releaseOf(call))).toEqual(['abcdef1', 'abcdef1'])
  })

  it('dev -a uses a port from the worker config for that worker', async () => {
    const fixture = createFixture({
      workers: [{config: {dev: {port: 9555}}, name: 'billing'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'])

    const billing = result.calls.find((call) => call.config?.name === 'billing-v1')!
    expect(flagValue(billing, '--port')).toBe('9555')
  })

  it('dev -a gives the proxy a map of each worker to its port', async () => {
    const fixture = createFixture({
      workers: [
        {config: {dev: {port: 9555}, routes: ['example.com/billing/*']}, name: 'billing'},
        {config: {route: {pattern: 'example.com/*', zone_name: 'example.com'}}, name: 'gateway'},
        {name: 'orders'},
      ],
    })

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'])

    const proxy = result.calls.find((call) => call.config?.name === 'proxy-worker')!
    const orders = result.calls.find((call) => call.config?.name === 'orders-v1')!
    const gateway = result.calls.find((call) => call.config?.name === 'gateway-v1')!
    expect(proxy.mainSource).toContain('"/billing": 9555')
    expect(proxy.mainSource).toContain(`"/orders": ${flagValue(orders, '--port')}`)
    // A route that covers a whole host must not become a prefix that catches every request.
    expect(proxy.mainSource).toContain(`"/gateway": ${flagValue(gateway, '--port')}`)
    expect(proxy.mainSource).not.toContain('"":')
  })

  it('dev -a keeps a worker directory named like the proxy', async () => {
    const fixture = createFixture({workers: [{name: 'proxy-worker'}]})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'])

    const worker = result.calls.find((call) => call.config?.name === 'proxy-worker-v1')!
    const proxy = result.calls.find((call) => call.config?.name === 'proxy-worker')!
    expect(worker.mainSource).toContain("new Response('proxy-worker')")
    expect(proxy.mainSource).toContain('const map')
    expect(worker.configDir).not.toBe(proxy.configDir)
  })

  it.each([
    ['a plain host', 'example.com/api/*'],
    ['a host that starts with http', 'httpbin.example.com/api/*'],
    ['a URL', 'https://example.com/api/*'],
  ])('dev -a reads the path of %s', async (_, route) => {
    const fixture = createFixture({workers: [{config: {routes: [route]}, name: 'orders'}]})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'])

    const proxy = result.calls.find((call) => call.config?.name === 'proxy-worker')!
    expect(proxy.mainSource).toContain('"/api":')
  })

  it('dev -a says when two workers have the same route prefix', async () => {
    const config = {routes: ['example.com/api/*']}
    const fixture = createFixture({workers: [{config, name: 'billing'}, {config, name: 'orders'}]})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout + result.stderr).toContain('billing and orders have the same route prefix /api')
  })

  it('dev -a reads a route from the env section', async () => {
    const fixture = createFixture({
      workers: [{config: {env: {staging: {routes: ['example.com/api/*']}}}, name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev', '-e', 'staging'])

    const proxy = result.calls.find((call) => call.config?.name === 'proxy-worker')!
    expect(proxy.mainSource).toContain('"/api":')
  })

  it('worker values beat root values in local dev', async () => {
    const fixture = createFixture({
      files: {'.dev.vars': 'ROOT=root\nSHARED=root', 'workers/orders/.dev.vars': 'SHARED=worker'},
      workers: [{name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev'])

    expect(result.calls[0].devVars).toEqual({ROOT: 'root', SHARED: 'worker'})
  })

  it('dev -a gives each worker its own merged values', async () => {
    const fixture = createFixture({
      files: {'.dev.vars': 'SHARED=root', 'workers/orders/.dev.vars': 'SHARED=orders'},
      workers: [{name: 'billing'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'])

    expect(result.calls.find((call) => call.config?.name === 'orders-v1')?.devVars).toEqual({SHARED: 'orders'})
    expect(result.calls.find((call) => call.config?.name === 'billing-v1')?.devVars).toEqual({SHARED: 'root'})
    expect(result.calls.find((call) => call.config?.name === 'proxy-worker')?.devVars).toBeNull()
  })
})

describe('failed secret uploads (R10)', () => {
  const options = {files: {'workers/orders/.dev.vars': 'KEY=1'}, workers: [{name: 'orders'}]}

  it('exits 1 for a failure', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders'], {
      rules: [{command: 'secret bulk', exitCode: 7}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('exit code 7')
  })

  it.skipIf(process.platform === 'win32')('exits 128 + signal when killed', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders'], {
      rules: [{command: 'secret bulk', signal: 'SIGKILL'}],
    })

    expect(result.exitCode).toBe(128 + 9)
  })

  it('does not exit 2 when killed, on any platform', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders'], {
      rules: [{command: 'secret bulk', signal: 'SIGKILL'}],
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode).not.toBe(2)
  })
})

describe('secrets deploy guards a missing worker', () => {
  const options = {files: {'workers/orders/.dev.vars': 'KEY=1'}, workers: [{name: 'orders'}]}

  it('checks that the worker exists before uploading', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders'])

    expect(result.exitCode).toBe(0)
    expect(result.calls.map((call) => argvWithoutConfig(call).slice(0, 2).join(' '))).toEqual([
      'deployments status',
      'secret bulk',
    ])
    expectConfigFor(result.calls[0], 'orders-v1')
  })

  it('exits 1 without uploading when the worker does not exist', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders'], {
      rules: [{command: 'deployments status', exitCode: 1, stderr: 'not found [code: 10007]\n'}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--create')
    expect(result.calls.filter((call) => call.secretFile)).toEqual([])
  })

  it('recognises the code from the output file too', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders'], {
      rules: [{command: 'deployments status', exitCode: 1, failCode: 10_007}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--create')
  })

  it('--create skips the check', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders', '--create'], {
      rules: [{command: 'deployments status', exitCode: 1, failCode: 10_007}],
    })

    expect(result.exitCode).toBe(0)
    expect(result.calls.map((call) => call.argv[0])).toEqual(['secret'])
  })

  it('another failure of the check is not reported as a missing worker, and uploads nothing', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['secrets', 'deploy', 'orders'], {
      rules: [{command: 'deployments status', exitCode: 1, failCode: 10_000, failMessage: 'Authentication error'}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Authentication error')
    expect(result.stderr).not.toContain('--create')
    expect(result.calls.filter((call) => call.secretFile)).toEqual([])
  })

  it('infers the worker from the current directory', async () => {
    const fixture = createFixture(options)

    const result = await runCli(fixture, ['secrets', 'deploy'], {cwd: 'workers/orders'})

    expect(result.exitCode).toBe(0)
    expectConfigFor(result.calls[0], 'orders-v1')
  })
})

describe('flags beat config (R11)', () => {
  it('--no-deploy-bindings overrides the project file', async () => {
    const fixture = createFixture({
      monocfConfig: {deployBindings: true},
      workers: [{bindings: ['orders'], name: 'gateway'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '--no-deploy-bindings'])

    expect(deployedNames(result.calls, 'deploy')).toEqual(['gateway-v1'])
  })

  it('--no-deploy-secrets overrides the project file', async () => {
    const fixture = createFixture({monocfConfig: {deploySecrets: true}, workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '--no-deploy-secrets'])

    expect(result.exitCode).toBe(0)
    expect(result.calls[0].argv).not.toContain('--secrets-file')
  })

  it('-f ignores deploySecrets from the project file, and rejects -s itself', async () => {
    const fixture = createFixture({monocfConfig: {deploySecrets: true}, workers: [{name: 'orders'}]})

    const fromFile = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f', '-F', 'abc123'])
    const fromFlag = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-f', '-F', 'abc123', '-s'])

    expect(fromFile.exitCode).toBe(0)
    expectUsageError(fromFlag, '--deploy-secrets has no effect')
  })
})

describe('an env written with a placeholder (R13)', () => {
  it('is valid once its key resolves', async () => {
    const fixture = createFixture({
      monocfConfig: {variables: {stage: 'staging', version: 'v1'}},
      workers: [{config: {env: {'{stage}': {vars: {FROM_ENV: '1'}}}}, name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    expect(effectiveConfig(result.calls[0]).vars).toMatchObject({FROM_ENV: '1'})
  })

  it('the raw key is no longer an env', async () => {
    const fixture = createFixture({
      monocfConfig: {variables: {stage: 'staging', version: 'v1'}},
      workers: [{config: {env: {'{stage}': {}}}, name: 'orders'}],
    })

    const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-e', '{stage}'])

    expectUsageError(result, 'Unknown environment')
  })

  it('an unset env value in a base config section works too', async () => {
    const fixture = createFixture({
      base: {env: {'{stage}': {}}},
      monocfConfig: {variables: {stage: 'staging', version: 'v1'}},
      workers: [{name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'build', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
  })
})

describe('monocf.config.json', () => {
  it('rejects an unknown key now that every command reads it', async () => {
    const fixture = createFixture({monocfConfig: {typoKey: true}, workers: [{name: 'orders'}]})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', 'build'])

    expectUsageError(result, 'typoKey')
  })
})
