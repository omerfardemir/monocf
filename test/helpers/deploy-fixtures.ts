import {execFileSync} from 'node:child_process'
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {basename, dirname, join} from 'node:path'
import {expect} from 'vitest'

import {createFixture, runCli, type CliResult, type FakeCloudflare, type Fixture, type RunOptions, type WranglerCall, type WranglerRule} from './harness.js'

/** gateway calls orders, which calls billing. reports stands alone. */
const CHAIN = [
  {envBindings: {staging: ['orders']}, name: 'gateway'},
  {envBindings: {staging: ['billing']}, name: 'orders'},
  {name: 'billing'},
  {name: 'reports'},
]

export function deployFixture(options: Partial<Parameters<typeof createFixture>[0]> = {}): Fixture {
  const fixture = createFixture({environments: ['staging'], workers: CHAIN, ...options})
  mkdirSync(join(fixture.root, 'state', 'staging'), {recursive: true})
  writeFileSync(join(fixture.root, '.git', 'info', 'exclude'), 'state\nplan.json\n')
  return fixture
}

export function commitAll(fixture: Fixture): string {
  const git = (...args: string[]) => execFileSync('git', args, {cwd: fixture.root, encoding: 'utf8'}).trim()
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'change')
  return git('rev-parse', 'HEAD')
}

export function changeConfig(fixture: Fixture, worker: string, config: Record<string, unknown>): string {
  writeFileSync(join(fixture.worker(worker), 'wrangler.jsonc'), JSON.stringify(config))
  return commitAll(fixture)
}

export async function planFor(fixture: Fixture, cloudflare: FakeCloudflare, {flags = [], rules = []}: {flags?: string[]; rules?: WranglerRule[]} = {}) {
  const result = await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--out', 'plan.json', ...flags], {cloudflare, rules})
  expect(result.exitCode, result.stderr).toBe(0)
  return readPlan(fixture)
}

export function readPlan(fixture: Fixture) {
  return JSON.parse(readFileSync(join(fixture.root, 'plan.json'), 'utf8'))
}

export function writePlan(fixture: Fixture, change: Record<string, unknown>): void {
  writeFileSync(join(fixture.root, 'plan.json'), JSON.stringify({...readPlan(fixture), ...change}))
}

export function applyPlan(fixture: Fixture, cloudflare: FakeCloudflare, options: Omit<RunOptions, 'cloudflare'> & {flags?: string[]} = {}): Promise<CliResult> {
  const {flags = [], ...rest} = options
  return runCli(fixture, ['apply', 'plan.json', ...flags], {cloudflare, ...rest})
}

/** Everything is live, by way of a first plan and apply. */
export async function firstRun(fixture: Fixture): Promise<FakeCloudflare> {
  await planFor(fixture, {}, {flags: ['--first-run']})
  const result = await applyPlan(fixture, {})
  expect(result.exitCode, result.stderr).toBe(0)
  return result.cloudflare!
}

/** A rule that makes the given workers' next plan see new code. */
export function newCode(...workers: string[]): WranglerRule[] {
  return workers.map((worker) => ({bundle: `export default {} // new code of ${worker}\n`, command: 'deploy', worker}))
}

export function actionsOf(plan: {steps: {action: string; worker: string}[]}): Record<string, string> {
  return Object.fromEntries(plan.steps.map(({action, worker}) => [worker, action]))
}

/** The writes of a run, in order, such as `promote billing`. */
export function writesOf(calls: WranglerCall[]): string[] {
  const kinds: [string, string][] = [
    ['versions upload', 'upload'],
    ['versions deploy', 'promote'],
    ['triggers deploy', 'triggers'],
    ['deploy', 'deploy'],
  ]
  return calls.flatMap(({argv, configPaths}) => {
    const line = argv.join(' ')
    const kind = kinds.find(([command]) => line.startsWith(`${command} `))
    if (!kind || argv.includes('--dry-run')) return []
    // A rollback's triggers run from a config of their own, one level further down.
    const dir = basename(dirname(configPaths[0]))
    return [`${kind[1]} ${dir === 'triggers' ? basename(dirname(dirname(configPaths[0]))) : dir}`]
  })
}

export function callsOf(calls: WranglerCall[], write: string): WranglerCall[] {
  return calls.filter((call) => writesOf([call])[0] === write)
}

export function manifestOf(fixture: Fixture) {
  return JSON.parse(readFileSync(join(fixture.root, 'state', 'staging', 'manifest.json'), 'utf8'))
}

export function runIds(fixture: Fixture): string[] {
  return readdirSync(join(fixture.root, 'state', 'staging', 'runs')).map((name) => name.replace(/\.json$/, '')).sort()
}

/** By when it finished, as a run ID only sorts to the second, and two runs can share one. */
export function lastRunRecord(fixture: Fixture) {
  const records = runIds(fixture).map((id) => JSON.parse(readFileSync(join(fixture.root, 'state', 'staging', 'runs', `${id}.json`), 'utf8')))
  return records.sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : 1)).at(-1)
}

export function eventsOf(result: CliResult): Record<string, unknown>[] {
  return result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

export function activeOf(cloudflare: FakeCloudflare | undefined, step: {deployedName: string}): string {
  return cloudflare!.workers![step.deployedName].active[0][0]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stepOf = (plan: {steps: any[]}, worker: string) => plan.steps.find((step) => step.worker === worker)!
