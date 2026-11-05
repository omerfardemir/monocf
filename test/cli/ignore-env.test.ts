import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

import {
  applyPlan,
  commitAll,
  deployFixture,
  firstRun,
  lastRunRecord,
  manifestOf,
  newCode,
  planFor,
  readPlan,
  stepOf,
  writesOf,
} from '../helpers/deploy-fixtures.js'
import {createFixture, effectiveConfig, runCli, type CliResult, type Fixture, type WorkerSpec} from '../helpers/harness.js'

const environments = ['dev', 'staging', 'production']
const STATE = ['-e', 'staging', '--state', 'file:state']

/** gateway binds to billing in dev and in production. nightly stands alone. */
const workers: WorkerSpec[] = [
  {envBindings: {dev: ['billing'], production: ['billing']}, name: 'gateway'},
  {name: 'billing'},
  {name: 'nightly'},
]

function project(ignore: string[], overrides: Partial<Parameters<typeof createFixture>[0]> = {}): Fixture {
  return createFixture({environments, ignore, workers, ...overrides})
}

function namesOf({calls}: CliResult): string[] {
  return calls.map((call) => effectiveConfig(call).name as string).filter((name) => name !== 'proxy-worker').sort()
}

function rejected(fixture: Fixture, args: string[], cwd?: string): Promise<CliResult> {
  return runCli(fixture, args, {cwd, noCalls: true})
}

function expectRefused(result: CliResult, message: string): void {
  expect(result.exitCode, result.stderr).toBe(2)
  expect(result.stderr.replaceAll(/\s+/g, ' ').replaceAll(' › ', ' ')).toContain(message)
  expect(result.calls).toEqual([])
}

async function checkJson(fixture: Fixture, args: string[]) {
  const result = await rejectedOrNot(fixture, ['check', ...args, '--json'])
  return {exitCode: result.exitCode, ...JSON.parse(result.stdout)} as {envs: (null | string)[]; errors: number; exitCode: number; findings: {env?: string; level: string; message: string; rule: string; worker?: string}[]; warnings: number}
}

function rejectedOrNot(fixture: Fixture, args: string[]): Promise<CliResult> {
  return runCli(fixture, args, {noCalls: true})
}

