// Proves the pure resolver produces what the old flow hands to wrangler. Removed along with the old flow.
import {rmSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {readProjectInputs, resolveProject} from '../../src/config/resolve.js'
import {findConfigFile, loadProjectFile} from '../../src/project/load.js'
import {resolveOptions} from '../../src/project/options.js'
import {discoverWorkers, findIgnoredWorkers, selectWorkers} from '../../src/project/workers.js'
import {createFixture, runCli, type Fixture, type FixtureOptions, type WranglerConfig} from '../helpers/harness.js'

function resolveNew(fixture: Fixture, env?: string) {
  const configPath = findConfigFile(fixture.root)!
  const options = resolveOptions({configPath, cwd: fixture.root, file: loadProjectFile(configPath), flags: {env}})
  const inputs = readProjectInputs(options)
  return {inputs, options, project: resolveProject(options, inputs)}
}

function newConfig(fixture: Fixture, worker: string, env?: string): WranglerConfig {
  const {project} = resolveNew(fixture, env)
  expect(project.failures).toEqual([])
  return project.workers.find(({dir}) => dir === worker)!.config
}

async function oldConfig(fixture: Fixture, worker: string, command: string, env?: string): Promise<WranglerConfig> {
  const result = await runCli(fixture, ['worker', worker, '-c', command, ...(env ? ['-e', env] : [])])
  expect(result.exitCode, result.stderr).toBe(0)
  return result.calls.at(-1)!.config!
}

/** RELEASE is deliberately absent from the new config, so it's removed from the section the old flow wrote it to. */
function withoutRelease(config: WranglerConfig, env?: string): WranglerConfig {
  const copy = structuredClone(config)
  delete (env ? copy.env[env] : copy).vars.RELEASE
  return copy
}

async function expectParity(fixture: Fixture, worker: string, env?: string, command = 'deploy'): Promise<void> {
  const old = await oldConfig(fixture, worker, command, env)
  expect((env ? old.env[env] : old).vars.RELEASE).toBeDefined()
  expect(newConfig(fixture, worker, env)).toEqual(withoutRelease(old, env))
}

type Case = {env?: string; fixture: FixtureOptions; name: string; worker: string}

const envs = ['staging', 'production']
const jsonc = `{
  // comment
  "services": [{"binding": "BILLING", "service": "billing",},],
  "vars": {"A": "1",},
}`

const cases: Case[] = [
  {
    env: 'staging',
    fixture: {
      base: {
        assets: {directory: 'public'},
        compatibility_flags: ['nodejs_compat'],
        env: {staging: {routes: ['base.example.com/*'], vars: {SHARED: 'base'}}},
        observability: {enabled: true, head_sampling_rate: 1},
        route: 'base.example.com/*',
        triggers: {crons: ['0 0 * * *']},
      },
      workers: [
        {
          config: {
            assets: {},
            compatibility_flags: ['nodejs_compat', 'nodejs_als'],
            env: {staging: {routes: ['orders.example.com/*'], vars: {OWN: 'worker', SHARED: 'worker'}}},
            limits: {},
            main: 'src/other.ts',
            observability: {enabled: false},
            tags: [],
            triggers: {crons: []},
          },
          name: 'orders',
        },
      ],
    },
    name: 'merge: arrays concatenate, objects merge, scalars win, empties vanish',
    worker: 'orders',
  },
  {
    fixture: {
      base: {vars: {SHARED: 'base'}},
      workers: [{config: {vars: {OWN: 'worker', SHARED: 'worker'}}, name: 'orders'}],
    },
    name: 'merge without an env: vars land at the top level',
    worker: 'orders',
  },
  {
    env: 'staging',
    fixture: {
      base: {name: 'custom-{workerName}', vars: {TOP: 'kept'}},
      environments: envs,
      workers: [
        {
          config: {env: {production: {vars: {OTHER: 'kept'}}, staging: {name: 'explicit-name', vars: {X: '1'}}}},
          name: 'orders',
        },
      ],
    },
    name: 'env: an explicit env name is overwritten, other sections stay',
    worker: 'orders',
  },
  {
    env: 'preview',
    fixture: {environments: envs, workers: [{config: {env: {preview: {}}}, name: 'orders'}]},
    name: 'env: declared only in the worker, as an empty object',
    worker: 'orders',
  },
  {
    env: 'staging',
    fixture: {
      base: {env: {staging: {vars: {ENVIRONMENT: 'from-base', NAME: 'from-base', VERSION: 'from-base'}}}},
      workers: [{name: 'orders'}],
    },
    name: 'env: vars from the base config are still overwritten',
    worker: 'orders',
  },
  {
    env: 'staging',
    fixture: {
      environments: envs,
      workers: [
        {
          bindings: ['top-level-only-names-a-worker'],
          config: {
            env: {
              staging: {
                services: [
                  {binding: 'BILLING', entrypoint: 'Api', props: {a: 1}, service: 'billing'},
                  {binding: 'MY_GATEWAY', service: 'My_Gateway'},
                ],
              },
            },
          },
          name: 'orders',
        },
        {name: 'billing'},
        {name: 'My_Gateway'},
      ],
    },
    name: 'bindings: env section is rewritten, entrypoint stays, target names sanitized, top level untouched',
    worker: 'orders',
  },
  {
    fixture: {
      base: {name: 'svc-{workerName}'},
      workers: [{bindings: ['billing'], name: 'orders'}, {bindings: ['orders'], name: 'billing'}],
    },
    name: 'bindings: top level without an env, in a cycle',
    worker: 'orders',
  },
  {
    env: 'staging',
    fixture: {
      environments: envs,
      workers: [
        {
          config: {
            env: {
              staging: {
                durable_objects: {bindings: [{class_name: 'Room', name: 'ROOM', script_name: 'billing'}]},
                queues: {consumers: [{queue: 'jobs-{version}'}], producers: [{binding: 'JOBS', queue: 'jobs-{version}'}]},
                tail_consumers: [{service: 'billing'}],
                workflows: [{binding: 'FLOW', class_name: 'Flow', name: 'flow', script_name: 'billing'}],
              },
            },
          },
          name: 'orders',
        },
        {name: 'billing'},
      ],
    },
    name: 'bindings: other target fields pass through as written',
    worker: 'orders',
  },
  {
    env: 'staging',
    fixture: {
      base: {
        env: {staging: {vars: {BUILD: '{build}', CHAIN: '{chain}', LABEL: '{workerName}:{version}'}}},
        vars: {COST: '{cost}', 'key-{version}': 'value', REGEX: String.raw`^\d{3}$`, TEMPLATE: '{"json": true}'},
      },
      monocfConfig: {variables: {build: 42, chain: '{version}', cost: 'a$$b', version: 'v1'}},
      workers: [{config: {vars: {OWN: '{workerName}'}}, name: 'orders'}],
    },
    name: 'placeholders: in values and keys, chained, numeric, and strings that only look like one',
    worker: 'orders',
  },
  {
    env: 'staging',
    fixture: {
      base: false,
      monocfConfig: {variables: {version: 'v1'}},
      workers: [
        {
          config: {assets: {}, env: {staging: {vars: {V: '{version}'}}}, limits: {}, name: 'Orders_API', tags: []},
          name: 'orders',
        },
      ],
    },
    name: 'no base config: nothing merges, so empties stay; the name is sanitized',
    worker: 'orders',
  },
  {
    env: 'staging',
    fixture: {
      environments: envs,
      files: {'workers/orders/package.json': '{"name": "orders"}'},
      workers: [{name: 'orders'}],
    },
    name: 'a package.json with no version sets no VERSION',
    worker: 'orders',
  },
  {
    fixture: {
      files: {'workers/orders/wrangler.jsonc': jsonc},
      workers: [{name: 'billing'}, {name: 'orders'}],
    },
    name: 'JSONC: comments and trailing commas',
    worker: 'orders',
  },
]

describe('old flow and resolver agree', () => {
  it.each(cases)('$name', async ({env, fixture, worker}) => {
    await expectParity(createFixture(fixture), worker, env)
  })

  it('preview receives the same config as deploy', async () => {
    const fixture = createFixture({
      environments: envs,
      workers: [{envBindings: {staging: ['billing']}, name: 'orders'}, {name: 'billing'}],
    })

    await expectParity(fixture, 'orders', 'staging', 'preview')
  })

  it('selects the same workers under -a with an ignore file, each with the same config', async () => {
    const fixture = createFixture({
      environments: envs,
      ignore: ['workers/gateway', '**/exp-*', 'legacy'],
      workers: [
        {envBindings: {staging: ['gateway']}, name: 'orders'},
        {name: 'billing'},
        {name: 'gateway'},
        {name: 'exp-one'},
        {name: 'legacy'},
      ],
    })

    const result = await runCli(fixture, ['worker', '-a', '-c', 'deploy', '-e', 'staging'])
    expect(result.exitCode, result.stderr).toBe(0)

    const {options, project} = resolveNew(fixture, 'staging')
    const all = discoverWorkers(options)
    const selected = selectWorkers(all, findIgnoredWorkers(options, all))
    expect(selected).toEqual(['billing', 'orders'])

    const expected = selected.map((dir) => project.workers.find((worker) => worker.dir === dir)!.config)
    const received = result.calls.map((call) => withoutRelease(call.config!, 'staging'))
    expect(received).toEqual(expect.arrayContaining(expected))
    expect(received).toHaveLength(expected.length)
  })
})

describe('deliberate differences from the old flow', () => {
  it('build still names bindings without the env suffix in the old flow; the resolver uses the deploy form', async () => {
    const fixture = createFixture({
      environments: envs,
      workers: [{envBindings: {staging: ['billing']}, name: 'orders'}, {name: 'billing'}],
    })

    const old = await oldConfig(fixture, 'orders', 'build', 'staging')
    expect(old.env.staging.services[0].service).toBe('billing-v1')
    expect(newConfig(fixture, 'orders', 'staging').env.staging.services[0].service).toBe('billing-v1-staging')
  })

  it('keeps a var set in the worker config, which the old flow overwrites', async () => {
    const fixture = createFixture({
      environments: envs,
      workers: [
        {
          config: {env: {staging: {vars: {ENVIRONMENT: 'mine', NAME: 'mine', RELEASE: 'mine', VERSION: 'mine'}}}},
          name: 'orders',
        },
      ],
    })

    const old = await oldConfig(fixture, 'orders', 'deploy', 'staging')
    expect(old.env.staging.vars).toMatchObject({ENVIRONMENT: 'staging', NAME: 'orders-v1', VERSION: '1.0.0'})

    const {vars} = newConfig(fixture, 'orders', 'staging').env.staging
    expect(vars).toEqual({ENVIRONMENT: 'mine', NAME: 'mine', STAGE: 'staging', VERSION: 'mine'})
  })

  it('rejects an unknown placeholder, which the old flow deploys as literal text', async () => {
    const fixture = createFixture({workers: [{config: {vars: {PATH: '/users/{id}/{version}'}}, name: 'orders'}]})

    const old = await oldConfig(fixture, 'orders', 'deploy')
    expect(old.vars.PATH).toBe('/users/{id}/v1')

    const {failures} = resolveNew(fixture).project
    expect(failures[0].dir).toBe('orders')
    expect(failures[0].error.message).toContain('{id}')
    expect(failures[0].error.file).toBe(fixture.worker('orders') + String.raw`\wrangler.jsonc`.replaceAll('\\', sep()))
  })

  it('accepts a variable with a quote or a backslash, which the old flow turns into broken JSON', async () => {
    const fixture = createFixture({
      monocfConfig: {variables: {path: String.raw`C:\tmp`, quote: 'say "hi"', version: 'v1'}},
      workers: [{config: {vars: {PATH: '{path}', QUOTE: '{quote}'}}, name: 'orders'}],
    })

    const old = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'], {noCalls: true})
    expect(old.exitCode).not.toBe(0)
    expect(old.calls).toEqual([])

    expect(newConfig(fixture, 'orders').vars).toMatchObject({PATH: String.raw`C:\tmp`, QUOTE: 'say "hi"'})
  })

  it('reports null in a worker config clearly, where the old flow crashes on it', async () => {
    const fixture = createFixture({workers: [{config: {route: null}, name: 'orders'}]})

    const old = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'], {noCalls: true})
    expect(old.exitCode).not.toBe(0)
    expect(old.stderr).toContain('Cannot convert undefined or null to object')

    const [{error}] = resolveNew(fixture).project.failures
    expect(error.message).toContain('"route" is null')
  })

  it('passes a binding to an unknown worker through, where the old flow fails', async () => {
    const fixture = createFixture({
      environments: envs,
      workers: [{envBindings: {staging: ['someone-elses-worker']}, name: 'orders'}],
    })

    const old = await runCli(fixture, ['worker', 'orders', '-c', 'deploy', '-e', 'staging'], {noCalls: true})
    expect(old.exitCode).not.toBe(0)

    const {project} = resolveNew(fixture, 'staging')
    expect(project.workers[0].bindings[0].target).toEqual({kind: 'external', name: 'someone-elses-worker'})
    expect(project.notices.map(({type}) => type)).toEqual(['external-binding'])
  })

  it('falls back to 0.0.0 with no package.json, where the old flow fails', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})
    rmSync(join(fixture.worker('orders'), 'package.json'))

    const old = await runCli(fixture, ['worker', 'orders', '-c', 'deploy'], {noCalls: true})
    expect(old.exitCode).not.toBe(0)

    const {project} = resolveNew(fixture)
    expect((project.workers[0].config.vars as WranglerConfig).VERSION).toBe('0.0.0')
    expect(project.notices.map(({type}) => type)).toEqual(['missing-package-json'])
  })
})

function sep(): string {
  return process.platform === 'win32' ? '\\' : '/'
}
