import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {
  argvWithoutConfig,
  createFixture,
  deployedNames,
  flagValue,
  runCli,
  type CliResult,
  type Fixture,
} from '../helpers/harness.js'

function runRejected(fixture: Fixture, args: string[]): Promise<CliResult> {
  return runCli(fixture, args, {noCalls: true})
}

function expectRejected(result: CliResult, message: string): void {
  expect(result.stderr.replaceAll(/\s+/g, ' ').replaceAll(' › ', ' ')).toContain(message)
  expect(result.exitCode).toBe(2)
  expect(result.calls).toEqual([])
}

function secretCalls(result: CliResult) {
  return result.calls.filter((call) => call.secretFile)
}

const environments = ['staging', 'production']

describe('-e (F07)', () => {
  it.each(['build', 'deploy', 'preview', 'dev'])('%s fails for an env defined nowhere', async (command) => {
    const fixture = createFixture({environments, workers: [{name: 'orders'}]})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', command, '-e', 'prodution'])

    expectRejected(result, 'Unknown environment "prodution" for worker orders')
  })

  it('accepts an env defined only in the base config', async () => {
    const fixture = createFixture({environments: ['staging'], workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(1)
  })

  it('accepts an env defined only in the worker config', async () => {
    const fixture = createFixture({workers: [{config: {env: {staging: {}}}, name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(1)
  })

  it('accepts an env when there is no base config', async () => {
    const fixture = createFixture({base: false, workers: [{config: {env: {staging: {}}}, name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
  })

  it('does not take inherited object keys for envs', async () => {
    const fixture = createFixture({environments, workers: [{name: 'orders'}]})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'constructor'])

    expectRejected(result, 'Unknown environment "constructor"')
  })

  it('with -a fails before any wrangler call if one worker lacks the env', async () => {
    const fixture = createFixture({
      workers: [{config: {env: {staging: {}}}, name: 'billing'}, {name: 'orders'}],
    })

    const result = await runRejected(fixture, ['worker', '-a', '-c', 'deploy', '-e', 'staging'])

    expectRejected(result, 'Unknown environment "staging" for worker orders')
  })

  it('with -d fails before any wrangler call if a binding lacks the env', async () => {
    const fixture = createFixture({
      workers: [{envBindings: {staging: ['orders']}, name: 'gateway'}, {name: 'orders'}],
    })

    const result = await runRejected(fixture, ['worker', 'gateway', '-c', 'deploy', '-e', 'staging', '-d'])

    expectRejected(result, 'Unknown environment "staging" for worker orders')
  })

  it('does not check bindings that the run does not deploy', async () => {
    const fixture = createFixture({
      workers: [{envBindings: {staging: ['orders']}, name: 'gateway'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
  })

  describe('names that look special', () => {
    it.each(['local', 'dev'])('-e %s works when defined', async (env) => {
      const fixture = createFixture({environments: [env], workers: [{name: 'orders'}]})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev', '-e', env])

      expect(result.exitCode).toBe(0)
      expect(argvWithoutConfig(result.calls[0])).toEqual(['dev', '--env', env])
    })

    it.each(['local', 'dev'])('-e %s fails when not defined: it has no special treatment', async (env) => {
      const fixture = createFixture({environments: ['staging'], workers: [{name: 'orders'}]})

      const result = await runRejected(fixture, ['worker', 'orders', '-c', 'dev', '-e', env])

      expectRejected(result, `Unknown environment "${env}"`)
    })
  })
})

describe('named workers (F08)', () => {
  it.each(['build', 'deploy', 'preview', 'dev'])('%s fails for a worker that does not exist', async (command) => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runRejected(fixture, ['worker', 'nope', '-c', command])

    expectRejected(result, 'Worker not found')
  })

  it.each(['build', 'deploy', 'preview', 'dev'])('%s fails for a worker in .monocfignore', async (command) => {
    const fixture = createFixture({ignore: ['orders'], workers: [{name: 'billing'}, {name: 'orders'}]})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', command])

    expectRejected(result, 'Worker orders is listed in .monocfignore')
  })

  it('fails for an ignored worker inferred from the current directory', async () => {
    const fixture = createFixture({ignore: ['orders'], workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', '-c', 'deploy'], {cwd: 'workers/orders', noCalls: true})

    expectRejected(result, 'Worker orders is listed in .monocfignore')
  })

  it('-a fails when every worker is ignored', async () => {
    const fixture = createFixture({ignore: ['orders'], workers: [{name: 'orders'}]})

    const result = await runRejected(fixture, ['worker', '-a', '-c', 'deploy'])

    expectRejected(result, 'No workers found')
  })

  it('-d still skips an ignored binding of a named worker', async () => {
    const fixture = createFixture({
      ignore: ['orders'],
      workers: [{bindings: ['orders'], name: 'gateway'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-d'])

    expect(result.exitCode).toBe(0)
    expect(deployedNames(result.calls, 'deploy')).toEqual(['gateway-v1'])
  })

  it('-d fails before any wrangler call if a binding does not exist', async () => {
    const fixture = createFixture({workers: [{bindings: ['nope'], name: 'gateway'}]})

    const result = await runRejected(fixture, ['worker', 'gateway', '-c', 'deploy', '-d'])

    expectRejected(result, 'Worker not found')
  })
})

describe('secrets files (F05, F34)', () => {
  describe('deploy -s', () => {
    it('uploads exactly the file of the env', async () => {
      const fixture = createFixture({
        environments,
        files: {
          'workers/orders/.dev.vars': 'KEY=from-dev',
          'workers/orders/.dev.vars.production': 'KEY=from-production',
        },
        workers: [{name: 'orders'}],
      })

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'production', '-s'])

      expect(result.exitCode).toBe(0)
      const [upload] = secretCalls(result)
      expect(argvWithoutConfig(upload).slice(0, 2)).toEqual(['secret', 'bulk'])
      expect(flagValue(upload, '--env')).toBe('production')
      expect(upload.secretFile?.vars).toEqual({KEY: 'from-production'})
    })

    it('fails before any wrangler call when only .dev.vars exists', async () => {
      const fixture = createFixture({
        environments,
        files: {'.dev.vars': 'ROOT=dev', 'workers/orders/.dev.vars': 'KEY=dev'},
        workers: [{name: 'orders'}],
      })

      const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'production', '-s'])

      expectRejected(result, '.dev.vars.production')
    })

    it('fails when the root has the env file but the worker does not', async () => {
      const fixture = createFixture({
        environments,
        files: {'.dev.vars.production': 'ROOT=production'},
        workers: [{name: 'orders'}],
      })

      const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'production', '-s'])

      expectRejected(result, '.dev.vars.production')
    })

    it('merges the root file of the same env, with the worker winning', async () => {
      const fixture = createFixture({
        environments,
        files: {
          '.dev.vars.production': 'ROOT=root-production\nSHARED=root',
          'workers/orders/.dev.vars.production': 'SHARED=worker',
        },
        workers: [{name: 'orders'}],
      })

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'production', '-s'])

      expect(secretCalls(result)[0].secretFile?.vars).toEqual({ROOT: 'root-production', SHARED: 'worker'})
    })

    it('never mixes in a root .dev.vars from another env', async () => {
      const fixture = createFixture({
        environments,
        files: {'.dev.vars': 'ROOT=dev', 'workers/orders/.dev.vars.production': 'KEY=production'},
        workers: [{name: 'orders'}],
      })

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'production', '-s'])

      expect(secretCalls(result)[0].secretFile?.vars).toEqual({KEY: 'production'})
    })

    it('does not upload values a caller patched into the file of its binding', async () => {
      const fixture = createFixture({
        environments,
        files: {
          '.dev.vars': 'ROOT=dev',
          'workers/gateway/.dev.vars.production': 'KEY=gateway',
          'workers/orders/.dev.vars.production': 'KEY=orders',
        },
        workers: [{envBindings: {production: ['orders']}, name: 'gateway'}, {name: 'orders'}],
      })

      const result = await runCli(fixture, ['worker', '-a', '-c', 'deploy', '-e', 'production', '-s'])

      expect(result.exitCode).toBe(0)
      expect(secretCalls(result).map((call) => call.secretFile?.vars)).toEqual([{KEY: 'gateway'}, {KEY: 'orders'}])
    })

    it('uses .dev.vars without -e, and requires it', async () => {
      const withFile = createFixture({files: {'workers/orders/.dev.vars': 'KEY=dev'}, workers: [{name: 'orders'}]})
      const withoutFile = createFixture({workers: [{name: 'orders'}]})

      const uploaded = await runCli(withFile, ['worker', 'orders', '-c', 'deploy', '-s'])
      const rejected = await runRejected(withoutFile, ['worker', 'orders', '-c', 'deploy', '-s'])

      expect(secretCalls(uploaded)[0].secretFile?.vars).toEqual({KEY: 'dev'})
      expectRejected(rejected, '.dev.vars')
    })

    it('with -a fails before any wrangler call if one worker lacks the file', async () => {
      const fixture = createFixture({
        environments,
        files: {'workers/billing/.dev.vars.production': 'KEY=billing'},
        workers: [{name: 'billing'}, {name: 'orders'}],
      })

      const result = await runRejected(fixture, ['worker', '-a', '-c', 'deploy', '-e', 'production', '-s'])

      expectRejected(result, '.dev.vars.production')
    })

    it('with -a does not require the file of an ignored worker', async () => {
      const fixture = createFixture({
        environments,
        files: {'workers/billing/.dev.vars.production': 'KEY=billing'},
        ignore: ['orders'],
        workers: [{name: 'billing'}, {name: 'orders'}],
      })

      const result = await runCli(fixture, ['worker', '-a', '-c', 'deploy', '-e', 'production', '-s'])

      expect(result.exitCode).toBe(0)
      expect(secretCalls(result)).toHaveLength(1)
    })

    it('with -d fails before any wrangler call if a binding lacks the file', async () => {
      const fixture = createFixture({
        environments,
        files: {'workers/gateway/.dev.vars.production': 'KEY=gateway'},
        workers: [{envBindings: {production: ['orders']}, name: 'gateway'}, {name: 'orders'}],
      })

      const result = await runRejected(fixture, ['worker', 'gateway', '-c', 'deploy', '-e', 'production', '-s', '-d'])

      expectRejected(result, '.dev.vars.production')
    })

    it('applies to deploySecrets from monocf.config.json', async () => {
      const fixture = createFixture({
        environments,
        monocfConfig: {deploySecrets: true},
        workers: [{name: 'orders'}],
      })

      const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'production'])

      expectRejected(result, '.dev.vars.production')
    })
  })

  describe('-e dev', () => {
    const files = {'workers/orders/.dev.vars': 'KEY=plain', 'workers/orders/.dev.vars.dev': 'KEY=dev-file'}

    it('deploy -s uploads .dev.vars.dev, not .dev.vars', async () => {
      const fixture = createFixture({environments: ['dev'], files, workers: [{name: 'orders'}]})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'dev', '-s'])

      expect(result.exitCode).toBe(0)
      expect(secretCalls(result)[0].secretFile?.vars).toEqual({KEY: 'dev-file'})
    })

    it('deploy -s fails when only .dev.vars exists', async () => {
      const fixture = createFixture({
        environments: ['dev'],
        files: {'workers/orders/.dev.vars': 'KEY=plain'},
        workers: [{name: 'orders'}],
      })

      const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'dev', '-s'])

      expectRejected(result, '.dev.vars.dev')
    })
  })

  describe('preview -s', () => {
    it('uploads version secrets from the file of the env', async () => {
      const fixture = createFixture({
        environments,
        files: {'workers/orders/.dev.vars.staging': 'KEY=staging'},
        workers: [{name: 'orders'}],
      })

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'preview', '-e', 'staging', '-s'])

      expect(result.exitCode).toBe(0)
      const [upload] = secretCalls(result)
      expect(upload.argv.slice(0, 3)).toEqual(['versions', 'secret', 'bulk'])
      expect(upload.secretFile?.vars).toEqual({KEY: 'staging'})
    })

    it('fails before any wrangler call without that file', async () => {
      const fixture = createFixture({
        environments,
        files: {'workers/orders/.dev.vars': 'KEY=dev'},
        workers: [{name: 'orders'}],
      })

      const result = await runRejected(fixture, ['worker', 'orders', '-c', 'preview', '-e', 'staging', '-s'])

      expectRejected(result, '.dev.vars.staging')
    })
  })

  describe('secrets deploy', () => {
    it('uploads the file of the env', async () => {
      const fixture = createFixture({
        environments,
        files: {'workers/orders/.dev.vars.production': 'KEY=production'},
        workers: [{name: 'orders'}],
      })

      const result = await runCli(fixture, ['secrets', 'deploy', 'orders', '-e', 'production'])

      expect(result.exitCode).toBe(0)
      expect(secretCalls(result)[0].secretFile?.vars).toEqual({KEY: 'production'})
    })

    it('fails when only .dev.vars exists', async () => {
      const fixture = createFixture({
        environments,
        files: {'workers/orders/.dev.vars': 'KEY=dev'},
        workers: [{name: 'orders'}],
      })

      const result = await runRejected(fixture, ['secrets', 'deploy', 'orders', '-e', 'production'])

      expectRejected(result, '.dev.vars.production')
    })

    it('fails for an unknown env, a missing worker and an ignored worker', async () => {
      const fixture = createFixture({
        environments,
        files: {'workers/orders/.dev.vars.prodution': 'KEY=typo'},
        ignore: ['billing'],
        workers: [{name: 'billing'}, {name: 'orders'}],
      })

      expectRejected(
        await runRejected(fixture, ['secrets', 'deploy', 'orders', '-e', 'prodution']),
        'Unknown environment "prodution"',
      )
      expectRejected(await runRejected(fixture, ['secrets', 'deploy', 'nope']), 'Worker not found')
      expectRejected(await runRejected(fixture, ['secrets', 'deploy', 'billing']), 'listed in .monocfignore')
    })

    it('-a skips ignored workers', async () => {
      const fixture = createFixture({
        environments,
        files: {'workers/orders/.dev.vars.production': 'KEY=production'},
        ignore: ['billing'],
        workers: [{name: 'billing'}, {name: 'orders'}],
      })

      const result = await runCli(fixture, ['secrets', 'deploy', '-a', '-e', 'production'])

      expect(result.exitCode).toBe(0)
      expect(secretCalls(result)).toHaveLength(1)
    })
  })

  describe('local dev keeps its fallback', () => {
    it('reads .dev.vars for an env without its own file, and merges the root', async () => {
      const fixture = createFixture({
        environments,
        files: {'.dev.vars': 'ROOT=root', 'workers/orders/.dev.vars': 'KEY=worker'},
        workers: [{name: 'orders'}],
      })

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev', '-e', 'staging'])

      expect(result.exitCode).toBe(0)
      expect(result.calls[0].devVars).toEqual({KEY: 'worker', ROOT: 'root'})
    })

    it('needs no env file at all', async () => {
      const fixture = createFixture({environments, workers: [{name: 'orders'}]})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev', '-e', 'staging'])

      expect(result.exitCode).toBe(0)
    })

    it('leaves .dev.vars alone for -e dev when .dev.vars.dev exists', async () => {
      const fixture = createFixture({
        environments: ['dev'],
        files: {
          '.dev.vars.dev': 'ROOT=dev-file',
          'workers/orders/.dev.vars': 'KEY=plain',
          'workers/orders/.dev.vars.dev': 'KEY=dev-file',
        },
        workers: [{name: 'orders'}],
      })

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev', '-e', 'dev'])

      expect(result.exitCode).toBe(0)
      expect(result.calls[0].devVars).toEqual({KEY: 'plain'})
      expect(readFileSync(join(fixture.worker('orders'), '.dev.vars.dev'), 'utf8')).toBe('KEY=dev-file')
    })
  })
})

