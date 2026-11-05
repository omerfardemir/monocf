import {execFileSync} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {applyPlan, commitAll, deployFixture, firstRun, manifestOf, planFor, readPlan, stepOf, writePlan, writesOf} from '../helpers/deploy-fixtures.js'
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
    files: {'workers/billing/.gitignore': 'public', 'workers/billing/public/index.html': 'one'},
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
