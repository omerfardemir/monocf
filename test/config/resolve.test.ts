import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {envSection, readProjectInputs, resolveProject, sanitizeWorkerName} from '../../src/config/resolve.js'
import type {Notice, RawConfig} from '../../src/config/types.js'
import {resolveOptions} from '../../src/project/options.js'
import {memoryReader, projectRoot} from '../helpers/memory-reader.js'

type Files = Record<string, unknown>

function worker(name: string, config: RawConfig = {}, version = '1.0.0'): Files {
  return {
    [`workers/${name}/package.json`]: {version},
    [`workers/${name}/wrangler.jsonc`]: config,
  }
}

const base = {
  'base.wrangler.jsonc': {
    env: {production: {}, staging: {}},
    main: 'src/index.ts',
    name: '{workerName}-{version}',
  },
}

const defaultVariables = {version: 'v1'}

function resolveFiles(files: Files, env?: string, variables: Record<string, string> = defaultVariables) {
  const reader = memoryReader(files)
  const options = resolveOptions({
    cwd: projectRoot,
    file: {variables, workersDirName: 'workers'},
    flags: {env},
    reader,
  })
  const inputs = readProjectInputs(options, reader)
  return {inputs, options, project: resolveProject(options, inputs), reader}
}

function resolved(files: Files, dir: string, env?: string) {
  const {project} = resolveFiles(files, env)
  expect(project.failures).toEqual([])
  return project.workers.find((candidate) => candidate.dir === dir)!
}

function noticesOf<T extends Notice['type']>(notices: Notice[], type: T) {
  return notices.filter((notice): notice is Extract<Notice, {type: T}> => notice.type === type)
}

function varsOf(config: RawConfig, env?: string) {
  return envSection(config, env).vars
}

function binding(service: string, entry: RawConfig = {}) {
  return {env: {staging: {services: [{binding: 'B', service, ...entry}]}}}
}

function services(...targets: string[]) {
  return {env: {staging: {services: targets.map((service) => ({binding: service.toUpperCase(), service}))}}}
}

function totalReads(reader: {reads: Map<string, number>}): number {
  return [...reader.reads.values()].reduce((sum, count) => sum + count, 0)
}

describe('names', () => {
  it('uses {workerName}-{version}, then -<env> for an env', () => {
    const orders = resolved({...base, ...worker('orders')}, 'orders', 'staging')
    expect(orders.config).toMatchObject({env: {staging: {name: 'orders-v1-staging'}}, name: 'orders-v1'})
    expect(orders.deployedName).toBe('orders-v1-staging')
    expect(orders.env).toBe('staging')
  })

  it('uses the plain name with no env', () => {
    const orders = resolved({...base, ...worker('orders')}, 'orders')
    expect(orders.deployedName).toBe('orders-v1')
    expect(orders.env).toBeUndefined()
  })

  it('overwrites an explicit env name, as before', () => {
    const files = {...base, ...worker('orders', {env: {staging: {name: 'my-name'}}})}
    expect(resolved(files, 'orders', 'staging').deployedName).toBe('orders-v1-staging')
  })

  it('replaces characters a name cannot hold, without lowercasing', () => {
    expect(sanitizeWorkerName('MyWorker_API')).toBe('-y-orker----')
    expect(sanitizeWorkerName('ok-1')).toBe('ok-1')
  })

  it('reports a worker with no name', () => {
    const {project} = resolveFiles(worker('orders', {main: 'x.ts'}))
    expect(project.failures[0].error.message).toContain('no name')
  })
})

