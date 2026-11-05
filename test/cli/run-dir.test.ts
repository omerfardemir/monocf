import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {
  createFixture,
  deployedNames,
  flagValue,
  fromRoot,
  releaseOf,
  runCli,
  snapshotTree,
  startCli,
  type Fixture,
} from '../helpers/harness.js'

const isWindows = process.platform === 'win32'

const SECRET_FILES = {
  '.dev.vars': 'ROOT=root',
  '.dev.vars.staging': 'ROOT=staging',
  'workers/gateway/.dev.vars': 'KEY=gateway',
  'workers/gateway/.dev.vars.staging': 'KEY=gateway-staging',
  'workers/orders/.dev.vars.staging': 'KEY=orders-staging',
}

function project(): Fixture {
  return createFixture({
    environments: ['staging'],
    files: SECRET_FILES,
    workers: [{bindings: ['orders'], envBindings: {staging: ['orders']}, name: 'gateway'}, {name: 'orders'}],
  })
}

describe('the source tree stays as it was', () => {
  it.each([
    ['deploy', ['worker', 'gateway', '-c', 'deploy', '-e', 'staging']],
    ['deploy -s', ['worker', 'gateway', '-c', 'deploy', '-e', 'staging', '-s']],
    ['deploy -d', ['worker', 'gateway', '-c', 'deploy', '-e', 'staging', '-d']],
    ['deploy -f', ['worker', 'gateway', '-c', 'deploy', '-e', 'staging', '-f']],
    ['preview', ['worker', 'gateway', '-c', 'preview', '-e', 'staging']],
    ['preview -s', ['worker', 'gateway', '-c', 'preview', '-e', 'staging', '-s']],
    ['secrets deploy', ['secrets', 'deploy', 'gateway', '-e', 'staging']],
    ['secrets deploy -a', ['secrets', 'deploy', '-a', '-e', 'staging']],
    ['dev', ['worker', 'gateway', '-c', 'dev', '-e', 'staging']],
    ['dev -a', ['worker', '-a', '-c', 'dev', '-e', 'staging']],
  ])('%s', async (_, args) => {
    const fixture = project()
    const before = snapshotTree(fixture.root)

    const result = await runCli(fixture, args)

    expect(result.exitCode).toBe(0)
    expect(snapshotTree(fixture.root)).toEqual(before)
  })

  it('build adds only its explicit output', async () => {
    const fixture = project()
    const before = snapshotTree(fixture.root)

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'build', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    const after = snapshotTree(fixture.root)
    const added = Object.keys(after).filter((path) => !(path in before))
    expect(added).toEqual([
      'workers/gateway/dist/',
      'workers/gateway/dist/index.js',
      'workers/gateway/dist/index.js.map',
      'workers/gateway/dist/README.md',
    ])
    for (const path of Object.keys(before)) expect(after[path]).toBe(before[path])
  })

  it('a failed run leaves nothing behind either', async () => {
    const fixture = project()
    const before = snapshotTree(fixture.root)

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-e', 'staging', '-s'], {
      rules: [{command: 'deploy', exitCode: 1}],
    })

    expect(result.exitCode).toBe(1)
    expect(snapshotTree(fixture.root)).toEqual(before)
  })
})

