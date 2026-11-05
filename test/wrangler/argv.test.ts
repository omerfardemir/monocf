import {describe, expect, it} from 'vitest'

import {buildArgv, type ArgvOptions, type Step} from '../../src/wrangler/argv.js'

const configPath = '/run/orders/wrangler.json'
const config = ['--config', configPath]

describe('buildArgv', () => {
  const cases: [string, Step, ArgvOptions, string[]][] = [
    [
      'build',
      {action: 'build', configPath, outdir: '/w/dist'},
      {},
      ['deploy', '--dry-run', '--outdir', '/w/dist', ...config],
    ],
    [
      'build with env and minify',
      {action: 'build', configPath, outdir: '/w/dist'},
      {env: 'staging', minify: true},
      ['deploy', '--dry-run', '--outdir', '/w/dist', '--env', 'staging', '--minify', ...config],
    ],
    ['deploy', {action: 'deploy', configPath}, {}, ['deploy', ...config]],
    [
      'deploy with everything',
      {action: 'deploy', configPath, secretsFile: '/run/orders/secrets.json'},
      {env: 'staging', message: 'fix: a b', minify: true, release: 'abc1234'},
      [
        'deploy',
        '--env',
        'staging',
        '--minify',
        '--message',
        'fix: a b',
        '--var',
        'RELEASE:abc1234',
        '--secrets-file',
        '/run/orders/secrets.json',
        ...config,
      ],
    ],
    ['preview', {action: 'preview', configPath}, {}, ['versions', 'upload', ...config]],
    [
      'preview with everything',
      {action: 'preview', configPath, secretsFile: '/s.json'},
      {env: 'e', message: 'm', minify: true, release: 'r'},
      [
        'versions',
        'upload',
        '--env',
        'e',
        '--minify',
        '--message',
        'm',
        '--var',
        'RELEASE:r',
        '--secrets-file',
        '/s.json',
        ...config,
      ],
    ],
    [
      'dev',
      {action: 'dev', configPaths: [configPath], persistTo: '/w/.wrangler/state'},
      {},
      ['dev', '--persist-to', '/w/.wrangler/state', ...config],
    ],
    [
      'dev with everything, and a config per worker',
      {action: 'dev', configPaths: ['/a.json', '/b.json'], inspectorPort: 9230, persistTo: '/p', port: 9001},
      {env: 'staging', release: 'r'},
      [
        'dev',
        '--env',
        'staging',
        '--port',
        '9001',
        '--inspector-port',
        '9230',
        '--persist-to',
        '/p',
        '--var',
        'RELEASE:r',
        '--config',
        '/a.json',
        '--config',
        '/b.json',
      ],
    ],
    ['secret bulk', {action: 'secret-bulk', configPath, file: '/s.json'}, {}, ['secret', 'bulk', '/s.json', ...config]],
    [
      'secret bulk with env',
      {action: 'secret-bulk', configPath, file: '/s.json'},
      {env: 'e'},
      ['secret', 'bulk', '/s.json', '--env', 'e', ...config],
    ],
    [
      'deployments status',
      {action: 'deployment-status', configPath},
      {env: 'e'},
      ['deployments', 'status', '--json', '--env', 'e', ...config],
    ],
    [
      'versions list',
      {action: 'versions-list', configPath},
      {env: 'e'},
      ['versions', 'list', '--json', '--env', 'e', ...config],
    ],
    [
      'versions deploy',
      {action: 'versions-deploy', configPath, versionId: 'v1'},
      {},
      ['versions', 'deploy', 'v1@100%', '--yes', ...config],
    ],
    [
      'versions deploy with env and message',
      {action: 'versions-deploy', configPath, versionId: 'v1'},
      {env: 'e', message: 'm'},
      ['versions', 'deploy', 'v1@100%', '--yes', '--env', 'e', '--message', 'm', ...config],
    ],
    ['triggers deploy', {action: 'triggers-deploy', configPath}, {env: 'e'}, ['triggers', 'deploy', '--env', 'e', ...config]],
    ['whoami', {action: 'whoami'}, {env: 'ignored'}, ['whoami']],
    ['active version', {action: 'active-version', name: 'n'}, {env: 'ignored'}, ['deployments', 'status', '--name', 'n', '--json']],
    [
      'version view',
      {action: 'version-view', name: 'n', versionId: 'v1'},
      {},
      ['versions', 'view', 'v1', '--name', 'n', '--json'],
    ],
    ['r2 bucket info', {action: 'r2-bucket-info', bucket: 'b'}, {}, ['r2', 'bucket', 'info', 'b']],
    [
      'r2 object get',
      {action: 'r2-get', bucket: 'b', key: 'p/k.json'},
      {},
      ['r2', 'object', 'get', 'b/p/k.json', '--remote', '--pipe'],
    ],
    [
      'r2 object put',
      {action: 'r2-put', bucket: 'b', file: '/t.json', key: 'p/k.json'},
      {},
      ['r2', 'object', 'put', 'b/p/k.json', '--remote', '--file', '/t.json', '--content-type', 'application/json'],
    ],
  ]

  it.each(cases)('%s', (_, step, options, expected) => {
    expect(buildArgv(step, options)).toEqual(expected)
  })

  it.each(['build', 'secret-bulk', 'deployment-status', 'versions-list', 'versions-deploy', 'triggers-deploy'] as const)(
    '%s never carries RELEASE',
    (action) => {
      const step = {action, configPath, file: '/s', outdir: '/o', versionId: 'v'} as Step

      expect(buildArgv(step, {release: 'abc'}).join(' ')).not.toContain('RELEASE')
    },
  )

  it('never passes --keep-vars', () => {
    for (const [, step, options] of cases) expect(buildArgv(step, options)).not.toContain('--keep-vars')
  })

  it('keeps an empty release out only when it is undefined', () => {
    expect(buildArgv({action: 'deploy', configPath}, {release: 'unknown'})).toContain('RELEASE:unknown')
  })

  it('passes a value with spaces and metacharacters as one argument', () => {
    const message = 'a; b & c | $(d) `e`'

    const argv = buildArgv({action: 'deploy', configPath}, {message})

    expect(argv[argv.indexOf('--message') + 1]).toBe(message)
  })
})
