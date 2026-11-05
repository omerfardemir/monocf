import {execFileSync} from 'node:child_process'
import {mkdirSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {applyPlan, commitAll, deployFixture, firstRun, manifestOf, newCode, planFor, readPlan, stepOf, writePlan, writesOf} from '../helpers/deploy-fixtures.js'
import {createFixture, flagValue, releaseOf, runCli, type Fixture} from '../helpers/harness.js'

const git = (fixture: Fixture, ...args: string[]) => execFileSync('git', args, {cwd: fixture.root, encoding: 'utf8'}).trim()

const refuses = async (fixture: Fixture, pattern: RegExp, flags: string[] = []) => {
  const result = await runCli(fixture, ['apply', 'plan.json', ...flags], {cloudflare: {}, noCalls: true})
  expect(result.exitCode, result.stderr).toBe(2)
  expect(result.stderr).toMatch(pattern)
  expect(result.calls).toEqual([])
}

/** billing's assets are built, so git can't see them. */
function withIgnoredAssets(config: Record<string, unknown> = {}): Fixture {
  const fixture = createFixture({
    environments: ['staging'],
    files: {'workers/billing/.gitignore': 'public\nsite\n', 'workers/billing/public/index.html': 'one'},
    workers: [{config: {assets: {directory: './public'}, ...config}, name: 'billing'}],
  })
  mkdirSync(join(fixture.root, 'state', 'staging'), {recursive: true})
  writeFileSync(join(fixture.root, '.git', 'info', 'exclude'), 'state\nplan.json\n')
  return fixture
}

describe('apply, against what is on disk (WP6-1)', () => {
  it('refuses an uncommitted config, naming the path', async () => {
    const fixture = deployFixture()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare)
    writeFileSync(join(fixture.worker('billing'), 'wrangler.jsonc'), JSON.stringify({vars: {EVIL: 'dirty-after-plan'}}))

    await refuses(fixture, /changes the plan doesn't include: workers\/billing\/wrangler\.jsonc/)
  })

  it('refuses an untracked file, and names a few of many', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) writeFileSync(join(fixture.root, `${name}.txt`), name)

    await refuses(fixture, /a\.txt, b\.txt, c\.txt, d\.txt, e\.txt, and 2 more/)
  })

  it('names a path from the root when the root is not a real path, as a short name on a Windows runner is not', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    writeFileSync(join(fixture.root, 'a.txt'), 'a')
    const link = join(fixture.root, '..', 'linked')
    symlinkSync(fixture.root, link, 'junction')

    try {
      await refuses(fixture, /doesn't include: a\.txt\. Commit/, ['--root-dir', link])
    } finally {
      unlinkSync(link)
    }
  })

  it('refuses a new file beside the workers, as a worker can import it', async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    writeFileSync(join(fixture.root, '..', 'outside.txt'), 'not in this repository')
    writeFileSync(join(fixture.root, 'workers', 'shared.ts'), 'export const a = 1\n')

    await refuses(fixture, /workers\/shared\.ts/)
  })

  it('refuses a base config other than the one planned, naming the worker and what differs', async () => {
    const fixture = deployFixture({files: {'other.jsonc': JSON.stringify({compatibility_date: '2020-01-01', env: {staging: {}}, main: 'src/index.ts', name: '{workerName}-{version}'})}})
    await planFor(fixture, {}, {flags: ['--first-run']})

    await refuses(fixture, /doesn't describe this checkout: .*billing \(config\).*Plan again/, ['--base-config', 'other.jsonc'])
  })

  it.each([
    ['configHash', 'config'],
    ['doHash', 'Durable Objects'],
    ['triggersHash', 'triggers'],
    ['externalHash', 'external inputs'],
  ])('refuses when %s differs from what this checkout gives', async (field, name) => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    const plan = readPlan(fixture)
    stepOf(plan, 'billing')[field] = 'something-else'
    writePlan(fixture, plan)

    await refuses(fixture, new RegExp(`billing \\(${name}\\)`))
  })

  it('refuses a gitignored input that changed after the plan, which git cannot see', async () => {
    const fixture = withIgnoredAssets()
    await planFor(fixture, {}, {flags: ['--first-run']})
    writeFileSync(join(fixture.worker('billing'), 'public', 'index.html'), 'two')
    expect(git(fixture, 'status', '--porcelain')).toBe('')

    await refuses(fixture, /billing \(external inputs\)/)
  })

  it('says how to get out when a CI step builds the inputs, as planning again cannot help (R9)', async () => {
    const fixture = withIgnoredAssets()
    await planFor(fixture, {}, {flags: ['--first-run']})
    writeFileSync(join(fixture.worker('billing'), 'public', 'index.html'), 'two')

    await refuses(fixture, /give the worker a build\.command.*or bring the same files to this job/)
  })

  it("doesn't offer that way out for anything else that differs (R9)", async () => {
    const fixture = deployFixture()
    await planFor(fixture, {}, {flags: ['--first-run']})
    const plan = readPlan(fixture)
    stepOf(plan, 'billing').configHash = 'something-else'
    writePlan(fixture, plan)

    const result = await runCli(fixture, ['apply', 'plan.json'], {cloudflare: {}, noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stderr).not.toContain('build.command')
  })

  describe('under a build command, the state says what was uploaded (R3)', () => {
    /** The first run is live, and the plan after it saw `one`. The apply job's build makes `two`. */
    async function appliedWithOtherContent(config: Record<string, unknown>, directory: string) {
      const fixture = withIgnoredAssets({build: {command: 'npm run build'}, ...config})
      const file = join(fixture.worker('billing'), directory, 'index.html')
      mkdirSync(join(fixture.worker('billing'), directory), {recursive: true})
      writeFileSync(file, 'one')
      const cloudflare = await firstRun(fixture)
      const plan = await planFor(fixture, cloudflare, {rules: newCode('billing')})
      writeFileSync(file, 'two')
      const applied = await applyPlan(fixture, cloudflare)
      expect(applied.exitCode, applied.stderr).toBe(0)
      expect(applied.stderr).toContain('The state records what was uploaded')
      return {cloudflare: applied.cloudflare!, file, fixture, step: stepOf(plan, 'billing')}
    }

    // An upload, and a site, which takes a deploy.
    const paths: [string, Record<string, unknown>, string][] = [
      ['assets', {}, 'public'],
      ['a site', {assets: undefined, site: {bucket: './site'}}, 'site'],
    ]

    it.each(paths)('%s: going back to what the plan saw is a change, not a skip', async (_, config, directory) => {
      const {cloudflare, file, fixture, step} = await appliedWithOtherContent(config, directory)
      expect(manifestOf(fixture).workers.billing.externalHash).not.toBe(step.externalHash)
      expect(manifestOf(fixture).workers.billing.fingerprint).toBe(step.fingerprint)
      writeFileSync(file, 'one')

      const next = await planFor(fixture, cloudflare, {rules: newCode('billing')})

      expect(stepOf(next, 'billing').reasons).toContain('external-changed')
      expect(stepOf(next, 'billing').action).not.toBe('skip')
    })

    it.each(paths)('%s: staying on what was uploaded is a skip', async (_, config, directory) => {
      const {cloudflare, fixture} = await appliedWithOtherContent(config, directory)

      const next = await planFor(fixture, cloudflare, {rules: newCode('billing')})

      expect(stepOf(next, 'billing')).toMatchObject({action: 'skip', reasons: ['unchanged']})
    })

    it('stores what the plan saw when the build makes the same', async () => {
      const fixture = withIgnoredAssets({build: {command: 'npm run build'}})
      await planFor(fixture, {}, {flags: ['--first-run']})
      const {externalHash} = stepOf(readPlan(fixture), 'billing')

      const result = await applyPlan(fixture, {})

      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stderr).not.toContain('The state records what was uploaded')
      expect(manifestOf(fixture).workers.billing.externalHash).toBe(externalHash)
    })
  })

  it('goes ahead when a build command makes the inputs at deploy, and says so', async () => {
    const fixture = withIgnoredAssets({build: {command: 'npm run build'}})
    await planFor(fixture, {}, {flags: ['--first-run']})
    writeFileSync(join(fixture.worker('billing'), 'public', 'index.html'), 'two')

    const result = await applyPlan(fixture, {})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain('Its build command makes them again at deploy')
  })

  it("doesn't count the plan, its markdown, a reused bundle, the summary file, the state or .monocf", async () => {
    const fixture = deployFixture()
    const bundle = await runCli(fixture, ['bundle', '-e', 'staging', '--out', 'out/bundle'])
    expect(bundle.exitCode, bundle.stderr).toBe(0)
    await planFor(fixture, {}, {flags: ['--first-run', '--markdown', 'plan.md', '--bundle-dir', 'out/bundle']})
    expect(readPlan(fixture).outputs).toEqual(['out/bundle', 'plan.md'])
    expect(git(fixture, 'status', '--porcelain', '-uall').split('\n').some((line) => line.endsWith('plan.md'))).toBe(true)

    const result = await applyPlan(fixture, {}, {flags: ['--summary-file', 'summary.md']})

    expect(result.exitCode, result.stderr).toBe(0)
  })

  it('refuses a staged rename into an exempt directory, which would hide the deletion (R10)', async () => {
    const fixture = deployFixture({files: {'workers/reports/src/unused.js': 'export const unused = 1\n'}})
    await planFor(fixture, {}, {flags: ['--first-run']})
    mkdirSync(join(fixture.root, '.monocf'), {recursive: true})
    git(fixture, 'mv', 'workers/reports/src/unused.js', '.monocf/unused.js')
    expect(git(fixture, 'status', '--porcelain', 'workers/reports/src/unused.js', '.monocf/unused.js')).toMatch(/^R/)

    await refuses(fixture, /doesn't include: workers\/reports\/src\/unused\.js\. Commit/)
  })
})