describe('the run directory', () => {
  it('holds the config of each call, under the worker, with its own output file per spawn', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-f', '-e', 'staging'])

    expect(result.exitCode).toBe(0)
    const dirs = result.calls.map((call) => fromRoot(fixture, call.configDir!))
    for (const dir of dirs) expect(dir).toMatch(/^\.monocf\/runs\/[\da-f]+\/gateway$/)
    expect(new Set(dirs).size).toBe(1)
    const outputs = result.calls.map((call) => call.outputFile)
    expect(new Set(outputs).size).toBe(outputs.length)
    for (const output of outputs) expect(output?.startsWith(result.calls[0].configDir!)).toBe(true)
  })

  it('runs wrangler from the directory of its config, since it resolves some paths from each', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-e', 'staging'])

    expect(fromRoot(fixture, result.calls[0].cwd)).toMatch(/^\.monocf\/runs\/[\da-f]+\/gateway$/)
    expect(result.calls[0].cwd).toBe(result.calls[0].configDir)
  })

  it('points the rebased main at the source file', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy'])

    expect(result.calls[0].config?.main).toMatch(/^\.\./)
    expect(result.calls[0].mainSource).toContain(`new Response('gateway')`)
  })

  it.skipIf(isWindows)('is private, and so are the secrets in it', async () => {
    const fixture = project()

    const deploy = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-e', 'staging', '-s'])
    const dev = await runCli(fixture, ['worker', 'gateway', '-c', 'dev', '-e', 'staging'])

    expect(deploy.calls[0].configDirMode).toBe(0o700)
    expect(deploy.calls[0].secretFile?.mode).toBe(0o600)
    expect(dev.calls[0].devVarsMode).toBe(0o600)
  })

  it('removes a run whose owner is dead, and leaves one that is alive', async () => {
    const fixture = project()
    const runs = join(fixture.root, '.monocf', 'runs')
    mkdirSync(join(runs, 'dead'), {recursive: true})
    mkdirSync(join(runs, 'alive'), {recursive: true})
    // A process that has ended, and this test's own process.
    writeFileSync(join(runs, 'dead', 'owner.pid'), '999999999')
    writeFileSync(join(runs, 'alive', 'owner.pid'), String(process.pid))

    await runCli(fixture, ['worker', 'gateway', '-c', 'deploy'])

    expect(readdirSync(runs)).toEqual(['alive'])
  })

  it('removes a run older than a day, even if its owner looks alive', async () => {
    const fixture = project()
    const old = join(fixture.root, '.monocf', 'runs', 'old')
    mkdirSync(old, {recursive: true})
    writeFileSync(join(old, 'owner.pid'), String(process.pid))
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(old, longAgo, longAgo)

    await runCli(fixture, ['worker', 'gateway', '-c', 'deploy'])

    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(fixture.root, '.monocf'))).toBe(false)
  })

  it('is ignored by git while it exists, with nothing in the consumer .gitignore', async () => {
    const fixture = project()
    const running = startCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-e', 'staging', '-s'], {
      rules: [{command: 'deploy', delayMs: 3000}],
    })
    const [call] = await running.waitForCalls(1)
    expect(existsSync(call.configDir!)).toBe(true)

    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: fixture.root,
      encoding: 'utf8',
    })

    expect(status).not.toContain('.monocf')
    await running.done
    expect(existsSync(join(fixture.root, '.monocf'))).toBe(false)
  }, 30_000)

  it('does not touch the consumer .gitignore', async () => {
    const fixture = project()
    const before = readFileSync(join(fixture.root, '.gitignore'), 'utf8')

    await runCli(fixture, ['worker', 'gateway', '-c', 'deploy'])

    expect(readFileSync(join(fixture.root, '.gitignore'), 'utf8')).toBe(before)
  })
})

describe('the result of an upload', () => {
  it.each([
    ['deploy', 'deploy'],
    ['preview', 'versions upload'],
  ])('%s fails when wrangler exits 0 without a version ID', async (command, rule) => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', command], {
      rules: [{command: rule, noOutputEntry: true}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('version ID')
  })

  it('reports the message of a failure from the output file', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'], {
      rules: [{command: 'deploy', exitCode: 1, failCode: 10_000, failMessage: 'Authentication error'}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Authentication error')
  })

  it('a build needs no version ID', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'], {
      rules: [{command: 'deploy', noOutputEntry: true}],
    })

    expect(result.exitCode).toBe(0)
  })
})

describe('RELEASE', () => {
  const env = {GITHUB_SHA: 'abcdef0123456789'}

  it.each([
    ['deploy', 'deploy'],
    ['preview', 'versions'],
    ['dev', 'dev'],
  ])('%s passes the first 7 characters of GITHUB_SHA', async (command, subcommand) => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', command], {env})

    expect(result.calls[0].argv[0]).toBe(subcommand)
    expect(releaseOf(result.calls[0])).toBe('abcdef0')
    expect(result.calls[0].argv).not.toContain('--keep-vars')
  })

  it('a dry-run build gets none, so its bundle does not depend on the commit', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'], {env})

    expect(releaseOf(result.calls[0])).toBeUndefined()
  })

  it('without GITHUB_SHA, it comes from git', async () => {
    const fixture = project()
    const short = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: fixture.root, encoding: 'utf8'}).trim()

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'])

    expect(releaseOf(result.calls[0])).toBe(short)
  })

  it('outside a repository, it is "unknown" with a notice', async () => {
    const fixture = project()
    rmSync(join(fixture.root, '.git'), {force: true, maxRetries: 5, recursive: true})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'], {
      env: {GIT_CEILING_DIRECTORIES: join(fixture.root, '..')},
    })

    expect(result.exitCode).toBe(0)
    expect(releaseOf(result.calls[0])).toBe('unknown')
    expect(result.stderr).toContain('RELEASE')
  })

  it('is the same on every worker of a run', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', '-a', '-c', 'deploy'], {env})

    expect(result.calls.map((call) => releaseOf(call))).toEqual(['abcdef0', 'abcdef0'])
  })

  it('does not appear on the secret or version-promotion calls', async () => {
    const fixture = project()

    const secrets = await runCli(fixture, ['secrets', 'deploy', 'gateway', '-e', 'staging'], {env})
    const promote = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-f'], {env})

    for (const call of [...secrets.calls, ...promote.calls]) expect(releaseOf(call)).toBeUndefined()
  })
})