describe('injected vars', () => {
  it('writes them to the env section when an env is selected, and leaves the top level alone', () => {
    const {config} = resolved({...base, ...worker('orders', {vars: {TOP: '1'}})}, 'orders', 'staging')
    expect(varsOf(config, 'staging')).toEqual({ENVIRONMENT: 'staging', NAME: 'orders-v1', VERSION: '1.0.0'})
    expect(config.vars).toEqual({TOP: '1'})
  })

  it('writes them to the top level with no env, with ENVIRONMENT dev', () => {
    const {config} = resolved({...base, ...worker('orders', {vars: {TOP: '1'}})}, 'orders')
    expect(config.vars).toEqual({ENVIRONMENT: 'dev', NAME: 'orders-v1', TOP: '1', VERSION: '1.0.0'})
  })

  it('never includes RELEASE, even one set explicitly', () => {
    const files = {...base, ...worker('orders', {env: {staging: {vars: {RELEASE: 'x'}}}})}
    expect(varsOf(resolved(files, 'orders', 'staging').config, 'staging')).not.toHaveProperty('RELEASE')
  })

  it('keeps a var set in the worker own section', () => {
    const vars = {ENVIRONMENT: 'a', NAME: 'b', VERSION: 'c'}
    const files = {...base, ...worker('orders', {env: {staging: {vars}}})}
    expect(varsOf(resolved(files, 'orders', 'staging').config, 'staging')).toEqual(vars)
  })

  it('overwrites a var that comes from the base config', () => {
    const files = {
      'base.wrangler.jsonc': {env: {staging: {vars: {NAME: 'base'}}}, name: '{workerName}'},
      ...worker('orders'),
    }
    expect(varsOf(resolved(files, 'orders', 'staging').config, 'staging')).toMatchObject({NAME: 'orders'})
  })

  it('does not treat a var from another section as explicit', () => {
    const files = {...base, ...worker('orders', {vars: {NAME: 'top'}})}
    expect(varsOf(resolved(files, 'orders', 'staging').config, 'staging')).toMatchObject({NAME: 'orders-v1'})
  })

  it('falls back to VERSION 0.0.0 with a notice when there is no package.json', () => {
    const {project} = resolveFiles({...base, 'workers/orders/wrangler.jsonc': {}})
    expect(project.workers[0].config.vars).toMatchObject({VERSION: '0.0.0'})
    expect(noticesOf(project.notices, 'missing-package-json')).toEqual([
      expect.objectContaining({file: join(projectRoot, 'workers', 'orders', 'package.json'), worker: 'orders'}),
    ])
  })

  it('sets no VERSION with a notice when package.json has no version, and removes one from the base', () => {
    const {project} = resolveFiles({
      'base.wrangler.jsonc': {name: '{workerName}', vars: {VERSION: 'base'}},
      'workers/orders/package.json': {name: 'orders'},
      'workers/orders/wrangler.jsonc': {},
    })
    expect(project.workers[0].config.vars).not.toHaveProperty('VERSION')
    expect(noticesOf(project.notices, 'missing-version')).toHaveLength(1)
  })

  it('reports an invalid package.json as a failure of that worker', () => {
    const {project} = resolveFiles({...base, 'workers/orders/package.json': '{', 'workers/orders/wrangler.jsonc': {}})
    expect(project.failures[0].error.message).toContain('Invalid package.json')
  })
})

describe('placeholders', () => {
  it('expands {workerName} only with a base config, as before', () => {
    const {project} = resolveFiles(worker('orders', {name: '{workerName}'}))
    expect(project.failures[0].error.message).toContain('Unknown placeholder {workerName}')
  })

  it('names the placeholder and the worker file', () => {
    const {project} = resolveFiles({...base, ...worker('orders', {vars: {A: '{nope}'}})})
    expect(project.failures[0].error.message).toContain('{nope}')
    expect(project.failures[0].error.file).toBe(join(projectRoot, 'workers', 'orders', 'wrangler.jsonc'))
  })

  it('names the base file when the placeholder comes from there', () => {
    const {project} = resolveFiles({'base.wrangler.jsonc': {name: '{workerName}', vars: {A: '{nope}'}}, ...worker('orders')})
    expect(project.failures[0].error.file).toBe(join(projectRoot, 'base.wrangler.jsonc'))
  })

  it('names the project file when a variable expands into an unknown placeholder', () => {
    const files = {...base, ...worker('orders', {vars: {A: '{a}'}})}
    const {project} = resolveFiles(files, undefined, {a: '{nope}', version: 'v1'})
    expect(project.failures[0].error.file).toBe('monocf.config.json')
  })

  it('checks every env section, since all of them reach wrangler', () => {
    const files = {...base, ...worker('orders', {env: {production: {vars: {A: '{nope}'}}}})}
    expect(resolveFiles(files, 'staging').project.failures).toHaveLength(1)
  })

  it('ignores a placeholder that the worker overrides', () => {
    const files = {'base.wrangler.jsonc': {main: '{nope}', name: '{workerName}'}, ...worker('orders', {main: 'a.ts'})}
    expect(resolveFiles(files).project.failures).toEqual([])
  })
})

