import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import type {BundleManifest} from '../../src/app/bundle.js'
import {createFixture, effectiveConfig, flagValue, fromRoot, runCli, type Fixture, type WorkerSpec} from '../helpers/harness.js'

const environments = ['dev', 'staging']

const workers: WorkerSpec[] = [
  {envBindings: {dev: ['orders', 'nobody']}, name: 'gateway'},
  {envBindings: {dev: ['billing']}, name: 'orders'},
  {name: 'billing'},
  {name: 'legacy'},
]

function project(overrides: Partial<Parameters<typeof createFixture>[0]> = {}): Fixture {
  return createFixture({environments, ignore: ['legacy'], workers, ...overrides})
}

function offline(fixture: Fixture, args: string[], env?: Record<string, string>) {
  return runCli(fixture, args, {env, noCalls: true})
}

describe('monocf graph', () => {
  it('prints sorted JSON with levels, edges, callers and what was ignored, without touching wrangler', async () => {
    const result = await offline(project(), ['graph', '-e', 'dev', '--json'])

    expect(result.exitCode).toBe(0)
    expect(result.calls).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual({
      cycles: [],
      edges: [
        {binding: 'ORDERS', from: 'gateway', kind: 'services', to: 'orders'},
        {binding: 'BILLING', from: 'orders', kind: 'services', to: 'billing'},
      ],
      env: 'dev',
      external: [{binding: 'NOBODY', name: 'nobody', source: 'services', worker: 'gateway'}],
      ignored: ['legacy'],
      levels: [['billing'], ['orders'], ['gateway']],
      nodes: [
        {callers: ['orders'], deployedName: 'billing-v1-dev', name: 'billing', transitiveCallers: ['gateway', 'orders']},
        {callers: [], deployedName: 'gateway-v1-dev', name: 'gateway', transitiveCallers: []},
        {callers: ['gateway'], deployedName: 'orders-v1-dev', name: 'orders', transitiveCallers: ['gateway']},
      ],
      schemaVersion: 1,
    })
  })

  it('needs no wrangler at all', async () => {
    const fixture = project({wrangler: 'none'})
    expect((await offline(fixture, ['graph', '-e', 'dev'])).exitCode).toBe(0)
    expect((await offline(fixture, ['check', '-e', 'dev'])).exitCode).toBe(0)
  })

  it('gives the same output twice', async () => {
    const fixture = project()
    const first = await offline(fixture, ['graph', '-e', 'dev', '--json'])
    const second = await offline(fixture, ['graph', '-e', 'dev', '--json'])
    expect(second.stdout).toBe(first.stdout)
  })

  it('has an env of null with none selected', async () => {
    const result = await offline(project(), ['graph', '--json'])
    expect(JSON.parse(result.stdout).env).toBeNull()
  })

  it('prints levels for people, on stdout, with notices on stderr', async () => {
    const result = await offline(project(), ['graph', '-e', 'dev'])

    expect(result.stdout).toBe(
      [
        'Level 0:',
        '  billing',
        'Level 1:',
        '  orders',
        '    -> billing (services: BILLING)',
        'Level 2:',
        '  gateway',
        '    -> orders (services: ORDERS)',
        '    external: nobody (services: NOBODY)',
        'Ignored: legacy',
        '',
      ].join('\n'),
    )
    expect(result.stderr).toContain('notice: gateway: NOBODY targets nobody')
  })

  it('prints a mermaid flowchart', async () => {
    const result = await offline(project(), ['graph', '-e', 'dev', '--mermaid'])

    expect(result.stdout.split('\n')).toEqual([
      'flowchart TD',
      '  n0["billing"]',
      '  n1["gateway"]',
      '  n2["orders"]',
      '  n1 -->|"services: ORDERS"| n2',
      '  n2 -->|"services: BILLING"| n0',
      '',
    ])
  })

  it('draws a queue edge as dotted', async () => {
    const fixture = createFixture({
      workers: [
        {config: {queues: {producers: [{binding: 'Q', queue: 'jobs'}]}}, name: 'producer'},
        {config: {queues: {consumers: [{queue: 'jobs'}]}}, name: 'consumer'},
      ],
    })
    const result = await offline(fixture, ['graph', '--mermaid'])
    expect(result.stdout).toContain('n1 -.->|"queues: Q"| n0'.replace('Q', 'jobs'))
  })

  it('--callers prints every transitive caller, one per line', async () => {
    const result = await offline(project(), ['graph', '-e', 'dev', '--callers', 'billing'])
    expect(result.stdout).toBe('gateway\norders\n')
  })

  it('--callers prints nothing for a worker no one calls', async () => {
    const result = await offline(project(), ['graph', '-e', 'dev', '--callers', 'gateway'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('--callers --json separates direct callers from transitive ones', async () => {
    const result = await offline(project(), ['graph', '-e', 'dev', '--callers', 'billing', '--json'])
    expect(JSON.parse(result.stdout)).toEqual({
      callers: ['orders'],
      schemaVersion: 1,
      transitiveCallers: ['gateway', 'orders'],
      worker: 'billing',
    })
  })

  it.each([
    ['--callers of an unknown worker', ['graph', '-e', 'dev', '--callers', 'nope'], 'Worker not found'],
    ['an unknown env', ['graph', '-e', 'typo'], 'Unknown environment'],
    ['--json with --mermaid', ['graph', '--json', '--mermaid'], 'cannot also be provided'],
    ['--callers with --mermaid', ['graph', '--callers', 'a', '--mermaid'], 'cannot also be provided'],
  ])('rejects %s', async (_name, args, message) => {
    const result = await offline(project(), args)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(message)
    expect(result.stdout).toBe('')
  })

  it('stops with exit 2 when a selected worker could not be resolved', async () => {
    const result = await offline(project({files: {'workers/billing/wrangler.jsonc': '{'}}), ['graph', '-e', 'dev'])
    expect(result.exitCode).toBe(2)
  })

  it('does not stop for a broken worker that is ignored', async () => {
    const result = await offline(project({files: {'workers/legacy/wrangler.jsonc': '{'}}), ['graph', '-e', 'dev', '--json'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).ignored).toEqual(['legacy'])
  })
})

function clean(): Fixture {
  return createFixture({environments, workers: [{envBindings: {dev: ['billing']}, name: 'orders'}, {name: 'billing'}]})
}

describe('monocf check', () => {
  it('exits 0 with no findings', async () => {
    const result = await offline(clean(), ['check', '-e', 'dev'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('0 errors, 0 warnings\n')
  })

  it('exits 0 with only a warning, and 2 with --strict', async () => {
    const fixture = project()
    const relaxed = await offline(fixture, ['check', '-e', 'dev'])
    const strict = await offline(fixture, ['check', '-e', 'dev', '--strict'])

    expect(relaxed.exitCode).toBe(0)
    expect(relaxed.stdout).toContain('warning external-binding [dev]: gateway')
    expect(relaxed.stdout).toContain('0 errors, 1 warnings')
    expect(strict.exitCode).toBe(2)
  })

  it('exits 2 with an error, and prints the findings as one JSON document', async () => {
    const fixture = createFixture({
      environments,
      workers: [
        {envBindings: {dev: ['b']}, name: 'a'},
        {envBindings: {dev: ['a']}, name: 'b'},
      ],
    })

    const result = await offline(fixture, ['check', '-e', 'dev', '--json'])

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual({
      envs: ['dev'],
      errors: 1,
      findings: [{env: 'dev', level: 'error', message: 'Binding cycle: a -> b -> a', rule: 'cycle', worker: 'a'}],
      schemaVersion: 1,
      warnings: 0,
    })
  })

  it('--all-envs checks every env that any config defines, and tags findings with it', async () => {
    const fixture = createFixture({
      environments,
      workers: [
        {envBindings: {dev: ['nobody'], staging: ['elsewhere']}, name: 'orders'},
        {config: {env: {qa: {}}}, name: 'billing'},
      ],
    })

    const result = await offline(fixture, ['check', '--all-envs', '--json'])
    const {envs, findings} = JSON.parse(result.stdout)

    expect(envs).toEqual(['dev', 'qa', 'staging'])
    expect(result.exitCode).toBe(2)
    const summary = findings.map(({env, rule, worker}: Record<string, string>) => [rule, env, worker])
    expect(summary).toEqual(
      expect.arrayContaining([
        ['external-binding', 'dev', 'orders'],
        ['external-binding', 'staging', 'orders'],
        ['missing-env', 'qa', 'orders'],
      ]),
    )
    expect(summary).not.toContainEqual(['missing-env', 'qa', 'billing'])
  })

  it('--all-envs lists a finding about the project once', async () => {
    const fixture = createFixture({environments, ignore: ['gone'], workers: [{name: 'orders'}]})
    const {findings} = JSON.parse((await offline(fixture, ['check', '--all-envs', '--json'])).stdout)
    expect(findings).toEqual([expect.objectContaining({rule: 'ignored-stale'})])
    expect(findings[0]).not.toHaveProperty('env')
  })

  it('--all-envs checks with no env in a project that defines none', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})
    const result = await offline(fixture, ['check', '--all-envs', '--json'])
    expect(JSON.parse(result.stdout).envs).toEqual([null])
  })

  it('reports an unknown env as a finding for every worker', async () => {
    const result = await offline(clean(), ['check', '-e', 'typo', '--json'])
    const {findings} = JSON.parse(result.stdout)
    expect(result.exitCode).toBe(2)
    expect(findings.filter(({rule}: {rule: string}) => rule === 'missing-env')).toHaveLength(2)
  })

  it('rejects -e with --all-envs', async () => {
    const result = await offline(clean(), ['check', '-e', 'dev', '--all-envs'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('cannot also be provided')
  })

  it('checks that the main file exists next to the worker, wherever it runs from', async () => {
    const fixture = createFixture({environments, workers: [{config: {main: 'src/gone.ts'}, name: 'orders'}]})
    const result = await runCli(fixture, ['check', '-e', 'dev'], {cwd: 'workers/orders', noCalls: true})
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('missing-main')
  })
})

function manifestOf(result: {stdout: string}): {path: string; manifest: BundleManifest} {
  const path = result.stdout.trim()
  return {manifest: JSON.parse(readFileSync(path, 'utf8')), path}
}

function fingerprints(result: {stdout: string}): Record<string, string> {
  const {workers: described} = manifestOf(result).manifest
  return Object.fromEntries(Object.entries(described).map(([dir, {fingerprint}]) => [dir, fingerprint]))
}

const HEX_64 = /^[0-9a-f]{64}$/

function envValue(value: string): string {
  return JSON.stringify({env: {dev: {vars: {A: '1'}}, staging: {vars: {A: value}}}})
}

function withEntrypoint(entrypoint: string): Fixture {
  return createFixture({
    environments,
    workers: [
      {config: {env: {dev: {services: [{binding: 'API', entrypoint, service: 'billing'}]}}}, name: 'orders'},
      {name: 'billing'},
    ],
  })
}

describe('monocf bundle', () => {
  it('builds every worker the ignore file leaves in, into .monocf/bundle/<env>, and keeps it', async () => {
    const fixture = project()

    const result = await runCli(fixture, ['bundle', '-e', 'dev'], {env: {GITHUB_SHA: 'a'.repeat(40)}})

    expect(result.exitCode).toBe(0)
    expect(result.calls).toHaveLength(3)
    const outdirs = result.calls.map((call) => fromRoot(fixture, flagValue(call, '--outdir')!)).sort()
    expect(outdirs).toEqual(['.monocf/bundle/dev/billing', '.monocf/bundle/dev/gateway', '.monocf/bundle/dev/orders'])
    for (const call of result.calls) {
      expect(call.argv.slice(0, 2)).toEqual(['deploy', '--dry-run'])
      expect(flagValue(call, '--env')).toBe('dev')
      expect(call.argv).not.toContain('--minify')
      expect(call.argv.join(' ')).not.toContain('RELEASE')
    }

    expect(fromRoot(fixture, result.stdout.trim())).toBe('.monocf/bundle/dev/manifest.json')
    expect(existsSync(join(fixture.root, '.monocf', 'bundle', 'dev', 'orders', 'index.js'))).toBe(true)
    expect(existsSync(join(fixture.root, '.monocf', 'runs'))).toBe(false)
  })

  it('writes the manifest the design describes', async () => {
    const result = await runCli(project(), ['bundle', 'orders', '-e', 'dev'], {env: {GITHUB_SHA: 'a'.repeat(40)}})
    const {manifest} = manifestOf(result)

    expect(manifest).toMatchObject({commit: 'a'.repeat(40), env: 'dev', schemaVersion: 1, wrangler: '4.151.0'})
    expect(Object.keys(manifest.workers)).toEqual(['orders'])
    expect(manifest.workers.orders).toEqual({
      bundleHash: expect.stringMatching(HEX_64),
      configHash: expect.stringMatching(HEX_64),
      deployedName: 'orders-v1-dev',
      doHash: expect.stringMatching(HEX_64),
      externalHash: expect.stringMatching(HEX_64),
      fingerprint: expect.stringMatching(HEX_64),
      triggers: {crons: null, previewUrls: null, routes: [], workersDev: true},
      triggersHash: expect.stringMatching(HEX_64),
      version: '1.0.0',
    })
  })

  it('reads the commit from git without GITHUB_SHA', async () => {
    const result = await runCli(project(), ['bundle', 'orders', '-e', 'dev'])
    expect(manifestOf(result).manifest.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('never minifies, even when the config or the project file asks', async () => {
    const fixture = project({
      monocfConfig: {minify: true},
      workers: [{config: {env: {dev: {minify: true}}, minify: true}, name: 'orders'}],
    })

    const result = await runCli(fixture, ['bundle', 'orders', '-e', 'dev'])

    expect(result.calls[0].argv).not.toContain('--minify')
    expect(effectiveConfig(result.calls[0]).minify).toBeUndefined()
  })

  it('gives the same fingerprints twice, whatever the run directory, README.md or source map hold', async () => {
    const fixture = project()
    const first = await runCli(fixture, ['bundle', '-e', 'dev'])
    const second = await runCli(fixture, ['bundle', '-e', 'dev'])

    const [one] = first.calls
    const other = second.calls.find((call) => call.config?.name === one.config?.name)!
    expect(other.configDir).not.toBe(one.configDir)
    expect(fingerprints(second)).toEqual(fingerprints(first))
  })

  it('gives the same fingerprints across a new commit, with a new commit in the manifest', async () => {
    const fixture = project()
    const first = await runCli(fixture, ['bundle', '-e', 'dev'], {env: {GITHUB_SHA: 'a'.repeat(40)}})
    const second = await runCli(fixture, ['bundle', '-e', 'dev'], {env: {GITHUB_SHA: 'b'.repeat(40)}})

    expect(manifestOf(second).manifest.commit).toBe('b'.repeat(40))
    expect(fingerprints(second)).toEqual(fingerprints(first))
  })

  it('gives the same fingerprints in another output directory', async () => {
    const fixture = project()
    const first = await runCli(fixture, ['bundle', '-e', 'dev'])
    const second = await runCli(fixture, ['bundle', '-e', 'dev', '--out', 'elsewhere/deep'])

    expect(fromRoot(fixture, second.stdout.trim())).toBe('elsewhere/deep/manifest.json')
    expect(fingerprints(second)).toEqual(fingerprints(first))
  })

  it('changes only the worker whose version changed', async () => {
    const fixture = project()
    const first = fingerprints(await runCli(fixture, ['bundle', '-e', 'dev']))
    writeFileSync(join(fixture.worker('billing'), 'package.json'), '{"name":"billing","version":"2.0.0"}')
    const second = fingerprints(await runCli(fixture, ['bundle', '-e', 'dev']))

    expect(second.billing).not.toBe(first.billing)
    expect(second.orders).toBe(first.orders)
    expect(second.gateway).toBe(first.gateway)
  })

  it('changes only the env whose value changed', async () => {
    const fixture = createFixture({environments, workers: [{config: {}, name: 'orders'}]})
    const path = join(fixture.worker('orders'), 'wrangler.jsonc')
    const bundle = async (env: string) => fingerprints(await runCli(fixture, ['bundle', '-e', env])).orders

    writeFileSync(path, envValue('before'))
    const [dev, staging] = [await bundle('dev'), await bundle('staging')]
    writeFileSync(path, envValue('after'))

    expect(await bundle('dev')).toBe(dev)
    expect(await bundle('staging')).not.toBe(staging)
  })

  it('removes what an earlier run left in the output directory, so an old module cannot change the hash', async () => {
    const fixture = project()
    const first = await runCli(fixture, ['bundle', 'orders', '-e', 'dev'])
    writeFileSync(join(fixture.root, '.monocf', 'bundle', 'dev', 'orders', 'old-module.js'), 'old')
    const second = await runCli(fixture, ['bundle', 'orders', '-e', 'dev'])

    expect(fingerprints(second)).toEqual(fingerprints(first))
    expect(existsSync(join(fixture.root, '.monocf', 'bundle', 'dev', 'orders', 'old-module.js'))).toBe(false)
  })

  it('fails with exit 1 and leaves no manifest when a worker fails, while the others still build', async () => {
    const fixture = project()
    await runCli(fixture, ['bundle', '-e', 'dev'])

    const result = await runCli(fixture, ['bundle', '-e', 'dev'], {
      rules: [{command: 'deploy', exitCode: 1, worker: 'billing'}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.calls).toHaveLength(3)
    expect(existsSync(join(fixture.root, '.monocf', 'bundle', 'dev', 'manifest.json'))).toBe(false)
  })

  it('prints NDJSON with --json, and the manifest in an event', async () => {
    const result = await runCli(project(), ['bundle', 'orders', '-e', 'dev', '--json'])
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line))

    expect(events.map(({type}) => type)).toEqual(['run-started', 'step-started', 'step-finished', 'bundle-written', 'run-finished'])
    expect(events[3].manifest.workers.orders.deployedName).toBe('orders-v1-dev')
  })

  it.each([
    ['no env', ['bundle'], 'env'],
    ['an unknown env', ['bundle', '-e', 'typo'], 'Unknown environment'],
    ['an unknown worker', ['bundle', 'nope', '-e', 'dev'], 'Worker not found'],
    ['an ignored worker', ['bundle', 'legacy', '-e', 'dev'], '.monocfignore'],
    ['an empty --out', ['bundle', '-e', 'dev', '--out', ''], '--out'],
    ['a --concurrency of 0', ['bundle', '-e', 'dev', '--concurrency', '0'], 'concurrency'],
    ['a --out that would empty a worker', ['bundle', 'orders', '-e', 'dev', '--out', 'workers'], 'holds source files'],
  ])('rejects %s, and calls no wrangler', async (_name, args, message) => {
    const fixture = project()
    const before = readFileSync(join(fixture.worker('orders'), 'wrangler.jsonc'), 'utf8')

    const result = await offline(fixture, args)

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(message)
    expect(result.calls).toEqual([])
    expect(readFileSync(join(fixture.worker('orders'), 'wrangler.jsonc'), 'utf8')).toBe(before)
  })
})

describe('unknown-entrypoint in bundle', () => {
  const billing = {command: 'deploy', worker: 'billing'}

  it('passes when the provider exports the name', async () => {
    const result = await runCli(withEntrypoint('Api'), ['bundle', '-e', 'dev'], {
      rules: [{...billing, bundle: 'var Api = 1;\nexport {\n  Api,\n  w as default\n};\n'}],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain('unknown-entrypoint')
  })

  it('fails with exit 1 when it does not, naming the binding, and still writes the manifest', async () => {
    const fixture = withEntrypoint('Typo')
    const result = await runCli(fixture, ['bundle', '-e', 'dev'], {
      rules: [{...billing, bundle: 'var Api = 1;\nexport { Api };\n'}],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('error unknown-entrypoint: orders: binding API names entrypoint Typo')
    expect(existsSync(join(fixture.root, '.monocf', 'bundle', 'dev', 'manifest.json'))).toBe(true)
  })

  it('only warns when the exports cannot be read', async () => {
    const result = await runCli(withEntrypoint('Api'), ['bundle', '-e', 'dev'], {
      rules: [{...billing, bundle: 'addEventListener("fetch", () => {});\n'}],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('warning unknown-entrypoint')
  })

  it('only warns about a provider with no_bundle, whose last export statement says little', async () => {
    const fixture = withEntrypoint('Api')
    const path = join(fixture.worker('billing'), 'wrangler.jsonc')
    writeFileSync(path, JSON.stringify({...JSON.parse(readFileSync(path, 'utf8')), no_bundle: true}))

    const result = await runCli(fixture, ['bundle', '-e', 'dev'], {
      rules: [{...billing, bundle: 'export class Api {}\nconst other = 1;\nexport { other };\n'}],
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('warning unknown-entrypoint')
  })

  it('reports a finding as an event with --json', async () => {
    const result = await runCli(withEntrypoint('Typo'), ['bundle', '-e', 'dev', '--json'], {
      rules: [{...billing, bundle: 'export { Api };\n'}],
    })
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(events.find(({type}) => type === 'finding')).toMatchObject({level: 'error', rule: 'unknown-entrypoint', worker: 'orders'})
  })

  it('leaves a provider outside the selection unchecked', async () => {
    const result = await runCli(withEntrypoint('Typo'), ['bundle', 'orders', '-e', 'dev'])
    expect(result.exitCode).toBe(0)
  })
})