describe('dev', () => {
  it('keeps local data in the tree of the worker', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'dev'])

    expect(fromRoot(fixture, flagValue(result.calls[0], '--persist-to')!)).toBe('workers/gateway/.wrangler/state')
  })

  it('writes the merged env file next to the config and leaves the source files alone (F03)', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'dev', '-e', 'staging'])

    expect(result.calls[0].devVars).toEqual({KEY: 'gateway-staging', ROOT: 'staging'})
    expect(readFileSync(join(fixture.worker('gateway'), '.dev.vars.staging'), 'utf8')).toBe('KEY=gateway-staging')
  })

  it('round-trips values that a plain KEY=value file would break (F02)', async () => {
    const value = {
      BACKTICK: 'a`b',
      EQUALS: 'a=b=c',
      HASH: 'value # not a comment',
      NEWLINE: 'line1\nline2',
      PEM: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
      QUOTES: `it's "quoted"`,
      SPACES: '  padded  ',
    }
    const source = Object.entries(value)
      .map(([key, content]) => `${key}=${content.includes('`') ? `"${content}"` : `\`${content}\``}`)
      .join('\n')
    const fixture = createFixture({files: {'workers/orders/.dev.vars': source}, workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev'])

    expect(result.calls[0].devVars).toEqual(value)
  })
})

describe('-d', () => {
  it('notes a binding it leaves out because it is ignored', async () => {
    const fixture = createFixture({
      ignore: ['orders'],
      workers: [{bindings: ['orders'], name: 'gateway'}, {name: 'orders'}],
    })

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-d'])

    expect(result.stderr).toContain('orders')
    expect(result.stderr).toContain('.monocfignore')
  })

  it('stops at the first failure, and does not deploy what depends on it', async () => {
    const fixture = createFixture({workers: [{bindings: ['orders'], name: 'gateway'}, {name: 'orders'}]})

    const result = await runCli(fixture, ['worker', 'gateway', '-c', 'deploy', '-d'], {
      rules: [{command: 'deploy', exitCode: 1, worker: 'orders'}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.calls.map((call) => call.config?.name)).toEqual(['orders-v1'])
  })
})

describe('the pool', () => {
  const chain = {
    workers: [{bindings: ['middle'], name: 'caller'}, {bindings: ['target'], name: 'middle'}, {name: 'other'}, {name: 'target'}],
  }

  it('deploy -a runs callees first, one at a time by default', async () => {
    const result = await runCli(createFixture(chain), ['worker', '-a', '-c', 'deploy'])

    expect(result.exitCode).toBe(0)
    expect(deployedNames(result.calls, 'deploy')).toEqual(['other-v1', 'target-v1', 'middle-v1', 'caller-v1'])
  })

  it('deploy -a skips the transitive callers of a failure and carries on with the rest', async () => {
    const result = await runCli(createFixture(chain), ['worker', '-a', '-c', 'deploy'], {
      rules: [{command: 'deploy', exitCode: 1, worker: 'target'}],
    })

    expect(result.exitCode).toBe(1)
    expect(deployedNames(result.calls, 'deploy')).toEqual(['other-v1', 'target-v1'])
    expect(result.stderr).toContain('middle: deploy skipped, because target failed')
    expect(result.stderr).toContain('caller: deploy skipped, because target failed')
  })

  it('reports skipped workers as events with --json', async () => {
    const result = await runCli(createFixture(chain), ['worker', '-a', '-c', 'deploy', '--json'], {
      rules: [{command: 'deploy', exitCode: 1, worker: 'target'}],
    })

    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(events.filter(({status}) => status === 'skipped')).toEqual([
      expect.objectContaining({reason: 'target', type: 'step-finished', worker: 'middle'}),
      expect.objectContaining({reason: 'target', type: 'step-finished', worker: 'caller'}),
    ])
    expect(events.find(({type}) => type === 'run-finished')).toMatchObject({exitCode: 1, status: 'failed'})
  })

  it('names every failure in the error when several workers fail', async () => {
    const result = await runCli(createFixture(chain), ['worker', '-a', '-c', 'deploy'], {
      rules: [
        {command: 'deploy', exitCode: 3, worker: 'target'},
        {command: 'deploy', exitCode: 4, worker: 'other'},
      ],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('2 workers failed')
    expect(result.stderr).toContain('target: wrangler deploy failed with exit code 3')
    expect(result.stderr).toContain('other: wrangler deploy failed with exit code 4')
  })

  it('-d keeps callees before callers at any concurrency', async () => {
    const result = await runCli(createFixture(chain), ['worker', 'caller', '-c', 'deploy', '-d', '--concurrency', '4'])

    expect(deployedNames(result.calls, 'deploy')).toEqual(['target-v1', 'middle-v1', 'caller-v1'])
  })

  it('deploy --concurrency runs independent workers at once, and labels their output', async () => {
    const fixture = createFixture({workers: [{name: 'a'}, {name: 'b'}]})

    const running = startCli(fixture, ['worker', '-a', '-c', 'deploy', '--concurrency', '2'], {
      rules: [{command: 'deploy', holdMs: 60_000, stdout: 'hello\n'}],
    })
    // Two calls in flight at once are possible only when the second didn't wait for the first.
    await running.waitForCalls(2)
    running.child.kill('SIGKILL')
    await running.done.catch(() => {})
  })

  it('build -a runs in parallel by default and a failure holds nothing back', async () => {
    const result = await runCli(createFixture(chain), ['worker', '-a', '-c', 'build'], {
      rules: [{command: 'deploy', exitCode: 1, worker: 'target'}],
    })

    expect(result.exitCode).toBe(1)
    expect(deployedNames(result.calls, 'deploy').sort()).toEqual(['caller-v1', 'middle-v1', 'other-v1', 'target-v1'])
  })

  it('build --concurrency 1 runs in order', async () => {
    const result = await runCli(createFixture(chain), ['worker', '-a', '-c', 'build', '--concurrency', '1'])

    expect(deployedNames(result.calls, 'deploy')).toEqual(['caller-v1', 'middle-v1', 'other-v1', 'target-v1'])
  })

  it.each([
    ['dev', ['worker', 'caller', '-c', 'dev', '--concurrency', '2'], 'not supported'],
    ['--from-version', ['worker', 'caller', '-c', 'deploy', '-f', '--concurrency', '2'], 'no effect'],
    ['zero', ['worker', '-a', '-c', 'build', '--concurrency', '0'], 'concurrency'],
  ])('rejects --concurrency with %s', async (_, args, message) => {
    const result = await runCli(createFixture(chain), args, {noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(message)
    expect(result.calls).toEqual([])
  })
})

describe('--json', () => {
  it('prints events on stdout as NDJSON, and keeps wrangler on stderr', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '--json'], {
      rules: [{command: 'deploy', stdout: 'wrangler says hello\n'}],
    })

    expect(result.exitCode).toBe(0)
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.every((event) => event.schemaVersion === 1)).toBe(true)
    expect(events.map((event) => event.type)).toEqual(['run-started', 'step-started', 'step-finished', 'run-finished'])
    expect(events[2]).toMatchObject({status: 'ok', versionId: 'version-of-orders', worker: 'orders'})
    expect(events[3]).toMatchObject({exitCode: 0, status: 'ok'})
    expect(result.stderr).toContain('wrangler says hello')
  })

  it('reports a failure in the events', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '--json'], {
      rules: [{command: 'deploy', exitCode: 1, failMessage: 'nope'}],
    })

    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(result.exitCode).toBe(1)
    expect(events.find((event) => event.type === 'step-finished')).toMatchObject({status: 'failed', worker: 'orders'})
    expect(events.find((event) => event.type === 'run-finished')).toMatchObject({exitCode: 1, status: 'failed'})
    expect(events.at(-1)).toMatchObject({exitCode: 1, type: 'error'})
  })

  it('reports a usage error as an event', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'nope', '-c', 'deploy', '--json'], {noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({exitCode: 2, schemaVersion: 1, type: 'error'})
  })

  it('keeps single-worker dev off stdout', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'dev', '--json'], {
      rules: [{command: 'dev', stdout: 'ready\n'}],
    })

    expect(result.stdout).not.toContain('ready')
    expect(result.stderr).toContain('ready')
  })
})