describe('flag combinations (F11, F23)', () => {
  const workers = [{name: 'orders'}]

  it('-F requires -f', async () => {
    const fixture = createFixture({workers})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-F', 'abc123'])

    expectRejected(result, '--deploy-from-version-id requires --from-version')
  })

  it('-f -F deploys that version of the named worker', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f', '-F', 'abc123'])

    expect(result.exitCode).toBe(0)
    expect(result.calls.map((call) => argvWithoutConfig(call))).toEqual([
      ['versions', 'deploy', '--yes', '--version-id', 'abc123'],
      ['triggers', 'deploy'],
    ])
  })

  it('-f deploys the latest version', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f'])

    expect(result.exitCode).toBe(0)
    expect(result.calls.map((call) => argvWithoutConfig(call))).toEqual([
      ['versions', 'list', '--json'],
      ['versions', 'deploy', '--yes', '--version-id', 'version-latest'],
      ['triggers', 'deploy'],
    ])
  })

  it.each([
    ['-f -a', ['worker', '-c', 'deploy', '-f', '-a']],
    ['-f -d', ['worker', 'orders', '-c', 'deploy', '-f', '-d']],
    ['-f -F -a', ['worker', '-c', 'deploy', '-f', '-F', 'abc123', '-a']],
    ['-f -F -d', ['worker', 'orders', '-c', 'deploy', '-f', '-F', 'abc123', '-d']],
  ])('%s fails', async (_, args) => {
    const fixture = createFixture({workers})

    expectRejected(await runRejected(fixture, args), 'Deploying from a version works for one named worker')
  })

  it('-f fails when deployBindings is set in monocf.config.json', async () => {
    const fixture = createFixture({monocfConfig: {deployBindings: true}, workers})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-f', '-F', 'abc123'])

    expectRejected(result, 'Deploying from a version works for one named worker')
  })

  it('-f -m fails: nothing gets uploaded to minify', async () => {
    const fixture = createFixture({workers})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-f', '-m'])

    expectRejected(result, '--minify has no effect')
  })

  it.each([
    ['build -s', ['-c', 'build', '-s'], 'deploy-secrets'],
    ['build -d', ['-c', 'build', '-d'], 'deploy-bindings'],
    ['build -M', ['-c', 'build', '-M', 'x'], 'message'],
    ['build -p', ['-c', 'build', '-p', '9999'], 'port'],
    ['build -f', ['-c', 'build', '-f'], 'from-version'],
    ['dev -s', ['-c', 'dev', '-s'], 'deploy-secrets'],
    ['dev -d', ['-c', 'dev', '-d'], 'deploy-bindings'],
    ['dev -m', ['-c', 'dev', '-m'], 'minify'],
    ['dev -M', ['-c', 'dev', '-M', 'x'], 'message'],
    ['deploy -p', ['-c', 'deploy', '-p', '9999'], 'port'],
    ['preview -p', ['-c', 'preview', '-p', '9999'], 'port'],
    ['preview -f', ['-c', 'preview', '-f'], 'from-version'],
  ])('%s fails instead of dropping the flag', async (_, flags, flagName) => {
    const fixture = createFixture({workers})

    const result = await runRejected(fixture, ['worker', 'orders', ...flags])

    expectRejected(result, `--${flagName} is not supported`)
  })

  it('preview passes -M to the upload', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'preview', '-M', 'fix: login & logout'])

    expect(result.exitCode).toBe(0)
    expect(flagValue(result.calls[0], '--message')).toBe('fix: login & logout')
  })

  it('deploy -M fails without -f: wrangler deploy has no message option', async () => {
    const fixture = createFixture({workers})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', 'deploy', '-M', 'fix: login'])

    expectRejected(result, '--message on deploy requires --from-version')
  })

  it('deploy -f -M passes the message to versions deploy', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f', '-F', 'abc123', '-M', 'fix: login'])

    expect(result.exitCode).toBe(0)
    expect(flagValue(result.calls[0], '--message')).toBe('fix: login')
  })

  it('preview -d uploads bindings first', async () => {
    const fixture = createFixture({workers: [{bindings: ['orders'], name: 'gateway'}, {name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'preview', '-d'])

    expect(result.exitCode).toBe(0)
    expect(deployedNames(result.calls, 'versions upload')).toEqual(['orders-v1', 'gateway-v1'])
  })

  it('preview ignores deployBindings from monocf.config.json, as before', async () => {
    const fixture = createFixture({
      monocfConfig: {deployBindings: true},
      workers: [{bindings: ['orders'], name: 'gateway'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'preview'])

    expect(deployedNames(result.calls, 'versions upload')).toEqual(['gateway-v1'])
  })

  it('dev honours -p for a single worker', async () => {
    const fixture = createFixture({workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev', '-p', '9999'])

    expect(result.exitCode).toBe(0)
    expect(flagValue(result.calls[0], '--port')).toBe('9999')
  })

  it('dev without -p passes no port, so the wrangler config decides', async () => {
    const fixture = createFixture({monocfConfig: {port: 7777}, workers})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev'])

    expect(result.calls[0].argv).not.toContain('--port')
  })

  it('dev -a uses -p over the port in monocf.config.json', async () => {
    const fixture = createFixture({monocfConfig: {port: 7777}, workers})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev', '-p', '9999'])

    const proxy = result.calls.find((call) => call.config?.name === 'proxy-worker')
    expect(flagValue(proxy!, '--port')).toBe('9999')
  })
})

describe('-c', () => {
  it('rejects an unknown command in the parser', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runRejected(fixture, ['worker', 'orders', '-c', 'bogus'])

    expect(result.exitCode).toBe(2)
    expect(result.calls).toEqual([])
    expect(result.stderr).toContain('Expected --command=bogus to be one of: build, deploy, dev, preview')
  })

  it('lists the commands in --help', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runRejected(fixture, ['worker', '--help'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('build|deploy|dev|preview')
  })
})

describe('-a with an inferred worker (F47)', () => {
  it('runs for all workers from inside a worker directory', async () => {
    const fixture = createFixture({workers: [{name: 'billing'}, {name: 'orders'}]})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'deploy'], {cwd: 'workers/orders'})

    expect(result.exitCode).toBe(0)
    expect(deployedNames(result.calls, 'deploy')).toEqual(['billing-v1', 'orders-v1'])
  })

  it('still fails with -a and an explicit worker name', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runRejected(fixture, ['worker', 'orders', '-a', '-c', 'deploy'])

    expectRejected(result, 'Worker name is not allowed when using --all flag')
  })
})