async function graphJson(fixture: Fixture, args: string[]) {
  const result = await rejectedOrNot(fixture, ['graph', ...args, '--json'])
  expect(result.exitCode, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as {ignored: string[]; nodes: {name: string}[]}
}

const secretWorkers = ({calls}: CliResult) => calls.filter(({secretFile}) => secretFile).map((call) => effectiveConfig(call).name).sort()

const productionOnly = (ignore: string[]) => ({
  base: false as const,
  ignore,
  workers: [
    {config: {env: {dev: {}, production: {}}}, name: 'orders'},
    {config: {env: {production: {}}}, name: 'nightly'},
  ],
})

const bundled = async (fixture: Fixture, env: string) => {
  const result = await runCli(fixture, ['bundle', '-e', env, '--out', 'out', '--json'])
  expect(result.exitCode, result.stderr).toBe(0)
  const event = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find(({type}) => type === 'bundle-written')
  return Object.keys(event.manifest.workers).sort()
}

function deployWith(ignore: string[]) {
  const built = deployFixture({environments: ['staging', 'production'], ignore})
  mkdirSync(join(built.root, 'state', 'production'), {recursive: true})
  return built
}

const planned = (built: Fixture, env: string) => runCli(built, ['plan', '-e', env, '--state', 'file:state', '--first-run', '--out', 'plan.json'], {cloudflare: {}})

/** Live, by hand, with no state entry, while a line left it out. */
async function broughtBack() {
  const built = deployFixture({environments: ['staging', 'production'], ignore: ['reports in staging']})
  const cloudflare = await firstRun(built)
  const live = {...cloudflare, workers: {...cloudflare.workers, 'reports-v1-staging': {active: [['by-hand', 100]] as [string, number][], tags: {'by-hand': null}}}}
  writeFileSync(join(built.root, '.monocfignore'), 'reports in production\n')
  commitAll(built)
  return {built, live}
}

async function liveThenIgnored(line: string) {
  const built = deployFixture({environments: ['staging', 'production']})
  const cloudflare = await firstRun(built)
  writeFileSync(join(built.root, '.monocfignore'), `${line}\n`)
  commitAll(built)
  return {built, cloudflare}
}

/** billing and reports were deployed twice, and then a line left reports out of this env. */
async function ranThenIgnored() {
  const built = deployFixture({environments: ['staging', 'production']})
  const cloudflare = await firstRun(built)
  await planFor(built, cloudflare, {rules: newCode('billing', 'reports')})
  const applied = await applyPlan(built, cloudflare)
  expect(applied.exitCode, applied.stderr).toBe(0)
  const runId = lastRunRecord(built).runId as string
  writeFileSync(join(built.root, '.monocfignore'), 'reports except production\n')
  commitAll(built)
  return {built, cloudflare: applied.cloudflare!, runId}
}

function pinned() {
  return createFixture({
    environments: ['dev', 'staging'],
    ignore: ['# a comment', '', 'legacy', 'workers/draft/', 'gone', '!not-there'],
    workers: [
      {envBindings: {dev: ['legacy']}, name: 'gateway'},
      {name: 'legacy'},
      {name: 'draft'},
      {name: 'orders'},
    ],
  })
}

describe.each([
  ['worker -c build -a', ['worker', '-a', '-c', 'build']],
  ['build -a', ['build', '-a']],
  ['deploy -a', ['deploy', '-a']],
  ['preview -a', ['preview', '-a']],
  ['dev -a', ['dev', '-a']],
])('%s', (_name, command) => {
  it('honours the ignored set of its env', async () => {
    const fixture = project(['workers/nightly except production', 'workers/billing in dev'])

    const inDev = await runCli(fixture, [...command, '-e', 'dev'])
    expect(inDev.exitCode, inDev.stderr).toBe(0)
    expect(namesOf(inDev)).toEqual(['gateway-v1-dev'])

    const inStaging = await runCli(fixture, [...command, '-e', 'staging'])
    expect(namesOf(inStaging)).toEqual(['billing-v1-staging', 'gateway-v1-staging'])

    const inProduction = await runCli(fixture, [...command, '-e', 'production'])
    expect(namesOf(inProduction)).toEqual(['billing-v1-production', 'gateway-v1-production', 'nightly-v1-production'])
  })
})

describe('secrets', () => {
  const files = Object.fromEntries(['billing', 'gateway', 'nightly'].flatMap((name) => [[`workers/${name}/.dev.vars.dev`, 'KEY=dev'], [`workers/${name}/.dev.vars.production`, 'KEY=production']]))

  it('secrets deploy -a honours the ignored set of its env', async () => {
    const fixture = project(['nightly except production'], {files})
    const inDev = await runCli(fixture, ['secrets', 'deploy', '-a', '-e', 'dev'])
    expect(secretWorkers(inDev)).toEqual(['billing-v1-dev', 'gateway-v1-dev'])

    const inProduction = await runCli(fixture, ['secrets', 'deploy', '-a', '-e', 'production'])
    expect(secretWorkers(inProduction)).toEqual(['billing-v1-production', 'gateway-v1-production', 'nightly-v1-production'])
  })

  it('secrets check reads nothing of a worker ignored in its env', async () => {
    const fixture = project(['nightly except production'])

    const result = await runCli(fixture, ['secrets', 'check', '-e', 'dev'], {cloudflare: {}, noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('gateway')
    expect(result.stderr).not.toContain('nightly')
    expect(JSON.stringify(result.calls.map(({argv}) => argv))).not.toContain('nightly')
  })
})

describe('a named worker', () => {
  it.each([
    ['build', ['build', 'nightly']],
    ['deploy', ['deploy', 'nightly']],
    ['preview', ['preview', 'nightly']],
    ['dev', ['dev', 'nightly']],
    ['worker', ['worker', 'nightly', '-c', 'build']],
    ['secrets deploy', ['secrets', 'deploy', 'nightly']],
    ['bundle', ['bundle', 'nightly']],
    ['plan --workers', ['plan', '--workers', 'nightly', '--state', 'file:state']],
  ])('%s is refused in an env where it is ignored, and the message names the env and the way out', async (_name, args) => {
    const fixture = project(['workers/nightly except production'])

    const result = await rejected(fixture, [...args, '-e', 'dev'])

    expectRefused(result, 'Worker nightly is ignored in dev by .monocfignore. To run it in dev, change its line in that file')
    expect(result.stderr).not.toContain('--all')
  })

  it.each([
    ['build', ['build', 'nightly']],
    ['deploy', ['deploy', 'nightly']],
    ['preview', ['preview', 'nightly']],
    ['dev', ['dev', 'nightly']],
    ['worker', ['worker', 'nightly', '-c', 'build']],
  ])('%s works in an env where it is not ignored', async (_name, args) => {
    const fixture = project(['workers/nightly except production'])

    const result = await runCli(fixture, [...args, '-e', 'production'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(namesOf(result)).toEqual(['nightly-v1-production'])
  })

  it('is refused when inferred from the current directory', async () => {
    const fixture = project(['nightly in dev'])

    expectRefused(await rejected(fixture, ['build', '-e', 'dev'], 'workers/nightly'), 'Worker nightly is ignored in dev')
    const elsewhere = await runCli(fixture, ['build', '-e', 'staging'], {cwd: 'workers/nightly'})
    expect(elsewhere.exitCode, elsewhere.stderr).toBe(0)
  })

  it('with no env: an except line refuses it, and an in line does not', async () => {
    const excepted = project(['nightly except production'])
    expectRefused(await rejected(excepted, ['build', 'nightly']), 'Worker nightly is ignored by .monocfignore when no env is given')

    const within = project(['nightly in production'])
    const result = await runCli(within, ['build', 'nightly'])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(namesOf(result)).toEqual(['nightly-v1'])
  })

  it('is left out of a bulk command with no env by an except line, and kept by an in line', async () => {
    const excepted = await runCli(project(['nightly except production']), ['build', '-a'])
    expect(namesOf(excepted)).toEqual(['billing-v1', 'gateway-v1'])

    const within = await runCli(project(['nightly in production']), ['build', '-a'])
    expect(namesOf(within)).toEqual(['billing-v1', 'gateway-v1', 'nightly-v1'])
  })
})

describe('except and local', () => {
  const withLocal = [...environments, 'local']

  it('except production also covers -e local, by name and in bulk', async () => {
    const fixture = project(['nightly except production'], {environments: withLocal})

    expectRefused(await rejected(fixture, ['dev', 'nightly', '-e', 'local']), 'Worker nightly is ignored in local')
    expectRefused(await rejected(fixture, ['build', 'nightly', '-e', 'local']), 'Worker nightly is ignored in local')
    expect(namesOf(await runCli(fixture, ['build', '-a', '-e', 'local']))).toEqual(['billing-v1-local', 'gateway-v1-local'])
  })

  it('except production,local allows it, and raises no unknown env where local is defined', async () => {
    const fixture = project(['nightly except production,local'], {environments: withLocal})

    const result = await runCli(fixture, ['build', 'nightly', '-e', 'local'])
    expect(result.exitCode, result.stderr).toBe(0)
    expectRefused(await rejected(fixture, ['build', 'nightly', '-e', 'dev']), 'Worker nightly is ignored in dev')

    const checked = await checkJson(fixture, ['--all-envs'])
    expect(checked.findings.filter(({rule}) => rule === 'ignored-unknown-env')).toEqual([])
    expect(checked.envs).toContain('local')
  })

  it('local defined by one worker only is real too', async () => {
    const fixture = project(['nightly except production,local'], {workers: [{config: {env: {local: {}}}, name: 'nightly'}, {name: 'billing'}]})

    const checked = await checkJson(fixture, ['--all-envs'])

    expect(checked.findings.filter(({rule}) => rule === 'ignored-unknown-env')).toEqual([])
  })

  it('except production,local in a project with no local is an unknown env', async () => {
    const checked = await checkJson(project(['nightly except production,local']), ['--all-envs'])

    expect(checked.exitCode).toBe(2)
    expect(checked.findings.filter(({rule}) => rule === 'ignored-unknown-env')).toEqual([
      {level: 'error', message: expect.stringContaining('local'), rule: 'ignored-unknown-env'},
    ])
  })
})

describe('graph', () => {
  it('leaves a worker out of an env where it is ignored, and lists it', async () => {
    const fixture = project(['workers/nightly except production'])

    const inDev = await graphJson(fixture, ['-e', 'dev'])
    expect(inDev.nodes.map(({name}) => name)).toEqual(['billing', 'gateway'])
    expect(inDev.ignored).toEqual(['nightly'])

    const inProduction = await graphJson(fixture, ['-e', 'production'])
    expect(inProduction.nodes.map(({name}) => name)).toEqual(['billing', 'gateway', 'nightly'])
    expect(inProduction.ignored).toEqual([])
  })

  it('with no env, applies except lines and no in lines', async () => {
    const view = await graphJson(project(['nightly except production', 'billing in production']), [])

    expect(view.ignored).toEqual(['nightly'])
    expect(view.nodes.map(({name}) => name)).toEqual(['billing', 'gateway'])
  })
})

describe('check', () => {
  it('fires ignored-dependency only in the env where the target is ignored, and names the env', async () => {
    const fixture = project(['billing in dev'])

    const inDev = await checkJson(fixture, ['-e', 'dev'])
    expect(inDev.exitCode).toBe(2)
    expect(inDev.findings).toEqual([
      {env: 'dev', level: 'error', message: expect.stringContaining('billing is ignored in dev by .monocfignore'), rule: 'ignored-dependency', worker: 'gateway'},
    ])

    const inProduction = await checkJson(fixture, ['-e', 'production'])
    expect(inProduction.findings.filter(({rule}) => rule === 'ignored-dependency')).toEqual([])

    const everywhere = await checkJson(fixture, ['--all-envs'])
    expect(everywhere.findings.filter(({rule}) => rule === 'ignored-dependency').map(({env}) => env)).toEqual(['dev'])
    expect(everywhere.exitCode).toBe(2)
  })

  it('gives a worker ignored in an env no missing-env there, and gives it one when it is not ignored', async () => {
    const scoped = await checkJson(createFixture(productionOnly(['nightly except production'])), ['--all-envs'])
    expect(scoped.envs).toEqual(['dev', 'production'])
    expect(scoped.exitCode).toBe(0)
    expect(scoped.findings.filter(({rule}) => rule === 'missing-env')).toEqual([])

    const wrongWayRound = await checkJson(createFixture(productionOnly(['nightly in production'])), ['--all-envs'])
    expect(wrongWayRound.findings.filter(({rule}) => rule === 'missing-env')).toEqual([expect.objectContaining({env: 'dev', worker: 'nightly'})])
    expect(wrongWayRound.exitCode).toBe(2)
  })

  it('runs --all-envs through an env that leaves nothing in', async () => {
    const fixture = project(['* except production'])

    const checked = await checkJson(fixture, ['--all-envs'])

    expect(checked.exitCode).toBe(0)
    expect(checked.envs).toEqual(['dev', 'production', 'staging'])
  })

  it('stops as before when no env leaves anything in', async () => {
    const result = await rejectedOrNot(project(['*']), ['check', '--all-envs'])

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('No workers found')
  })

  it('matches ignored-stale on the pattern with its scope removed', async () => {
    const live = await checkJson(project(['nightly except production', 'workers/billing in dev']), ['-e', 'production'])
    expect(live.findings.filter(({rule}) => rule === 'ignored-stale')).toEqual([])

    const stale = await checkJson(project(['gone except production']), ['--all-envs'])
    expect(stale.findings.filter(({rule}) => rule === 'ignored-stale')).toEqual([
      {level: 'warning', message: 'The .monocfignore line "gone except production" matches no directory.', rule: 'ignored-stale'},
    ])
  })

  it.each([
    ['workers/nightly in'],
    ['workers/nightly except dev,,production'],
    ['workers/nightly except production # a note'],
  ])('fails on the malformed line %j, and says what is wrong', async (line) => {
    const checked = await checkJson(project([line]), ['-e', 'dev'])

    expect(checked.exitCode).toBe(2)
    expect(checked.findings).toEqual([{level: 'error', message: expect.stringContaining(`"${line}" is malformed`), rule: 'ignored-malformed'}])
  })

  it('does not take a malformed line for a pattern or an env: nothing else fires, and the worker stays in', async () => {
    const view = await checkJson(project(['workers/nightly except production # a note']), ['--all-envs'])

    expect(view.findings.map(({rule}) => rule)).toEqual(['ignored-malformed'])
  })

  it('counts a malformed line for nothing while it checks, so the worker it names is still looked at', async () => {
    const checked = await checkJson(createFixture(productionOnly(['nightly except a,,b'])), ['-e', 'dev'])

    expect(checked.findings.map(({rule, worker}) => `${rule} ${worker}`).sort()).toEqual(['ignored-malformed undefined', 'missing-env nightly'])
  })

  it('reports ignored-unknown-env for a typo, once, whichever env it checks', async () => {
    const fixture = project(['nightly except produciton'])

    const checked = await checkJson(fixture, ['--all-envs'])

    expect(checked.exitCode).toBe(2)
    expect(checked.findings).toEqual([
      {level: 'error', message: 'The .monocfignore line "nightly except produciton" names the env produciton, which no worker defines.', rule: 'ignored-unknown-env'},
    ])
    expect((await checkJson(fixture, ['-e', 'dev'])).findings.map(({rule}) => rule)).toEqual(['ignored-unknown-env'])
  })

  it('matches an env in a scope exactly, case included', async () => {
    const checked = await checkJson(project(['nightly except Production']), ['--all-envs'])

    expect(checked.findings.map(({message}) => message)).toEqual([expect.stringContaining('the env Production,')])
  })

  it('reads a file with CRLF line endings', async () => {
    const fixture = project([], {files: {'.monocfignore': '# a comment\r\nworkers/nightly except production\r\nworkers/billing in staging\r\n'}})

    expect((await checkJson(fixture, ['--all-envs'])).findings).toEqual([])
    expect((await graphJson(fixture, ['-e', 'production'])).ignored).toEqual([])
    expect((await graphJson(fixture, ['-e', 'staging'])).ignored).toEqual(['billing', 'nightly'])
  })

  it('every command that selects workers stops on a malformed line, and nothing runs', async () => {
    const fixture = project(['nightly except production # a note'])

    for (const args of [['build', '-a', '-e', 'dev'], ['deploy', 'billing', '-e', 'dev'], ['graph', '-e', 'dev'], ['bundle', '-e', 'dev'], ['plan', '-e', 'dev', '--state', 'file:state']]) {
      expectRefused(await rejected(fixture, args), 'is malformed')
    }
  })
})

describe('-d', () => {
  it('does not follow a binding to a worker ignored in this env, and follows it where it is not', async () => {
    const fixture = project(['billing in dev'])

    const inDev = await runCli(fixture, ['deploy', 'gateway', '-d', '-e', 'dev'])
    expect(inDev.exitCode, inDev.stderr).toBe(0)
    expect(namesOf(inDev)).toEqual(['gateway-v1-dev'])
    expect(inDev.stderr).toContain('Not following the binding to billing: it is in .monocfignore.')

    const inProduction = await runCli(fixture, ['deploy', 'gateway', '-d', '-e', 'production'])
    expect(namesOf(inProduction)).toEqual(['billing-v1-production', 'gateway-v1-production'])
    expect(inProduction.stderr).not.toContain('.monocfignore')

    const previewed = await runCli(fixture, ['preview', 'gateway', '-d', '-e', 'dev'])
    expect(namesOf(previewed)).toEqual(['gateway-v1-dev'])
  })

  it('rewrites no binding target: an ignored target still resolves to its deployed name', async () => {
    const fixture = project(['billing in dev'])

    const result = await runCli(fixture, ['deploy', 'gateway', '-e', 'dev'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(effectiveConfig(result.calls[0]).services).toEqual([{binding: 'BILLING', service: 'billing-v1-dev'}])
  })
})

describe('bundle', () => {
  it('selects per env', async () => {
    const fixture = project(['workers/nightly except production'])

    expect(await bundled(fixture, 'dev')).toEqual(['billing', 'gateway'])
    expect(await bundled(fixture, 'production')).toEqual(['billing', 'gateway', 'nightly'])
  })
})

describe('plan', () => {
  it('selects per env', async () => {
    const built = deployWith(['workers/reports except production'])

    const inStaging = await planned(built, 'staging')
    expect(inStaging.exitCode, inStaging.stderr).toBe(0)
    expect(readPlan(built).steps.map(({worker}: {worker: string}) => worker).sort()).toEqual(['billing', 'gateway', 'orders'])
    expect(inStaging.calls.some(({argv}) => argv.includes('reports-v1-staging'))).toBe(false)

    const inProduction = await planned(built, 'production')
    expect(inProduction.exitCode, inProduction.stderr).toBe(0)
    expect(readPlan(built).steps.map(({worker}: {worker: string}) => worker).sort()).toEqual(['billing', 'gateway', 'orders', 'reports'])
  })

  it('stops on an env typo in a scope, before any read', async () => {
    const built = deployWith(['reports except produciton'])

    const result = await rejected(built, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--out', 'plan.json'])

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('ignored-unknown-env')
  })

  it('does not change the fingerprint of what stays selected', async () => {
    const built = deployWith([])
    await planned(built, 'staging')
    const before = stepOf(readPlan(built), 'orders')

    writeFileSync(join(built.root, '.monocfignore'), 'reports except production\n')
    commitAll(built)
    await planned(built, 'staging')
    const after = stepOf(readPlan(built), 'orders')

    for (const hash of ['bundleHash', 'configHash', 'doHash', 'externalHash', 'fingerprint', 'triggersHash']) expect(after[hash]).toBe(before[hash])
  })

  describe('ignored-but-deployed', () => {
    it('notes a worker the state knows and a scope leaves out, in the summary and the markdown, and reads nothing of it', async () => {
      const {built, cloudflare} = await liveThenIgnored('workers/reports except production')

      const result = await runCli(built, ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json', '--markdown', 'plan.md'], {cloudflare})

      expect(result.exitCode, result.stderr).toBe(0)
      const plan = readPlan(built)
      expect(plan.notes).toEqual([{deployedName: 'reports-v1-staging', kind: 'ignored-but-deployed', message: expect.stringContaining("deleting it is a person's job"), worker: 'reports'}])
      expect(plan.steps.map(({worker}: {worker: string}) => worker)).not.toContain('reports')
      expect(result.stderr).toContain('note ignored-but-deployed: reports (reports-v1-staging)')
      expect(readFileSync(join(built.root, 'plan.md'), 'utf8')).toContain('ignored-but-deployed: reports (reports-v1-staging)')
      expect(result.calls.some(({argv}) => argv.includes('reports-v1-staging'))).toBe(false)
    })

    it('leaves it deployed and in the state through an apply', async () => {
      const {built, cloudflare} = await liveThenIgnored('workers/reports except production')
      await planFor(built, cloudflare, {rules: newCode('orders')})
      const entry = manifestOf(built).workers.reports

      const applied = await applyPlan(built, cloudflare)

      expect(applied.exitCode, applied.stderr).toBe(0)
      expect(writesOf(applied.calls).filter((write) => write.endsWith('reports'))).toEqual([])
      expect(manifestOf(built).workers.reports).toEqual(entry)
      expect(applied.cloudflare!.workers!['reports-v1-staging']).toEqual(cloudflare.workers!['reports-v1-staging'])
    })

    it('is no orphan, and a worker gone from the repository is no ignored-but-deployed', async () => {
      const {built, cloudflare} = await liveThenIgnored('workers/reports except production')
      const path = join(built.root, 'state', 'staging', 'manifest.json')
      const manifest = manifestOf(built)
      writeFileSync(path, JSON.stringify({...manifest, workers: {...manifest.workers, gone: {...manifest.workers.reports, deployedName: 'gone-v1-staging'}}}))

      await planFor(built, cloudflare)

      const notes = readPlan(built).notes.map(({kind, worker}: {kind: string; worker: string}) => `${kind} ${worker}`)
      expect(notes).toEqual(['ignored-but-deployed reports', 'orphan gone'])
    })

    it('stays away from a line with no scope, as before', async () => {
      const {built, cloudflare} = await liveThenIgnored('workers/reports')

      await planFor(built, cloudflare)

      expect(readPlan(built).notes).toEqual([])
    })

    it('gives none in an env where the worker is selected', async () => {
      const {built, cloudflare} = await liveThenIgnored('workers/reports except staging')

      await planFor(built, cloudflare)

      expect(readPlan(built).notes).toEqual([])
      expect(readPlan(built).steps.map(({worker}: {worker: string}) => worker)).toContain('reports')
    })
  })

  describe('a worker a scope brings back', () => {
    it('is blocked under --on-drift fail, and the message says what to do', async () => {
      const {built, live} = await broughtBack()

      const result = await runCli(built, ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json', '--markdown', 'plan.md', '--on-drift', 'fail'], {cloudflare: live})

      expect(result.exitCode).toBe(1)
      expect(stepOf(readPlan(built), 'reports')).toMatchObject({action: 'blocked', reasons: ['drift', 'baseline']})
      expect(result.stderr).toContain('plan with --on-drift warn')
      expect(readFileSync(join(built.root, 'plan.md'), 'utf8')).toContain('plan with --on-drift warn')
    })

    it('uploads under --on-drift warn', async () => {
      const {built, live} = await broughtBack()

      const plan = await planFor(built, live, {flags: ['--on-drift', 'warn']})

      expect(stepOf(plan, 'reports')).toMatchObject({action: 'upload', reasons: ['baseline']})
      expect(plan.notes.find(({worker}: {worker: string}) => worker === 'reports').message).not.toContain('--on-drift')
    })
  })

  describe('the marker for an ignored caller', () => {
    it('uses the ignored set of the env, so a caller a scope leaves out is marked and left alone, then acted on once selected', async () => {
      const built = deployFixture({environments: ['staging', 'production']})
      const cloudflare = await firstRun(built)
      writeFileSync(join(built.root, '.monocfignore'), 'gateway except production\norders except production\n')
      commitAll(built)
      const provider = stepOf(await planFor(built, cloudflare), 'billing').deployedName
      const {[provider]: gone, ...rest} = cloudflare.workers!
      expect(gone).toBeDefined()

      const plan = await planFor(built, {...cloudflare, workers: rest}, {flags: ['--allow-recreate']})
      expect(stepOf(plan, 'billing').markCallers).toEqual(['orders'])
      expect(plan.notes.map(({kind, worker}: {kind: string; worker: string}) => `${kind} ${worker}`)).toContain('caller-ignored orders')

      const applied = await applyPlan(built, {...cloudflare, workers: rest})
      expect(applied.exitCode, applied.stderr).toBe(0)
      expect(writesOf(applied.calls)).not.toContain('upload orders')
      expect(manifestOf(built).needsNewVersion).toEqual(['orders'])

      writeFileSync(join(built.root, '.monocfignore'), 'gateway except staging\n')
      commitAll(built)
      expect(stepOf(await planFor(built, applied.cloudflare!), 'orders')).toMatchObject({action: 'upload', reasons: ['provider-recreated']})
    })
  })
})

describe('apply', () => {
  it('refuses a plan that deploys what the ignore file now leaves out of its env, and touches nothing', async () => {
    const built = deployFixture({environments: ['staging', 'production']})
    const cloudflare = await firstRun(built)
    // Git can't see a change to the file here, which is the only way one gets past the clean checkout.
    writeFileSync(join(built.root, '.git', 'info', 'exclude'), 'state\nplan.json\n.monocfignore\n')
    await planFor(built, cloudflare, {rules: newCode('reports', 'orders')})
    writeFileSync(join(built.root, '.monocfignore'), 'reports except production\n')

    const result = await applyPlan(built, cloudflare, {noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stderr.replaceAll(/\s+/g, ' ').replaceAll(' › ', ' ')).toContain('The plan deploys reports, and .monocfignore leaves that out of staging. Plan again.')
    expect(writesOf(result.calls)).toEqual([])
  })

  it('applies a plan for an env where the worker is not ignored', async () => {
    const built = deployFixture({environments: ['staging', 'production']})
    const cloudflare = await firstRun(built)
    writeFileSync(join(built.root, '.monocfignore'), 'reports except staging\n')
    commitAll(built)
    await planFor(built, cloudflare, {rules: newCode('reports')})

    const applied = await applyPlan(built, cloudflare)

    expect(applied.exitCode, applied.stderr).toBe(0)
    expect(writesOf(applied.calls)).toContain('promote reports')
  })
})

describe('rollback', () => {
  it('--to-run skips a worker ignored in this env with a clear note, and restores the rest', async () => {
    const {built, cloudflare, runId} = await ranThenIgnored()
    const entry = manifestOf(built).workers.reports

    const result = await runCli(built, ['rollback', ...STATE, '--to-run', runId], {cloudflare})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain("reports: .monocfignore leaves it out of staging now, so this rollback doesn't touch it")
    expect(writesOf(result.calls)).toContain('promote billing')
    expect(writesOf(result.calls).filter((write) => write.endsWith('reports'))).toEqual([])
    expect(result.calls.some(({argv}) => argv.includes('reports-v1-staging'))).toBe(false)
    expect(manifestOf(built).workers.reports).toEqual(entry)
    expect(result.cloudflare!.workers!['reports-v1-staging']).toEqual(cloudflare.workers!['reports-v1-staging'])
    expect(lastRunRecord(built).workers.reports).toMatchObject({changed: false, deployedName: 'reports-v1-staging', result: 'skipped'})
  })

  it('--to-run --dry-run says the same', async () => {
    const {built, cloudflare, runId} = await ranThenIgnored()

    const result = await runCli(built, ['rollback', ...STATE, '--to-run', runId, '--dry-run'], {cloudflare, noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain("reports: .monocfignore leaves it out of staging now")
    expect(writesOf(result.calls)).toEqual([])
  })

  it('refuses a worker ignored in this env by name', async () => {
    const {built, cloudflare} = await ranThenIgnored()

    const result = await runCli(built, ['rollback', 'reports', ...STATE, '--to', 'v1', '--force'], {cloudflare, noCalls: true})

    expectRefused(result, 'Worker reports is ignored in staging by .monocfignore')
  })

  it('still refuses a caller whose provider the run recreated, when that provider is ignored now', async () => {
    const built = deployFixture({environments: ['staging', 'production']})
    const cloudflare = await firstRun(built)
    const provider = stepOf(await planFor(built, cloudflare), 'billing').deployedName
    const {[provider]: gone, ...rest} = cloudflare.workers!
    expect(gone).toBeDefined()
    await planFor(built, {...cloudflare, workers: rest}, {flags: ['--allow-recreate']})
    const applied = await applyPlan(built, {...cloudflare, workers: rest})
    expect(applied.exitCode, applied.stderr).toBe(0)
    const runId = lastRunRecord(built).runId as string
    writeFileSync(join(built.root, '.monocfignore'), 'billing except production\n')
    commitAll(built)

    const result = await runCli(built, ['rollback', ...STATE, '--to-run', runId], {cloudflare: applied.cloudflare, noCalls: true})

    expect(result.exitCode).toBe(1)
    expect(lastRunRecord(built).workers.orders).toMatchObject({message: expect.stringContaining("can't reach"), result: 'refused'})
    expect(lastRunRecord(built).workers.billing).toMatchObject({result: 'skipped'})
  })
})

describe('the README', () => {
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8').replaceAll('\r\n', '\n')
  const samples = [...readme.matchAll(/```gitignore\n([\s\S]*?)```/g)].map(([, sample]) => sample)
  const names = [{name: 'legacy-tool'}, {name: 'load-test'}, {name: 'nightly-report'}, {name: 'orders'}]

  it('shows lines that do what it says, with no env and in each env', async () => {
    const fixture = createFixture({environments: [...environments, 'local'], files: {'.monocfignore': samples[0]}, workers: names})

    expect((await checkJson(fixture, ['--all-envs'])).findings).toEqual([])
    expect((await graphJson(fixture, [])).ignored).toEqual(['legacy-tool', 'nightly-report'])
    expect((await graphJson(fixture, ['-e', 'local'])).ignored).toEqual(['legacy-tool', 'nightly-report'])
    expect((await graphJson(fixture, ['-e', 'dev'])).ignored).toEqual(['legacy-tool', 'load-test', 'nightly-report'])
    expect((await graphJson(fixture, ['-e', 'staging'])).ignored).toEqual(['legacy-tool', 'load-test', 'nightly-report'])
    expect((await graphJson(fixture, ['-e', 'production'])).ignored).toEqual(['legacy-tool'])
    expectRefused(await rejected(fixture, ['dev', 'nightly-report', '-e', 'local']), 'Worker nightly-report is ignored in local')
    expectRefused(await rejected(fixture, ['build', 'nightly-report']), 'Worker nightly-report is ignored by .monocfignore when no env is given')
  })

  it('shows a production-only line that leaves local alone', async () => {
    const fixture = createFixture({environments: [...environments, 'local'], files: {'.monocfignore': samples[1]}, workers: names})

    expect((await checkJson(fixture, ['--all-envs'])).findings).toEqual([])
    expect((await graphJson(fixture, ['-e', 'staging'])).ignored).toEqual(['nightly-report'])
    expect((await graphJson(fixture, ['-e', 'production'])).ignored).toEqual([])
    expect((await graphJson(fixture, ['-e', 'local'])).ignored).toEqual([])
  })
})

describe('a typo in a keyword', () => {
  describe.each(['workers/billing excpet production', 'workers/billing IN dev'])('%s', (line) => {
    const fixture = () => deployFixture({ignore: [line], workers: [{name: 'billing'}, {name: 'reports'}]})

    it('fails check, under the same rule as a scope with no names', async () => {
      const {exitCode, findings} = await checkJson(fixture(), ['-e', 'staging'])

      expect(exitCode).toBe(2)
      const malformed = findings.find(({rule}) => rule === 'ignored-malformed')
      expect(malformed).toMatchObject({level: 'error'})
      expect(malformed!.message).toContain(String.raw`written "\ "`)
      expect(findings.map(({rule}) => rule)).not.toContain('ignored-stale')
    })

    it('fails check --all-envs as well', async () => {
      const {exitCode, findings} = await checkJson(fixture(), ['--all-envs'])

      expect(exitCode).toBe(2)
      expect(findings.map(({rule}) => rule)).toContain('ignored-malformed')
    })

    it.each([
      ['plan', ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--out', 'plan.json']],
      ['build --all', ['build', '-a', '-e', 'staging']],
      ['deploy --all', ['deploy', '-a', '-e', 'staging']],
      ['bundle', ['bundle', '-e', 'staging']],
      ['graph', ['graph', '-e', 'staging']],
      ['deploy by name', ['deploy', 'billing', '-e', 'staging']],
      ['rollback', ['rollback', '-e', 'staging', '--state', 'file:state', '--to-run', '20260101T000000Z-abc123']],
    ])('stops %s with exit 2, and selects nothing', async (_, args) => {
      const result = await runCli(fixture(), args, {cloudflare: {}, noCalls: true})

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('is malformed')
      expect(result.calls).toEqual([])
    })
  })

  it('leaves a directory written with an escaped space working', async () => {
    const fixture = deployFixture({ignore: [String.raw`workers/my\ dir except production`], workers: [{name: 'billing'}, {name: 'my dir'}]})

    const view = await runCli(fixture, ['graph', '-e', 'staging', '--json'], {noCalls: true})

    expect(view.exitCode, view.stderr).toBe(0)
    expect(JSON.parse(view.stdout).ignored).toEqual(['my dir'])
  })
})

describe('a file with no scoped lines', () => {
  const expectedStale = ['gone', '!not-there'].map((line) => ({level: 'warning', message: `The .monocfignore line "${line}" matches no directory.`, rule: 'ignored-stale'}))

  it('gives the same graph in every env, and with none', async () => {
    const fixture = pinned()

    for (const args of [[], ['-e', 'dev'], ['-e', 'staging']]) {
      const view = await graphJson(fixture, args)
      expect(view.ignored).toEqual(['draft', 'legacy'])
      expect(view.nodes.map(({name}) => name)).toEqual(['gateway', 'orders'])
    }
  })

  it('gives the same check findings, word for word', async () => {
    const fixture = pinned()

    const inDev = await checkJson(fixture, ['-e', 'dev'])
    expect(inDev.findings).toEqual([
      {env: 'dev', level: 'error', message: 'gateway has a binding to legacy through services LEGACY, and legacy is in .monocfignore.', rule: 'ignored-dependency', worker: 'gateway'},
      ...expectedStale,
    ])

    const everywhere = await rejectedOrNot(fixture, ['check', '--all-envs'])
    expect(everywhere.exitCode).toBe(2)
    expect(everywhere.stdout).toBe(
      [
        'error ignored-dependency [dev]: gateway has a binding to legacy through services LEGACY, and legacy is in .monocfignore.',
        'warning ignored-stale: The .monocfignore line "gone" matches no directory.',
        'warning ignored-stale: The .monocfignore line "!not-there" matches no directory.',
        '1 errors, 2 warnings',
        '',
      ].join('\n'),
    )
  })

  it('takes every env an old line used to take, as a line with a word in it is a pattern', async () => {
    const fixture = createFixture({environments: ['dev'], ignore: ['in', 'workers/except'], workers: [{name: 'in'}, {name: 'except'}, {name: 'orders'}]})

    expect((await graphJson(fixture, ['-e', 'dev'])).ignored).toEqual(['except', 'in'])
  })
})