describe('apply, and a linked root (R13, M18)', () => {
  it("doesn't count the plan's own files when the root is reached through a link", async () => {
    const fixture = deployFixture()
    const link = join(fixture.root, '..', 'linked')
    symlinkSync(fixture.root, link, 'junction')

    try {
      await planFor(fixture, {}, {flags: ['--first-run', '--root-dir', link, '--markdown', join(link, 'plan.md')]})
      expect(readPlan(fixture).outputs).toEqual(['plan.md'])
      expect(git(fixture, 'status', '--porcelain', '-uall', 'plan.md')).toContain('plan.md')

      const result = await applyPlan(fixture, {}, {flags: ['--root-dir', link]})

      expect(result.exitCode, result.stderr).toBe(0)
    } finally {
      unlinkSync(link)
    }
  })
})

/** No gitignore for the state, as a person trying monocf out may not have one. */
function withStateInTheOpen(options: Partial<Parameters<typeof deployFixture>[0]> = {}): Fixture {
  const fixture = deployFixture({workers: [{name: 'billing'}], ...options})
  writeFileSync(join(fixture.root, '.git', 'info', 'exclude'), 'plan.json\n')
  return fixture
}

const planState = (state: string) => ['plan', '-e', 'staging', '--state', state, '--first-run', '--out', 'plan.json']

