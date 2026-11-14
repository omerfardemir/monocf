import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {repoRoot} from '../helpers/commands.js'
import {deployFixture, eventsOf, readPlan} from '../helpers/deploy-fixtures.js'
import {createFixture, runCli, type CliResult} from '../helpers/harness.js'

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8').replaceAll('\r\n', '\n')
const doc = read('docs/json-output.md')

/** A documented shape: each field, and whether it can be left out. */
type Shape = Record<string, {optional: boolean}>

/** Every `### heading` in a `## part` of the doc, with the fields its table lists. */
function documented(part: string): Map<string, Shape> {
  const start = doc.indexOf(`\n## ${part}\n`)
  expect(start, part).toBeGreaterThan(-1)
  const end = doc.indexOf('\n## ', start + 1)
  const shapes = new Map<string, Shape>()
  for (const block of doc.slice(start, end).split('\n### ').slice(1)) {
    const [heading, ...lines] = block.split('\n')
    const shape: Shape = {}
    for (const line of lines) {
      const row = /^\| `(\w+)` \| ([^|]+) \|/.exec(line)
      if (row) shape[row[1]] = {optional: row[2].includes('optional')}
    }

    shapes.set(heading.replaceAll('`', ''), shape)
  }

  return shapes
}

function withoutComments(source: string): string {
  return source.replaceAll(/\/\*\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '')
}

/** The fields of an object type written as `{a: string; b?: number}` or as a block, leaving nested object types out. */
function fieldsOf(body: string): Shape {
  let flat = withoutComments(body).trim().replace(/^{/, '').replace(/}$/, '')
  while (/{[^{}]*}/.test(flat)) flat = flat.replaceAll(/{[^{}]*}/g, '')
  return Object.fromEntries([...flat.matchAll(/(\w+)(\?)?:/g)].map(([, name, optional]) => [name, {optional: optional === '?'}]))
}

function interfaceOf(file: string, name: string): Shape {
  const source = read(file)
  const start = source.indexOf(`export interface ${name} `)
  expect(start, name).toBeGreaterThan(-1)
  const open = source.indexOf('{', start)
  return fieldsOf(source.slice(open, source.indexOf('\n}', open) + 2))
}

/** Each member of the ReportEvent union in events.ts, by its type. */
function eventsInSource(): Map<string, Shape> {
  const source = read('src/report/events.ts')
  const union = source.slice(source.indexOf('export type ReportEvent ='), source.indexOf('export interface ErrorEvent'))
  const shapes = new Map<string, Shape>()
  for (const member of union.split(/\n {2}\| /).slice(1)) {
    const type = /type: '([a-z-]+)'/.exec(member)?.[1]
    if (type) shapes.set(type, fieldsOf(member))
  }

  shapes.set('error', interfaceOf('src/report/events.ts', 'ErrorEvent'))
  for (const shape of shapes.values()) delete shape.type
  return shapes
}

function without(shape: Shape, ...names: string[]): Shape {
  return Object.fromEntries(Object.entries(shape).filter(([name]) => !names.includes(name)))
}

/** What an object really has is in the shape, and what the shape says is always there is. */
function expectMatches(value: Record<string, unknown>, shape: Shape, what: string): void {
  const keys = Object.keys(value).filter((key) => key !== 'schemaVersion' && key !== 'type')
  expect(keys.filter((key) => !Object.hasOwn(shape, key)), `${what}: fields not documented`).toEqual([])
  const required = Object.entries(shape).filter(([, {optional}]) => !optional).map(([name]) => name)
  expect(required.filter((name) => !Object.hasOwn(value, name) && name !== 'schemaVersion'), `${what}: fields missing`).toEqual([])
}

const events = documented('Events')
const files = new Map([...documented('Plan file'), ...documented('Bundle manifest')])