describe('env selection', () => {
  it('reads service bindings of the env section only, since they do not inherit', () => {
    const files = {
      ...base,
      ...worker('orders', {
        env: {staging: {services: [{binding: 'B', service: 'billing'}]}},
        services: [{binding: 'G', service: 'gateway'}],
      }),
      ...worker('billing'),
      ...worker('gateway'),
    }

    expect(resolved(files, 'orders', 'staging').bindings.map(({binding}) => binding)).toEqual(['B'])
    expect(resolved(files, 'orders', 'production').bindings).toEqual([])
    expect(resolved(files, 'orders').bindings.map(({binding}) => binding)).toEqual(['G'])
  })

  it('leaves the top-level services as written when an env is selected', () => {
    const files = {
      ...base,
      ...worker('orders', {
        env: {staging: {services: [{binding: 'B', service: 'billing'}]}},
        services: [{binding: 'B', service: 'billing'}],
      }),
      ...worker('billing'),
    }
    const {config} = resolved(files, 'orders', 'staging')
    expect(config.services).toEqual([{binding: 'B', service: 'billing'}])
    expect(envSection(config, 'staging').services).toEqual([{binding: 'B', service: 'billing-v1-staging'}])
  })

  it('returns an empty section for an env the config does not have', () => {
    expect(envSection({env: {a: {}}}, 'b')).toEqual({})
    expect(envSection({a: 1})).toEqual({a: 1})
  })
})

describe('binding targets', () => {
  it('matches a directory name and rewrites it to the deployed name', () => {
    const files = {...base, ...worker('orders', binding('billing')), ...worker('billing')}
    const orders = resolved(files, 'orders', 'staging')
    expect(orders.bindings).toEqual([{binding: 'B', source: 'services', target: {dir: 'billing', kind: 'local'}}])
    expect(envSection(orders.config, 'staging').services).toEqual([{binding: 'B', service: 'billing-v1-staging'}])
  })

  it('keeps the entrypoint and any other field', () => {
    const entry = {entrypoint: 'Api', props: {a: 1}}
    const files = {...base, ...worker('orders', binding('billing', entry)), ...worker('billing')}
    const orders = resolved(files, 'orders', 'staging')
    expect(orders.bindings[0].entrypoint).toBe('Api')
    expect(envSection(orders.config, 'staging').services).toEqual([
      {binding: 'B', ...entry, service: 'billing-v1-staging'},
    ])
  })

  it('matches a deployed name of this env, leaves it as written and reports it', () => {
    const files = {...base, ...worker('orders', binding('billing-v1-staging')), ...worker('billing')}
    const {project} = resolveFiles(files, 'staging')
    const orders = project.workers.find(({dir}) => dir === 'orders')!
    expect(orders.bindings[0].target).toEqual({dir: 'billing', kind: 'local'})
    expect(envSection(orders.config, 'staging').services).toEqual([{binding: 'B', service: 'billing-v1-staging'}])
    expect(noticesOf(project.notices, 'hardcoded-name')).toEqual([
      expect.objectContaining({
        binding: 'B',
        name: 'billing-v1-staging',
        source: 'services',
        targetDir: 'billing',
        targetEnv: 'staging',
        worker: 'orders',
      }),
    ])
    expect(noticesOf(project.notices, 'external-binding')).toEqual([])
  })

  it('treats the deployed name of another env as external, and reports it as hardcoded', () => {
    const files = {...base, ...worker('orders', binding('billing-v1-production')), ...worker('billing')}
    const {project} = resolveFiles(files, 'staging')
    const orders = project.workers.find(({dir}) => dir === 'orders')!
    expect(orders.bindings[0].target).toEqual({kind: 'external', name: 'billing-v1-production'})
    expect(noticesOf(project.notices, 'hardcoded-name')[0]).toMatchObject({
      targetDir: 'billing',
      targetEnv: 'production',
    })
  })

  it('prefers a directory over a deployed name', () => {
    const files = {
      ...base,
      ...worker('orders', binding('billing-v1-staging')),
      ...worker('billing'),
      ...worker('billing-v1-staging'),
    }
    expect(resolved(files, 'orders', 'staging').bindings[0].target).toEqual({
      dir: 'billing-v1-staging',
      kind: 'local',
    })
  })

  it('passes an unknown name through as external with a notice', () => {
    const {project} = resolveFiles({...base, ...worker('orders', binding('someone-else'))}, 'staging')
    const [orders] = project.workers
    expect(orders.bindings[0].target).toEqual({kind: 'external', name: 'someone-else'})
    expect(envSection(orders.config, 'staging').services).toEqual([{binding: 'B', service: 'someone-else'}])
    expect(noticesOf(project.notices, 'external-binding')).toEqual([
      expect.objectContaining({binding: 'B', name: 'someone-else', source: 'services', worker: 'orders'}),
    ])
  })

  it('resolves the other target fields without rewriting them', () => {
    const section = {
      durable_objects: {
        bindings: [
          {class_name: 'Own', name: 'OWN'},
          {class_name: 'Room', name: 'ROOM', script_name: 'billing'},
        ],
      },
      tail_consumers: [{service: 'gateway'}],
      workflows: [{binding: 'FLOW', class_name: 'Flow', name: 'flow', script_name: 'elsewhere'}],
    }
    const files = {
      ...base,
      ...worker('orders', {env: {staging: section}}),
      ...worker('billing'),
      ...worker('gateway'),
    }
    const orders = resolved(files, 'orders', 'staging')
    expect(orders.bindings).toEqual([
      {binding: 'ROOM', source: 'durable_objects', target: {dir: 'billing', kind: 'local'}},
      {binding: 'gateway', source: 'tail_consumers', target: {dir: 'gateway', kind: 'local'}},
      {binding: 'FLOW', source: 'workflows', target: {kind: 'external', name: 'elsewhere'}},
    ])
    expect(envSection(orders.config, 'staging')).toMatchObject(section)
  })

  it.each([
    ['services is not a list', {services: {a: 1}}, '"services" must be a list'],
    ['a service is not a string', {services: [{binding: 'B', service: 1}]}, '"service" must be a string'],
    ['a script_name is not a string', {workflows: [{script_name: 1}]}, '"script_name" must be a string'],
  ])('reports a failure when %s', (_name, config, message) => {
    const {project} = resolveFiles({...base, ...worker('orders', config)})
    expect(project.failures[0].error.message).toContain(message)
  })
})

