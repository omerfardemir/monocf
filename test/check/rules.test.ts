import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {runRules} from '../../src/check/rules.js'
import {readProjectInputs, resolveProject} from '../../src/config/resolve.js'
import type {RawConfig} from '../../src/config/types.js'
import {resolveOptions} from '../../src/project/options.js'
import {discoverWorkers, findIgnoredWorkers} from '../../src/project/workers.js'
import {memoryReader, projectRoot} from '../helpers/memory-reader.js'

type Files = Record<string, unknown>

function worker(name: string, config: RawConfig = {}): Files {
  return {
    [`workers/${name}/package.json`]: {version: '1.0.0'},
    [`workers/${name}/src/index.ts`]: 'export default {}',
    [`workers/${name}/wrangler.jsonc`]: config,
  }
}

const base = {
  'base.wrangler.jsonc': {
    compatibility_date: '2025-01-09',
    env: {production: {}, staging: {}},
    main: 'src/index.ts',
    name: '{workerName}-v1',
  },
}

function check(files: Files, env?: string) {
  const reader = memoryReader(files)
  const options = resolveOptions({cwd: projectRoot, file: {workersDirName: 'workers'}, flags: {env}, reader})
  const inputs = readProjectInputs(options, reader)
  const all = discoverWorkers(options, reader)
  const ignored = findIgnoredWorkers(options, all, reader)
  return runRules({
    directories: reader.readDir(join(projectRoot, 'workers')),
    env,
    ignored,
    inputs,
    options,
    project: resolveProject(options, inputs),
    reader,
    selected: all.filter((dir) => !ignored.includes(dir)),
  })
}

function rule(files: Files, id: string, env?: string) {
  return check(files, env).filter((finding) => finding.rule === id)
}

function services(...targets: string[]) {
  return {services: targets.map((service) => ({binding: service.toUpperCase().replaceAll('-', '_'), service}))}
}

describe('a clean project', () => {
  it('has no findings', () => {
    expect(check({...base, ...worker('orders', {env: {staging: services('billing')}}), ...worker('billing')}, 'staging')).toEqual([])
  })

  it('tags a finding about a worker with the env', () => {
    expect(rule({...base, ...worker('orders', {env: {staging: services('nobody')}})}, 'external-binding', 'staging')[0]).toMatchObject({
      env: 'staging',
      level: 'warning',
      worker: 'orders',
    })
  })
})

describe('cycle', () => {
  const files = {...base, ...worker('a', services('b')), ...worker('b', services('c')), ...worker('c', services('a'))}

  it('is an error with the path', () => {
    const [finding] = rule(files, 'cycle')
    expect(finding.level).toBe('error')
    expect(finding.message).toContain('a -> b -> c -> a')
  })

  it('reports one finding per cycle', () => {
    expect(rule(files, 'cycle')).toHaveLength(1)
  })

  it('does not count a worker that binds to itself', () => {
    expect(rule({...base, ...worker('a', services('a'))}, 'cycle')).toEqual([])
  })

  it('is a warning when only a queue edge closes it, as queues need no order at deploy time', () => {
    const queueLoop = {
      ...base,
      ...worker('a', {queues: {consumers: [{queue: 'to-a'}], producers: [{binding: 'Q', queue: 'to-b'}]}}),
      ...worker('b', {queues: {consumers: [{queue: 'to-b'}], producers: [{binding: 'Q', queue: 'to-a'}]}}),
    }
    expect(rule(queueLoop, 'cycle')).toEqual([
      expect.objectContaining({level: 'warning', message: expect.stringContaining('through a queue')}),
    ])
  })
})

describe('self-binding', () => {
  it('is a warning that mentions the first deploy', () => {
    const [finding] = rule({...base, ...worker('a', services('a'))}, 'self-binding')
    expect(finding.level).toBe('warning')
    expect(finding.message).toContain('first deploy')
  })

  it('does not count a worker that sends to its own queue', () => {
    const files = {...base, ...worker('a', {queues: {consumers: [{queue: 'q'}], producers: [{binding: 'Q', queue: 'q'}]}})}
    expect(rule(files, 'self-binding')).toEqual([])
  })
})

describe('missing-env', () => {
  const noEnvBase = {'base.wrangler.jsonc': {compatibility_date: '2025-01-09', main: 'src/index.ts', name: '{workerName}'}}

  it('is an error for a worker that lacks the env after merging', () => {
    const files = {...noEnvBase, ...worker('a', {env: {staging: {}}}), ...worker('b')}
    expect(rule(files, 'missing-env', 'staging')).toEqual([
      expect.objectContaining({level: 'error', worker: 'b'}),
    ])
  })

  it('takes the env from the base too', () => {
    expect(rule({...base, ...worker('a')}, 'missing-env', 'staging')).toEqual([])
  })

  it('has nothing to say with no env', () => {
    expect(rule({...noEnvBase, ...worker('a')}, 'missing-env')).toEqual([])
  })
})

