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

  it('uses a variable value as the parsed string, with no second round of JSON escapes', () => {
    const value = String.raw`l1\nl2 A "q"`
    const files = {...base, ...worker('orders', {vars: {A: '{v}'}})}
    const {project} = resolveFiles(files, undefined, {v: value, version: 'v1'})
    expect(project.workers[0].config.vars).toMatchObject({A: value})
  })

  it('reports a misspelt placeholder form instead of deploying it as text', () => {
    const {project} = resolveFiles({...base, ...worker('orders', {vars: {A: '{ version }'}})})
    expect(project.failures[0].error.message).toContain('{ version }')
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

  it('suggests the directory name only for a service binding, the one field monocf rewrites', () => {
    const workflows = [{binding: 'FLOW', script_name: 'billing-v1-staging'}]
    const files = {
      ...base,
      ...worker('orders', {env: {staging: {services: [{binding: 'B', service: 'billing-v1-staging'}], workflows}}}),
      ...worker('billing'),
    }
    const [service, workflow] = noticesOf(resolveFiles(files, 'staging').project.notices, 'hardcoded-name')
    expect(service.message).toContain('Use the directory name')
    expect(workflow.message).not.toContain('Use the directory name')
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

  it('keeps a hardcoded name exactly as written, whichever env it belongs to', () => {
    for (const name of ['billing-v1-production', 'billing-v1-staging', 'billing-v1']) {
      const files = {...base, ...worker('orders', binding(name)), ...worker('billing')}
      const orders = resolved(files, 'orders', 'staging')
      expect(envSection(orders.config, 'staging').services).toEqual([{binding: 'B', service: name}])
    }
  })

  it('sanitizes the rewritten binding target, which the deployed name is not', () => {
    const withEnv = {...base, 'base.wrangler.jsonc': {...base['base.wrangler.jsonc'], env: {my_env: {}}}}
    const section = {env: {my_env: {services: [{binding: 'B', service: 'billing'}]}}}
    const files = {...withEnv, ...worker('orders', section), ...worker('billing')}
    const orders = resolved(files, 'orders', 'my_env')
    expect(envSection(orders.config, 'my_env').services).toEqual([{binding: 'B', service: 'billing-v1-my-env'}])
    expect(resolved(files, 'billing', 'my_env').deployedName).toBe('billing-v1-my_env')
  })

  it('lets the selected env win the name index when two envs give one name', () => {
    const files = {
      'base.wrangler.jsonc': {env: {'prod-staging': {}, staging: {}}, main: 'a.ts', name: '{workerName}'},
      ...worker('caller', {env: {staging: {services: [{binding: 'B', service: 'x-prod-staging'}]}}}),
      ...worker('x'),
      ...worker('x-prod'),
    }
    expect(resolved(files, 'caller', 'staging').bindings[0].target).toEqual({dir: 'x-prod', kind: 'local'})
  })

  it('makes references from streaming tails and dispatch namespaces, without rewriting them', () => {
    const section = {
      dispatch_namespaces: [
        {binding: 'NS', namespace: 'n', outbound: {service: 'gateway'}},
        {binding: 'PLAIN', namespace: 'p'},
      ],
      streaming_tail_consumers: [{service: 'billing'}],
    }
    const files = {...base, ...worker('orders', {env: {staging: section}}), ...worker('billing'), ...worker('gateway')}
    const orders = resolved(files, 'orders', 'staging')
    expect(orders.bindings).toEqual([
      {binding: 'NS', source: 'dispatch_namespaces', target: {dir: 'gateway', kind: 'local'}},
      {binding: 'billing', source: 'streaming_tail_consumers', target: {dir: 'billing', kind: 'local'}},
    ])
    expect(envSection(orders.config, 'staging')).toMatchObject(section)
  })

  it('reports these two references as external when they match no worker', () => {
    const section = {
      dispatch_namespaces: [{binding: 'NS', outbound: {service: 'elsewhere'}}],
      streaming_tail_consumers: [{service: 'other'}],
    }
    const {project} = resolveFiles({...base, ...worker('orders', {env: {staging: section}})}, 'staging')
    expect(noticesOf(project.notices, 'external-binding').map(({name}) => name)).toEqual(['elsewhere', 'other'])
  })

  it('does not inherit these two references from the top level', () => {
    const top = {
      dispatch_namespaces: [{binding: 'NS', outbound: {service: 'billing'}}],
      streaming_tail_consumers: [{service: 'billing'}],
    }
    const files = {...base, ...worker('orders', top), ...worker('billing')}
    expect(resolved(files, 'orders', 'staging').bindings).toEqual([])
    expect(resolved(files, 'orders').bindings).toHaveLength(2)
  })

  it('gives notice of a directory name in a field monocf does not rewrite', () => {
    const section = {tail_consumers: [{service: 'billing'}], workflows: [{binding: 'F', script_name: 'billing'}]}
    const files = {...base, ...worker('orders', {env: {staging: section}}), ...worker('billing')}
    const notices = noticesOf(resolveFiles(files, 'staging').project.notices, 'directory-name')
    expect(notices.map(({source}) => source)).toEqual(['tail_consumers', 'workflows'])
    expect(notices[0].message).toContain('billing-v1-staging')
  })

  it('gives no such notice when the directory and the deployed name are the same', () => {
    const files = {
      'base.wrangler.jsonc': {main: 'a.ts', name: '{workerName}'},
      ...worker('orders', {workflows: [{binding: 'F', script_name: 'billing'}]}),
      ...worker('billing'),
    }
    expect(noticesOf(resolveFiles(files).project.notices, 'directory-name')).toEqual([])
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

  it.each([
    ['workflows', {workflows: [{binding: 'FLOW', script_name: 'broken'}]}],
    ['durable_objects', {durable_objects: {bindings: [{name: 'DO', script_name: 'broken'}]}}],
    ['tail_consumers', {tail_consumers: [{service: 'broken'}]}],
    ['streaming_tail_consumers', {streaming_tail_consumers: [{service: 'broken'}]}],
    ['dispatch_namespaces', {dispatch_namespaces: [{binding: 'D', outbound: {service: 'broken'}}]}],
  ])('spread through %s, and never claim the target matches no local worker', (_field, config) => {
    const {project} = resolveFiles({...base, ...broken, ...worker('orders', config)})
    expect(project.failures.map(({dir}) => dir)).toEqual(['broken', 'orders'])
    expect(project.failures[1].error.message).toContain('could not be resolved')
    expect(noticesOf(project.notices, 'external-binding')).toEqual([])
  })

  it('spread to every transitive caller', () => {
    const {project} = resolveFiles({
      ...base,
      ...broken,
      ...worker('a', {services: [{binding: 'B', service: 'b'}]}),
      ...worker('b', {services: [{binding: 'C', service: 'broken'}]}),
      ...worker('unrelated'),
    })
    expect(project.failures.map(({dir}) => dir)).toEqual(['a', 'b', 'broken'])
    expect(project.workers.map(({dir}) => dir)).toEqual(['unrelated'])
  })

  it('spread whatever the order of the workers, and keep the rewrite of a worker finished twice', () => {
    const files = {
      ...base,
      ...broken,
      ...worker('z', services('a')),
      ...worker('a', services('broken')),
      ...worker('caller', {env: {staging: {services: [{binding: 'U', service: 'unrelated'}]}}}),
      ...worker('unrelated'),
    }
    const {project} = resolveFiles(files, 'staging')
    expect(project.failures.map(({dir}) => dir)).toEqual(['a', 'broken', 'z'])
    const caller = project.workers.find(({dir}) => dir === 'caller')!
    expect(envSection(caller.config, 'staging').services).toEqual([{binding: 'U', service: 'unrelated-v1-staging'}])
    expect(noticesOf(project.notices, 'hardcoded-name')).toEqual([])
  })

  it('spread through the hardcoded deployed name of a worker whose config has a bad placeholder', () => {
    const bad = worker('bad', {vars: {A: '{nope}'}})
    const {project} = resolveFiles({...base, ...bad, ...worker('orders', binding('bad-v1-staging'))}, 'staging')
    expect(project.failures.map(({dir}) => dir)).toEqual(['bad', 'orders'])
    expect(project.failures[1].error.message).toContain('the deployed name of bad')
    expect(noticesOf(project.notices, 'external-binding')).toEqual([])
  })

  it('spread through the hardcoded deployed name of a worker whose config cannot be parsed, from the base name', () => {
    const {project} = resolveFiles({...base, ...broken, ...worker('orders', binding('broken-v1-staging'))}, 'staging')
    expect(project.failures.map(({dir}) => dir)).toEqual(['broken', 'orders'])
  })

  it('leave a binding alone when it hardcodes the name of a failed worker in another env', () => {
    const {project} = resolveFiles({...base, ...broken, ...worker('orders', binding('broken-v1-production'))}, 'staging')
    expect(project.failures.map(({dir}) => dir)).toEqual(['broken'])
    expect(noticesOf(project.notices, 'hardcoded-name')[0]).toMatchObject({targetDir: 'broken', targetEnv: 'production'})
    expect(noticesOf(project.notices, 'external-binding')).toEqual([])
  })

  it('treat an unreadable wrangler config as a failure of that worker alone', () => {
    const files = {
      ...base,
      'workers/unreadable/package.json': {version: '1.0.0'},
      // A directory at the config's path: it exists, and reading it fails.
      'workers/unreadable/wrangler.jsonc/child': 'x',
      ...worker('orders'),
    }
    const {project} = resolveFiles(files)
    expect(project.failures.map(({dir}) => dir)).toEqual(['unreadable'])
    expect(project.failures[0].error.message).toContain('Could not read the config')
    expect(project.workers.map(({dir}) => dir)).toEqual(['orders'])
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

describe('cases carried over from the comparison with the old flow', () => {
  it('rewrites bindings at the top level with no env, in a cycle', () => {
    const files = {
      ...base,
      ...worker('billing', {services: [{binding: 'ORDERS', service: 'orders'}]}),
      ...worker('orders', {services: [{binding: 'BILLING', service: 'billing'}]}),
    }

    expect(resolved(files, 'orders').config.services).toEqual([{binding: 'BILLING', service: 'billing-v1'}])
    expect(resolved(files, 'billing').config.services).toEqual([{binding: 'ORDERS', service: 'orders-v1'}])
  })

  it('drops empties when a base config merges, and keeps them with no base config', () => {
    const empties = {assets: {}, compatibility_flags: [], limits: {}, name: 'orders'}

    const withBase = resolved({...base, ...worker('orders', empties)}, 'orders').config
    const withoutBase = resolved(worker('orders', empties), 'orders').config

    expect(withBase).not.toHaveProperty('limits')
    expect(withoutBase).toMatchObject({assets: {}, limits: {}})
  })

  it('gives every command the same bindings, since there is only one resolved form', () => {
    const files = {...base, ...worker('gateway', services('orders')), ...worker('orders')}

    const {config} = resolved(files, 'gateway', 'staging')

    expect(envSection(config, 'staging').services).toEqual([{binding: 'ORDERS', service: 'orders-v1-staging'}])
  })
})