describe('errors', () => {
  it('prints one line and no stack', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'], {
      rules: [{command: 'deploy', exitCode: 1}],
    })

    const errors = result.stderr.split('\n').filter((line) => line.startsWith('Error:'))
    expect(errors).toHaveLength(1)
    expect(result.stderr).not.toMatch(/^\s+at /m)
  })

  it('prints the stack with DEBUG', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'], {
      env: {DEBUG: '1'},
      rules: [{command: 'deploy', exitCode: 1}],
    })

    expect(result.stderr).toMatch(/^\s+at /m)
  })
})

describe('dev -a output', () => {
  it('prefixes each line with its process', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['worker', '-a', '-c', 'dev'], {
      rules: [{command: 'dev', stderr: 'problem\n', stdout: 'one\ntwo\n', worker: 'orders'}],
    })

    expect(result.stderr).toContain('[orders] one')
    expect(result.stderr).toContain('[orders] two')
    expect(result.stderr).toContain('[orders] problem')
    expect(result.stdout).not.toContain('one')
  })

  it('stops the rest and fails when one child fails', async () => {
    const fixture = createFixture({workers: [{name: 'billing'}, {name: 'orders'}]})
    const running = startCli(fixture, ['worker', '-a', '-c', 'dev'], {
      rules: [
        {command: 'dev', exitCode: 1, worker: 'orders'},
        {command: 'dev', holdMs: 30_000},
      ],
    })

    const result = await running.done

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('orders: wrangler dev failed')
    expect(existsSync(join(fixture.root, '.monocf', 'runs'))).toBe(false)
  }, 30_000)
})