describe('failures', () => {
  const broken = {'workers/broken/package.json': {version: '1.0.0'}, 'workers/broken/wrangler.jsonc': '{'}

  it('keep a broken worker from stopping the others', () => {
    const {project} = resolveFiles({...base, ...broken, ...worker('orders')})
    expect(project.failures.map(({dir}) => dir)).toEqual(['broken'])
    expect(project.workers.map(({dir}) => dir)).toEqual(['orders'])
  })

  it('spread to a worker with a service binding to it, as it needs the target name', () => {
    const services = [{binding: 'B', service: 'broken'}]
    const {project} = resolveFiles({...base, ...broken, ...worker('orders', {services})})
    expect(project.failures.map(({dir}) => dir)).toEqual(['broken', 'orders'])
  })

  it('do not spread through a field that passes through', () => {
    const {project} = resolveFiles({...base, ...broken, ...worker('orders', {workflows: [{script_name: 'broken'}]})})
    expect(project.failures.map(({dir}) => dir)).toEqual(['broken'])
  })

  it('stop everything when the base config is broken', () => {
    expect(() => resolveFiles({'base.wrangler.jsonc': '{', ...worker('orders')})).toThrow('Invalid JSON')
  })

  it('stop everything when a named base config is missing', () => {
    const reader = memoryReader(worker('orders'))
    const file = {baseConfig: 'missing.jsonc', workersDirName: 'workers'}
    const options = resolveOptions({cwd: projectRoot, file, reader})
    expect(() => readProjectInputs(options, reader)).toThrow('does not exist')
  })
})

describe('memoization', () => {
  // A diamond closed into a cycle, where the old flow revisits shared workers once per path.
  const files: Files = {
    ...base,
    ...worker('a', services('b', 'c')),
    ...worker('b', services('d')),
    ...worker('c', services('d')),
    ...worker('d', services('a')),
  }

  it('reads every file once to resolve all workers in one env', () => {
    const {project, reader} = resolveFiles(files, 'staging')
    expect(project.workers).toHaveLength(4)
    expect(reader.reads.size).toBe(9)
    expect(totalReads(reader)).toBe(9)
  })

  it('reads nothing while resolving', () => {
    const {inputs, options, reader} = resolveFiles(files, 'staging')
    const before = totalReads(reader)
    resolveProject(options, inputs)
    resolveProject({...options, env: 'production'}, inputs)
    expect(totalReads(reader)).toBe(before)
  })

  it('does not reach into its inputs, so one read can serve every env', () => {
    const {inputs, options} = resolveFiles(files, 'staging')
    const snapshot = structuredClone(inputs)
    const first = resolveProject(options, inputs)
    expect(inputs).toEqual(snapshot)
    expect(resolveProject(options, inputs)).toEqual(first)
  })
})