describe('a file: state directory, and what it exempts (R2)', () => {
  it.each([
    ['file:.', /state directory .* holds the project root/],
    ['file:workers', /state directory .* holds the worker billing/],
    ['file:workers/billing', /state directory .* holds the worker billing/],
    ['file:..', /state directory .* holds the project root/],
  ])('plan refuses %s, which holds what gets deployed', async (state, message) => {
    const fixture = withStateInTheOpen()

    const result = await runCli(fixture, planState(state), {cloudflare: {}, noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(message)
    expect(result.calls).toEqual([])
  })

  it.each([
    ['file:.', /state directory .* holds the project root/],
    ['file:workers', /state directory .* holds the worker billing/],
  ])('apply refuses a plan that names %s, with uncommitted source or without', async (state, message) => {
    const fixture = withStateInTheOpen()
    await planFor(fixture, {}, {flags: ['--first-run']})
    writePlan(fixture, {state})

    await refuses(fixture, message)

    writeFileSync(join(fixture.worker('billing'), 'src', 'index.ts'), 'export default {} // uncommitted\n')
    await refuses(fixture, message)
  })

  it('counts anything else in the state directory as a change', async () => {
    const fixture = withStateInTheOpen()
    await planFor(fixture, {}, {flags: ['--first-run']})
    writeFileSync(join(fixture.root, 'state', 'notes.txt'), 'mine')

    await refuses(fixture, /doesn't include: state\/notes\.txt\. Commit/)
  })

  it('counts a file beside the manifest in the env directory as a change', async () => {
    const fixture = withStateInTheOpen()
    await planFor(fixture, {}, {flags: ['--first-run']})
    writeFileSync(join(fixture.root, 'state', 'staging', 'shared.ts'), 'export const a = 1\n')

    await refuses(fixture, /doesn't include: state\/staging\/shared\.ts\. Commit/)
  })

  it("doesn't count the manifest or run records monocf wrote there, for this env or another", async () => {
    const fixture = withStateInTheOpen({environments: ['staging', 'dev']})
    const cloudflare = await firstRun(fixture)
    mkdirSync(join(fixture.root, 'state', 'dev', 'runs'), {recursive: true})
    writeFileSync(join(fixture.root, 'state', 'dev', 'manifest.json'), '{}')
    writeFileSync(join(fixture.root, 'state', 'dev', 'runs', 'a-run.json'), '{}')
    expect(git(fixture, 'status', '--porcelain', '-uall')).toContain('state/staging/manifest.json')
    await planFor(fixture, cloudflare, {rules: newCode('billing')})

    const result = await applyPlan(fixture, cloudflare)

    expect(result.exitCode, result.stderr).toBe(0)
  })

  it("runs the README's sample as written, plan and apply in one job, again and again", async () => {
    const fixture = withStateInTheOpen()
    writeFileSync(join(fixture.root, '.git', 'info', 'exclude'), '')
    const sample = ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json', '--markdown', 'plan.md']

    const first = await runCli(fixture, [...sample, '--first-run'], {cloudflare: {}})
    expect(first.exitCode, first.stderr).toBe(0)
    const applied = await runCli(fixture, ['apply', 'plan.json'], {cloudflare: {}})
    expect(applied.exitCode, applied.stderr).toBe(0)

    expect(git(fixture, 'status', '--porcelain', '-uall')).toContain('state/staging/manifest.json')
    const second = await runCli(fixture, sample, {cloudflare: applied.cloudflare, rules: newCode('billing')})
    expect(second.exitCode, second.stderr).toBe(0)
    const again = await runCli(fixture, ['apply', 'plan.json'], {cloudflare: applied.cloudflare})
    expect(again.exitCode, again.stderr).toBe(0)
    expect(writesOf(again.calls)).toEqual(['upload billing', 'promote billing'])
  })

  it('reaches the same state directory through a linked root', async () => {
    const fixture = withStateInTheOpen()
    const cloudflare = await firstRun(fixture)
    await planFor(fixture, cloudflare, {rules: newCode('billing')})
    const link = join(fixture.root, '..', 'linked')
    symlinkSync(fixture.root, link, 'junction')

    try {
      const result = await runCli(fixture, ['apply', 'plan.json', '--root-dir', link], {cloudflare})

      expect(result.exitCode, result.stderr).toBe(0)
    } finally {
      unlinkSync(link)
    }
  })
})

describe('a reused --bundle-dir, and what it exempts (R2)', () => {
  it.each([
    ['workers', /bundle directory .* holds the worker billing/],
    ['.', /bundle directory .* holds the project root/],
  ])('plan refuses %s, which holds what gets deployed', async (dir, message) => {
    const fixture = deployFixture({workers: [{name: 'billing'}]})

    const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--out', 'plan.json', '--bundle-dir', dir], {cloudflare: {}, noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(message)
  })

  it('apply refuses a plan whose outputs hold a worker, so uncommitted source cannot ship', async () => {
    const fixture = deployFixture({workers: [{name: 'billing'}]})
    await planFor(fixture, {}, {flags: ['--first-run']})
    writePlan(fixture, {outputs: ['workers']})
    writeFileSync(join(fixture.worker('billing'), 'src', 'index.ts'), 'export default {} // uncommitted\n')

    await refuses(fixture, /plan's output .* holds the worker billing/)
  })

  it('still lets a bundle directory of its own pass', async () => {
    const fixture = deployFixture({workers: [{name: 'billing'}]})
    const bundle = await runCli(fixture, ['bundle', '-e', 'staging', '--out', 'out/bundle'])
    expect(bundle.exitCode, bundle.stderr).toBe(0)
    await planFor(fixture, {}, {flags: ['--first-run', '--bundle-dir', 'out/bundle']})
    expect(readPlan(fixture).outputs).toEqual(['out/bundle'])

    const result = await applyPlan(fixture, {})

    expect(result.exitCode, result.stderr).toBe(0)
  })
})

describe('plan, when GITHUB_SHA is not what is checked out (WP6-1)', () => {
  const plan = ['plan', '-e', 'staging', '--state', 'file:state', '--first-run', '--out', 'plan.json']

  it('plans for the real HEAD, says so, and gives a plan that can be applied', async () => {
    const fixture = deployFixture()
    const head = git(fixture, 'rev-parse', 'HEAD')
    const other = 'a'.repeat(40)

    const planned = await runCli(fixture, plan, {cloudflare: {}, env: {GITHUB_SHA: other}})

    expect(planned.exitCode, planned.stderr).toBe(0)
    expect(planned.stderr).toContain(`GITHUB_SHA says ${other}, and ${head} is checked out`)
    expect(readPlan(fixture).commit).toBe(head)

    const applied = await runCli(fixture, ['apply', 'plan.json'], {cloudflare: {}, env: {GITHUB_SHA: other}})

    expect(applied.exitCode, applied.stderr).toBe(0)
    const deploy = applied.calls.find(({argv}) => argv[0] === 'deploy')!
    expect(releaseOf(deploy)).toBe(head.slice(0, 7))
    expect(flagValue(deploy, '--message')).toContain(head.slice(0, 7))
    expect(manifestOf(fixture).workers.billing.commit).toBe(head)
    expect(writesOf(applied.calls)).toContain('deploy billing')
  })

  it("won't ship another commit's code under this plan", async () => {
    const fixture = deployFixture()
    const first = git(fixture, 'rev-parse', 'HEAD')
    writeFileSync(join(fixture.worker('billing'), 'src', 'index.ts'), 'export default {}\n')
    commitAll(fixture)

    const planned = await runCli(fixture, plan, {cloudflare: {}, env: {GITHUB_SHA: first}})
    expect(planned.exitCode, planned.stderr).toBe(0)
    git(fixture, 'checkout', '--quiet', first)

    const applied = await runCli(fixture, ['apply', 'plan.json'], {cloudflare: {}, env: {GITHUB_SHA: first}, noCalls: true})

    expect(applied.exitCode).toBe(2)
    expect(applied.stderr).toContain('Plan on this commit')
    expect(applied.calls).toEqual([])
  })
})