describe('docs/json-output.md', () => {
  it('describes every event in src/report/events.ts, field by field', () => {
    const source = eventsInSource()
    expect([...events.keys()].sort()).toEqual([...source.keys()].sort())
    for (const [type, shape] of source) expect(events.get(type), type).toEqual(shape)
  })

  it.each([
    ['Plan', 'src/plan/plan.ts', 'Plan'],
    ['Plan step', 'src/plan/plan.ts', 'PlanStep'],
    ['Plan note', 'src/plan/plan.ts', 'PlanNote'],
    ['Bundle manifest', 'src/app/bundle.ts', 'BundleManifest'],
    ['Bundle manifest worker', 'src/app/bundle.ts', 'ManifestWorker'],
  ])('describes the %s as the source has it', (heading, file, name) => {
    expect(files.get(heading)).toEqual(interfaceOf(file, name))
  })

  it('describes what real runs print', async () => {
    const fixture = deployFixture()
    const state = ['-e', 'staging', '--state', 'file:state']
    const runs: CliResult[] = []
    const run = async (args: string[], options: Parameters<typeof runCli>[2] = {}) => {
      const result = await runCli(fixture, args, options)
      runs.push(result)
      return result
    }

    const planned = await run(['plan', ...state, '--first-run', '--out', 'plan.json', '--json'], {cloudflare: {}})
    expect(planned.exitCode, planned.stderr).toBe(0)
    const applied = await run(['apply', 'plan.json', '--json'], {cloudflare: {}})
    expect(applied.exitCode, applied.stderr).toBe(0)
    const runId = eventsOf(applied)[0].runId as string
    // A first run created everything, so there's nothing to put back and nothing to ask Cloudflare.
    await run(['rollback', ...state, '--to-run', runId, '--dry-run', '--json'], {cloudflare: applied.cloudflare, noCalls: true})
    await run(['bundle', '-e', 'staging', '--json'])
    await run(['whoami', '--json'])
    await run(['worker', 'create', 'extra', '--json'], {noCalls: true})
    await run(['plan', '-e', 'staging', '--json'], {noCalls: true})

    const printed = runs.flatMap((result) => eventsOf(result))
    const types = new Set(printed.map(({type}) => type as string))
    for (const type of ['run-started', 'step-started', 'step-finished', 'run-finished', 'plan', 'bundle-written', 'whoami', 'worker-created', 'error']) {
      expect(types, type).toContain(type)
    }

    for (const event of printed) {
      expect(event.schemaVersion).toBe(1)
      expect(events.has(event.type as string), event.type as string).toBe(true)
      expectMatches(event, events.get(event.type as string)!, event.type as string)
    }

    const plan = readPlan(fixture)
    expectMatches(plan, files.get('Plan')!, 'plan')
    for (const step of plan.steps) expectMatches(step, files.get('Plan step')!, 'plan step')
    const manifest = printed.find(({type}) => type === 'bundle-written')!.manifest as {workers: Record<string, Record<string, unknown>>}
    expectMatches(manifest, files.get('Bundle manifest')!, 'bundle manifest')
    for (const worker of Object.values(manifest.workers)) expectMatches(worker, files.get('Bundle manifest worker')!, 'bundle manifest worker')
  }, 300_000)

  it('describes the secrets-check event a real run prints', async () => {
    const fixture = createFixture({environments: ['staging'], workers: [{config: {env: {staging: {secrets: {required: ['API_KEY', 'OTHER']}}}}, name: 'orders'}]})
    const cloudflare = {workers: {'orders-v1-staging': {active: [['v1', 100]] as [string, number][], secrets: ['API_KEY', 'LEFTOVER'], tags: {v1: null}}}}

    const result = await runCli(fixture, ['secrets', 'check', '-e', 'staging', '--json'], {cloudflare})

    const checked = eventsOf(result).find(({type}) => type === 'secrets-check')!
    expectMatches(checked, events.get('secrets-check')!, 'secrets-check')
  })

  it.each([
    ['graph --json', ['graph', '-e', 'staging', '--json']],
    ['check --json', ['check', '-e', 'staging', '--json']],
    ['commands --json', ['commands', '--json']],
    ['explain --json', ['explain', '--json']],
  ])('describes the document of %s', async (heading, args) => {
    const fixture = createFixture({environments: ['staging'], workers: [{envBindings: {staging: ['billing']}, name: 'orders'}, {name: 'billing'}]})

    const result = await runCli(fixture, args, {noCalls: true})

    expect(result.exitCode, result.stderr).toBe(0)
    const document = JSON.parse(result.stdout)
    expect(document.schemaVersion).toBe(1)
    expectMatches(document, without(documented('Documents').get(heading)!, 'schemaVersion'), heading)
  })
})