describe('ignored-dependency', () => {
  const files = {
    ...base,
    '.monocfignore': 'legacy\n',
    ...worker('a', services('legacy')),
    ...worker('legacy', services('a')),
  }

  it('is an error for a selected worker bound to an ignored one', () => {
    expect(rule(files, 'ignored-dependency')).toEqual([expect.objectContaining({level: 'error', worker: 'a'})])
  })

  it('ignores a queue edge, which is no binding', () => {
    const queued = {
      ...base,
      '.monocfignore': 'legacy\n',
      ...worker('a', {queues: {producers: [{binding: 'Q', queue: 'q'}]}}),
      ...worker('legacy', {queues: {consumers: [{queue: 'q'}]}}),
    }
    expect(rule(queued, 'ignored-dependency')).toEqual([])
  })
})

function staging(section: RawConfig) {
  return {env: {staging: section}}
}

describe('hardcoded-binding and cross-env-binding', () => {
  it('flags a service that hardcodes the deployed name of this env', () => {
    const files = {...base, ...worker('a', staging(services('b-v1-staging'))), ...worker('b')}
    expect(rule(files, 'hardcoded-binding', 'staging')).toEqual([expect.objectContaining({level: 'error', worker: 'a'})])
    expect(rule(files, 'cross-env-binding', 'staging')).toEqual([])
  })

  it('flags a service that targets another env as cross-env, not hardcoded', () => {
    const files = {...base, ...worker('a', staging(services('b-v1-production'))), ...worker('b')}
    expect(rule(files, 'cross-env-binding', 'staging')).toEqual([expect.objectContaining({level: 'error', worker: 'a'})])
    expect(rule(files, 'hardcoded-binding', 'staging')).toEqual([])
  })

  it('flags the name with no env suffix as cross-env when an env is selected', () => {
    const files = {...base, ...worker('a', staging(services('b-v1'))), ...worker('b')}
    expect(rule(files, 'cross-env-binding', 'staging')).toHaveLength(1)
  })

  it('flags a script_name of another env', () => {
    const section = staging({workflows: [{binding: 'F', script_name: 'b-v1-production'}]})
    const files = {...base, ...worker('a', section), ...worker('b')}
    expect(rule(files, 'cross-env-binding', 'staging')).toHaveLength(1)
  })

  it('accepts a script_name that is the deployed name of this env, which is the correct form', () => {
    const section = staging({workflows: [{binding: 'F', script_name: 'b-v1-staging'}]})
    const files = {...base, ...worker('a', section), ...worker('b')}
    expect(check(files, 'staging')).toEqual([])
  })

  it('accepts a directory name in a service binding', () => {
    expect(check({...base, ...worker('a', staging(services('b'))), ...worker('b')}, 'staging')).toEqual([])
  })
})

describe('script-name-directory', () => {
  it.each([
    ['workflows', {workflows: [{binding: 'F', script_name: 'b'}]}],
    ['durable_objects', {durable_objects: {bindings: [{class_name: 'C', name: 'D', script_name: 'b'}]}}],
  ])('is an error for %s', (_field, section) => {
    const files = {...base, ...worker('a', {env: {staging: section}}), ...worker('b')}
    const [finding] = rule(files, 'script-name-directory', 'staging')
    expect(finding).toMatchObject({level: 'error', worker: 'a'})
    expect(finding.message).toContain('b-v1-staging')
  })
})

describe('tail-service-directory', () => {
  it.each([
    ['tail_consumers', {tail_consumers: [{service: 'b'}]}],
    ['streaming_tail_consumers', {streaming_tail_consumers: [{service: 'b'}]}],
    ['dispatch_namespaces', {dispatch_namespaces: [{binding: 'N', outbound: {service: 'b'}}]}],
  ])('is an error for %s', (_field, section) => {
    const files = {...base, ...worker('a', {env: {staging: section}}), ...worker('b')}
    expect(rule(files, 'tail-service-directory', 'staging')).toEqual([expect.objectContaining({level: 'error', worker: 'a'})])
  })

  it('accepts the deployed name', () => {
    const files = {...base, ...worker('a', {env: {staging: {tail_consumers: [{service: 'b-v1-staging'}]}}}), ...worker('b')}
    expect(check(files, 'staging')).toEqual([])
  })
})