describe.skipIf(isWindows)('signals', () => {
  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ] as const)('%s reaches wrangler, cleans up and exits %i', async (signal, exitCode) => {
    const fixture = project()
    const running = startCli(fixture, ['worker', 'orders', '-c', 'deploy'], {
      rules: [{command: 'deploy', holdMs: 30_000}],
    })
    const [call] = await running.waitForCalls(1)
    expect(existsSync(call.configDir!)).toBe(true)

    running.child.kill(signal)
    const result = await running.done

    expect(result.exitCode).toBe(exitCode)
    expect(running.signals()).toEqual([`orders ${signal}`])
    expect(existsSync(join(fixture.root, '.monocf'))).toBe(false)
  }, 30_000)

  it('starts no further step after a signal', async () => {
    const fixture = createFixture({workers: [{name: 'billing'}, {name: 'orders'}]})
    const running = startCli(fixture, ['worker', '-a', '-c', 'deploy'], {
      rules: [{command: 'deploy', holdMs: 30_000, worker: 'billing'}],
    })
    await running.waitForCalls(1)

    running.child.kill('SIGTERM')
    const result = await running.done

    expect(result.exitCode).toBe(143)
    expect(result.calls.map((call) => call.config?.name)).toEqual(['billing-v1'])
  }, 30_000)

  it('kills a child that ignores the signal after the grace period', async () => {
    const fixture = project()
    const running = startCli(fixture, ['worker', 'orders', '-c', 'deploy'], {
      rules: [{command: 'deploy', holdMs: 60_000, ignoreSignals: true}],
    })
    await running.waitForCalls(1)
    const started = Date.now()

    running.child.kill('SIGTERM')
    const result = await running.done

    expect(result.exitCode).toBe(143)
    expect(Date.now() - started).toBeGreaterThanOrEqual(9000)
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(existsSync(join(fixture.root, '.monocf'))).toBe(false)
  }, 45_000)

  it('dev -a forwards a signal to every process', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})
    const running = startCli(fixture, ['worker', '-a', '-c', 'dev'], {
      rules: [{command: 'dev', holdMs: 30_000}],
    })
    await running.waitForCalls(2)

    running.child.kill('SIGINT')
    const result = await running.done

    expect(result.exitCode).toBe(130)
    expect(running.signals().sort()).toEqual(['orders SIGINT', 'proxy-worker SIGINT'])
  }, 30_000)
})