describe('duplicate-name', () => {
  it('is an error when two directories give one name', () => {
    const files = {...base, ...worker('a_b'), ...worker('a.b')}
    expect(rule(files, 'duplicate-name')).toEqual([
      expect.objectContaining({level: 'error', message: expect.stringContaining('a-b-v1')}),
    ])
  })

  it('stays quiet when only ignored workers collide', () => {
    const files = {...base, '.monocfignore': 'a_b\na.b\n', ...worker('a_b'), ...worker('a.b'), ...worker('c')}
    expect(rule(files, 'duplicate-name')).toEqual([])
  })
})

describe('duplicate-route', () => {
  const route = 'example.com/*'

  it.each([
    ['routes as text', {routes: [route]}, {routes: [route]}],
    ['routes as objects', {routes: [{pattern: route, zone_name: 'example.com'}]}, {routes: [route]}],
    ['route', {route}, {route}],
  ])('is an error for %s', (_name, a, b) => {
    const files = {...base, ...worker('a', a), ...worker('b', b)}
    expect(rule(files, 'duplicate-route')).toEqual([expect.objectContaining({level: 'error', worker: 'a'})])
  })

  it('reads the env section, and inherits from the top level, as wrangler does', () => {
    const files = {...base, ...worker('a', {routes: [route]}), ...worker('b', {env: {staging: {routes: [route]}}})}
    expect(rule(files, 'duplicate-route', 'staging')).toHaveLength(1)
    expect(rule(files, 'duplicate-route')).toEqual([])
  })

  it('does not compare across envs', () => {
    const files = {
      ...base,
      ...worker('a', {env: {staging: {routes: [route]}}}),
      ...worker('b', {env: {production: {routes: [route]}}}),
    }
    expect(rule(files, 'duplicate-route', 'staging')).toEqual([])
  })
})

function d1(database_name: string) {
  return {binding: 'DB', database_id: 'x', database_name}
}

function kv(binding: string) {
  return {binding, id: '1'}
}

describe('duplicate-binding-name', () => {
  it('is an error for a name base and worker concatenate into a repeat', () => {
    const files = {
      'base.wrangler.jsonc': {...base['base.wrangler.jsonc'], d1_databases: [d1('one')]},
      ...worker('a', {d1_databases: [d1('two')]}),
    }
    expect(rule(files, 'duplicate-binding-name')).toEqual([
      expect.objectContaining({level: 'error', message: expect.stringContaining('DB'), worker: 'a'}),
    ])
  })

  it('is an error across kinds of binding', () => {
    const files = {...base, ...worker('a', {kv_namespaces: [{binding: 'X', id: '1'}], r2_buckets: [{binding: 'X', bucket_name: 'b'}]})}
    expect(rule(files, 'duplicate-binding-name')).toHaveLength(1)
  })

  it.each([
    ['a var and a service', {services: [{binding: 'X', service: 'other'}], vars: {X: '1'}}],
    ['a durable object and a queue', {durable_objects: {bindings: [{class_name: 'C', name: 'X'}]}, queues: {producers: [{binding: 'X', queue: 'q'}]}}],
    ['an ai and a browser binding', {ai: {binding: 'X'}, browser: {binding: 'X'}}],
    ['a required secret and a var', {secrets: {required: ['X']}, vars: {X: '1'}}],
  ])('sees %s', (_name, config) => {
    expect(rule({...base, ...worker('a', config)}, 'duplicate-binding-name')).toHaveLength(1)
  })

  it('reads only the selected env', () => {
    const files = {...base, ...worker('a', {env: {production: {kv_namespaces: [kv('A'), kv('A')]}, staging: {kv_namespaces: [kv('A')]}}})}
    expect(rule(files, 'duplicate-binding-name', 'staging')).toEqual([])
    expect(rule(files, 'duplicate-binding-name', 'production')).toHaveLength(1)
  })
})

describe('resolver failures', () => {
  it('reports an unknown placeholder under its own rule', () => {
    expect(rule({...base, ...worker('a', {vars: {A: '{nope}'}})}, 'unknown-placeholder')).toEqual([
      expect.objectContaining({level: 'error', message: expect.stringContaining('{nope}'), worker: 'a'}),
    ])
  })

  it('reports any other failure as resolve-failed, so nothing goes unmentioned', () => {
    const files = {...base, 'workers/a/wrangler.jsonc': '{', ...worker('b', services('a'))}
    expect(rule(files, 'resolve-failed').map(({worker: dir}) => dir)).toEqual(['a', 'b'])
  })

  it('does not report an ignored worker', () => {
    const files = {...base, '.monocfignore': 'a\n', 'workers/a/wrangler.jsonc': '{', ...worker('b')}
    expect(check(files)).toEqual([])
  })
})

describe('external-binding', () => {
  it('is a warning', () => {
    expect(rule({...base, ...worker('a', services('nobody'))}, 'external-binding')[0].level).toBe('warning')
  })
})

describe('ignored-stale', () => {
  it('is a warning for a line that matches nothing, with no worker', () => {
    const files = {...base, '.monocfignore': '# a comment\n\ngone\na\n', ...worker('a'), ...worker('b')}
    expect(rule(files, 'ignored-stale')).toEqual([
      {level: 'warning', message: expect.stringContaining('"gone"'), rule: 'ignored-stale'},
    ])
  })

  it('accepts a path from the root and a glob', () => {
    const files = {...base, '.monocfignore': 'workers/a\nb*\n', ...worker('a'), ...worker('b1'), ...worker('c')}
    expect(rule(files, 'ignored-stale')).toEqual([])
  })

  it('counts a directory that has no config yet', () => {
    const files = {...base, '.monocfignore': 'draft\n', 'workers/draft/notes.txt': 'x', ...worker('a')}
    expect(rule(files, 'ignored-stale')).toEqual([])
  })
})

describe('missing-main', () => {
  it('is an error when the file is not there', () => {
    expect(rule({...base, ...worker('a', {main: 'src/gone.ts'})}, 'missing-main')[0]).toMatchObject({
      level: 'error',
      message: expect.stringContaining('src/gone.ts'),
    })
  })

  it('takes the main of the env section first', () => {
    const files = {...base, ...worker('a', {env: {staging: {main: 'src/gone.ts'}}})}
    expect(rule(files, 'missing-main', 'staging')).toHaveLength(1)
    expect(rule(files, 'missing-main', 'production')).toEqual([])
  })

  it('accepts a worker of assets alone, and rejects one with neither', () => {
    const noMain = {'base.wrangler.jsonc': {compatibility_date: '2025-01-09', name: '{workerName}'}}
    expect(rule({...noMain, ...worker('a', {assets: {directory: 'public'}})}, 'missing-main')).toEqual([])
    expect(rule({...noMain, ...worker('a')}, 'missing-main')).toHaveLength(1)
  })
})

function namedLength(length: number): Files {
  return {
    'base.wrangler.jsonc': {compatibility_date: '2025-01-09', main: 'src/index.ts', name: 'a'.repeat(length)},
    ...worker('a'),
  }
}

describe('name-length', () => {
  it('accepts 63 characters and rejects 64', () => {
    expect(rule(namedLength(63), 'name-length')).toEqual([])
    expect(rule(namedLength(64), 'name-length')).toEqual([
      expect.objectContaining({level: 'error', message: expect.stringContaining('over the limit of 63')}),
    ])
  })

  it('counts the env suffix', () => {
    const files = {
      'base.wrangler.jsonc': {
        compatibility_date: '2025-01-09',
        env: {staging: {}},
        main: 'src/index.ts',
        name: 'a'.repeat(60),
      },
      ...worker('a'),
    }
    expect(rule(files, 'name-length', 'staging')).toHaveLength(1)
    expect(rule(files, 'name-length')).toEqual([])
  })

  it('rejects an env that puts an invalid character in the name', () => {
    const files = {
      'base.wrangler.jsonc': {compatibility_date: '2025-01-09', env: {my_env: {}}, main: 'src/index.ts', name: 'a'},
      ...worker('a'),
    }
    expect(rule(files, 'name-length', 'my_env')[0].message).toContain('a-my_env')
  })

  it('rejects a leading or trailing dash, which sanitizing can leave behind', () => {
    expect(rule({...base, ...worker('-a')}, 'name-length')).toHaveLength(1)
  })
})

describe('no-compat-date', () => {
  const noDate = {'base.wrangler.jsonc': {main: 'src/index.ts', name: '{workerName}'}}

  it('is a warning', () => {
    expect(rule({...noDate, ...worker('a')}, 'no-compat-date')[0].level).toBe('warning')
  })

  it('takes the date from the env or the top level', () => {
    expect(rule({...noDate, ...worker('a', {compatibility_date: '2025-01-09'})}, 'no-compat-date')).toEqual([])
    const inEnv = {...noDate, ...worker('a', {env: {staging: {compatibility_date: '2025-01-09'}}})}
    expect(rule(inEnv, 'no-compat-date', 'staging')).toEqual([])
    expect(rule(inEnv, 'no-compat-date')).toHaveLength(1)
  })
})
