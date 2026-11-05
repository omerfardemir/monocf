/* eslint-disable max-params */
import {describe, expect, it} from 'vitest'

import type {ManifestWorker} from '../../src/app/bundle.js'
import type {Triggers} from '../../src/fingerprint/fingerprint.js'
import type {Edge, Graph} from '../../src/graph/graph.js'
import {createPlan, needsTag, tagFor, type OnDrift, type Plan, type PlanStep} from '../../src/plan/plan.js'
import type {StateManifest, StateWorker} from '../../src/state/manifest.js'
import type {ActiveInfo} from '../../src/wrangler/read.js'

const noCrons: Triggers = {crons: null, previewUrls: null, routes: [], workersDev: true}

function bundled(name: string, overrides: Partial<ManifestWorker> = {}): ManifestWorker {
  return {
    bundleHash: 'bundle-1',
    configHash: 'config-1',
    deployedName: `${name}-staging`,
    doHash: 'do-1',
    fingerprint: 'fp-1',
    triggers: noCrons,
    triggersHash: 'triggers-1',
    version: '1.0.0',
    ...overrides,
  }
}

function stored(name: string, overrides: Partial<StateWorker> = {}): StateWorker {
  return {
    bundleHash: 'bundle-1',
    commit: 'old-commit',
    configHash: 'config-1',
    deployedAt: '2026-01-01T00:00:00.000Z',
    deployedName: `${name}-staging`,
    doHash: 'do-1',
    fingerprint: 'fp-1',
    triggers: noCrons,
    triggersHash: 'triggers-1',
    version: '1.0.0',
    versionId: 'version-1',
    ...overrides,
  }
}

function graphOf(nodes: string[], edges: [string, string, Edge['kind']?][] = []): Graph {
  return {
    edges: edges.map(([from, to, kind]) => ({from, kind: kind ?? 'services', to, via: 'B'})),
    external: [],
    nodes: [...nodes].sort(),
  }
}

interface Scenario {
  active?: Record<string, ActiveInfo>
  graph?: Graph
  onDrift?: OnDrift
  repositoryWorkers?: string[]
  state?: Record<string, StateWorker> | null
  workers: Record<string, ManifestWorker>
}

function plan({active = {}, graph, onDrift = 'warn', repositoryWorkers, state = null, workers}: Scenario): Plan {
  const names = Object.keys(workers)
  const manifest: null | StateManifest = state && {env: 'staging', schemaVersion: 1, updatedAt: '2026-01-01', workers: state}
  return createPlan(
    {commit: 'new-commit', env: 'staging', workers, wrangler: '4.151.1'},
    manifest,
    active,
    graph ?? graphOf(names),
    {createdAt: '2026-02-02T00:00:00.000Z', onDrift, repositoryWorkers: repositoryWorkers ?? names, state: 'file:state'},
  )
}

function stepOf(result: Plan, name = 'orders'): PlanStep {
  return result.steps.find(({worker}) => worker === name)!
}

const live: ActiveInfo = {state: 'active', versionId: 'version-1'}
const elsewhere = (tag?: string): ActiveInfo => ({state: 'active', tag, versionId: 'version-2'})
const split: ActiveInfo = {
  shares: [
    {percentage: 60, versionId: 'version-2'},
    {percentage: 40, versionId: 'version-1'},
  ],
  state: 'split',
}

function one(worker: Partial<ManifestWorker>, entry: null | Partial<StateWorker>, active: ActiveInfo, onDrift?: OnDrift): Plan {
  return plan({
    active: {orders: active},
    onDrift,
    state: entry ? {orders: stored('orders', entry)} : null,
    workers: {orders: bundled('orders', worker)},
  })
}

describe('classification', () => {
  type Row = [
    title: string,
    worker: Partial<ManifestWorker>,
    entry: null | Partial<StateWorker>,
    active: ActiveInfo,
    expected: {action: PlanStep['action']; note?: string; reasons: PlanStep['reasons']; triggersChanged?: boolean},
  ]

  const rows: Row[] = [
    ['a worker that does not exist, never seen', {}, null, {state: 'missing'}, {action: 'create', reasons: ['new'], triggersChanged: true}],
    [
      'a worker that does not exist any more',
      {},
      {},
      {state: 'missing'},
      {action: 'create', note: 'recreated', reasons: ['new'], triggersChanged: true},
    ],
    ['exists, no entry, tag equals', {}, null, elsewhere(tagFor('fp-1')), {action: 'adopt', reasons: ['state-missing'], triggersChanged: false}],
    ['exists, no entry, tag differs', {}, null, elsewhere(tagFor('other')), {action: 'upload', note: 'baseline', reasons: ['baseline'], triggersChanged: true}],
    ['exists, no entry, no tag', {}, null, elsewhere(), {action: 'upload', note: 'baseline', reasons: ['baseline'], triggersChanged: true}],
    ['in sync, nothing changed', {}, {}, live, {action: 'skip', reasons: ['unchanged'], triggersChanged: false}],
    ['in sync, triggers differ', {triggersHash: 'triggers-2'}, {}, live, {action: 'triggers', reasons: ['triggers-changed'], triggersChanged: true}],
    ['in sync, bundle differs', {bundleHash: 'bundle-2', fingerprint: 'fp-2'}, {}, live, {action: 'upload', reasons: ['bundle-changed'], triggersChanged: false}],
    ['in sync, config differs', {configHash: 'config-2', fingerprint: 'fp-2'}, {}, live, {action: 'upload', reasons: ['config-changed'], triggersChanged: false}],
    [
      'in sync, both differ, and triggers too',
      {bundleHash: 'bundle-2', configHash: 'config-2', fingerprint: 'fp-2', triggersHash: 'triggers-2'},
      {},
      live,
      {action: 'upload', reasons: ['bundle-changed', 'config-changed'], triggersChanged: true},
    ],
    [
      'fingerprint and DO hash differ',
      {configHash: 'config-2', doHash: 'do-2', fingerprint: 'fp-2'},
      {},
      live,
      {action: 'full-deploy', reasons: ['do-changed'], triggersChanged: false},
    ],
    [
      'state behind, tag equals the manifest, nothing to do',
      {},
      {},
      elsewhere(tagFor('fp-1')),
      {action: 'skip', note: 'state-behind', reasons: ['unchanged'], triggersChanged: false},
    ],
    [
      'state behind, tag equals the manifest, the bundle moved on',
      {bundleHash: 'bundle-2', fingerprint: 'fp-2'},
      {},
      elsewhere(tagFor('fp-1')),
      {action: 'upload', note: 'state-behind', reasons: ['bundle-changed'], triggersChanged: false},
    ],
    [
      'state behind, tag equals the manifest, triggers differ',
      {triggersHash: 'triggers-2'},
      {},
      elsewhere(tagFor('fp-1')),
      {action: 'triggers', note: 'state-behind', reasons: ['triggers-changed'], triggersChanged: true},
    ],
    [
      'state behind, a crashed run already deployed this bundle',
      {bundleHash: 'bundle-2', doHash: 'do-2', fingerprint: 'fp-2'},
      {},
      elsewhere(tagFor('fp-2')),
      {action: 'skip', note: 'state-behind', reasons: ['unchanged'], triggersChanged: false},
    ],
    [
      'state behind, a crashed run deployed this bundle, its triggers may not have landed',
      {bundleHash: 'bundle-2', fingerprint: 'fp-2', triggersHash: 'triggers-2'},
      {},
      elsewhere(tagFor('fp-2')),
      {action: 'triggers', note: 'state-behind', reasons: ['triggers-changed'], triggersChanged: true},
    ],
    ['drift, warn, otherwise equal still uploads', {}, {}, elsewhere(), {action: 'upload', note: 'drift', reasons: ['drift'], triggersChanged: true}],
    [
      'drift, warn, a foreign tag',
      {},
      {},
      elsewhere(tagFor('someone-else')),
      {action: 'upload', note: 'drift', reasons: ['drift'], triggersChanged: true},
    ],
    [
      'drift, warn, triggers differ only',
      {triggersHash: 'triggers-2'},
      {},
      elsewhere(),
      {action: 'upload', note: 'drift', reasons: ['drift'], triggersChanged: true},
    ],
    [
      'drift, warn, bundle changed too',
      {bundleHash: 'bundle-2', fingerprint: 'fp-2'},
      {},
      elsewhere(),
      {action: 'upload', note: 'drift', reasons: ['drift', 'bundle-changed'], triggersChanged: true},
    ],
    [
      'drift, warn, DO changed too',
      {doHash: 'do-2', fingerprint: 'fp-2'},
      {},
      elsewhere(),
      {action: 'full-deploy', note: 'drift', reasons: ['drift', 'do-changed'], triggersChanged: true},
    ],
    ['split, warn', {}, {}, split, {action: 'upload', note: 'drift', reasons: ['drift', 'split'], triggersChanged: true}],
    ['split, warn, no entry', {}, null, split, {action: 'upload', note: 'drift', reasons: ['drift', 'split'], triggersChanged: true}],
    [
      'split, warn, DO changed',
      {doHash: 'do-2', fingerprint: 'fp-2'},
      {},
      split,
      {action: 'full-deploy', note: 'drift', reasons: ['drift', 'split', 'do-changed'], triggersChanged: true},
    ],
  ]

  it.each(rows)('%s', (_, worker, entry, active, {action, note, reasons, triggersChanged}) => {
    const result = one(worker, entry, active)
    const step = stepOf(result)

    expect(step.action).toBe(action)
    expect(step.reasons).toEqual(reasons)
    if (triggersChanged !== undefined) expect(step.triggersChanged).toBe(triggersChanged)
    expect(result.notes.map(({kind}) => kind)).toEqual(note ? [note] : [])
    expect(result.applicable).toBe(true)
  })
})

describe('--on-drift fail', () => {
  it.each<[string, Partial<ManifestWorker>, null | Partial<StateWorker>, ActiveInfo, PlanStep['reasons']]>([
    ['a version that nothing explains', {}, {}, elsewhere(), ['drift']],
    ['a split rollout', {}, {}, split, ['drift', 'split']],
    ['a split rollout with no entry', {}, null, split, ['drift', 'split']],
    ['a worker with no entry and another tag', {}, null, elsewhere(tagFor('other')), ['drift', 'baseline']],
  ])('blocks %s, and the plan says it can not be applied', (_, worker, entry, active, reasons) => {
    const result = one(worker, entry, active, 'fail')

    expect(stepOf(result).action).toBe('blocked')
    expect(stepOf(result).reasons).toEqual(reasons)
    expect(result.applicable).toBe(false)
  })

  it.each<[string, Partial<ManifestWorker>, null | Partial<StateWorker>, ActiveInfo, PlanStep['action']]>([
    ['in sync', {}, {}, live, 'skip'],
    ['state behind', {}, {}, elsewhere(tagFor('fp-1')), 'skip'],
    ['adopt', {}, null, elsewhere(tagFor('fp-1')), 'adopt'],
    ['new', {}, null, {state: 'missing'}, 'create'],
  ])('leaves %s alone', (_, worker, entry, active, action) => {
    const result = one(worker, entry, active, 'fail')

    expect(stepOf(result).action).toBe(action)
    expect(result.applicable).toBe(true)
  })

  it('blocks only the worker that drifted', () => {
    const result = plan({
      active: {billing: live, orders: elsewhere()},
      onDrift: 'fail',
      state: {billing: stored('billing'), orders: stored('orders')},
      workers: {billing: bundled('billing'), orders: bundled('orders')},
    })

    expect(stepOf(result, 'billing').action).toBe('skip')
    expect(stepOf(result, 'orders').action).toBe('blocked')
  })
})

describe('a recreated provider', () => {
  const graph = graphOf(
    ['api', 'orders', 'web'],
    [
      ['api', 'orders'],
      ['web', 'api'],
    ],
  )
  const workers = {api: bundled('api'), orders: bundled('orders'), web: bundled('web')}
  const state = {api: stored('api'), orders: stored('orders'), web: stored('web')}

  it('gives each direct caller with no new version one', () => {
    const result = plan({active: {api: live, orders: {state: 'missing'}, web: live}, graph, state, workers})

    expect(stepOf(result, 'orders').action).toBe('create')
    expect(stepOf(result, 'api').action).toBe('upload')
    expect(stepOf(result, 'api').reasons).toEqual(['provider-recreated'])
    expect(stepOf(result, 'api').dependsOn).toEqual(['orders'])
    expect(stepOf(result, 'web').action).toBe('skip')
  })

  it('does nothing for a worker that never existed', () => {
    const result = plan({
      active: {api: live, orders: {state: 'missing'}, web: live},
      graph,
      state: {api: stored('api'), web: stored('web')},
      workers,
    })

    expect(stepOf(result, 'orders').action).toBe('create')
    expect(stepOf(result, 'api').action).toBe('skip')
  })

  it('gives a new version to a caller that only needed its triggers, and keeps them flagged', () => {
    const result = plan({
      active: {api: live, orders: {state: 'missing'}, web: live},
      graph,
      state,
      workers: {...workers, api: bundled('api', {triggersHash: 'triggers-2'})},
    })

    expect(stepOf(result, 'api').action).toBe('upload')
    expect(stepOf(result, 'api').reasons).toEqual(['triggers-changed', 'provider-recreated'])
    expect(stepOf(result, 'api').triggersChanged).toBe(true)
  })

  it('leaves a blocked caller blocked', () => {
    const result = plan({active: {api: elsewhere(), orders: {state: 'missing'}, web: live}, graph, onDrift: 'fail', state, workers})

    expect(stepOf(result, 'api').action).toBe('blocked')
  })

  it('does not count a queue edge, which holds no binding', () => {
    const result = plan({
      active: {api: live, orders: {state: 'missing'}},
      graph: graphOf(['api', 'orders'], [['api', 'orders', 'queues']]),
      state: {api: stored('api'), orders: stored('orders')},
      workers: {api: bundled('api'), orders: bundled('orders')},
    })

    expect(stepOf(result, 'api').action).toBe('skip')
  })

  it('notes a caller left out of the selection', () => {
    const result = plan({
      active: {orders: {state: 'missing'}},
      graph,
      repositoryWorkers: ['api', 'orders', 'web'],
      state,
      workers: {orders: bundled('orders')},
    })

    expect(result.notes.map(({kind, worker}) => [kind, worker])).toEqual([
      ['caller-not-selected', 'api'],
      ['recreated', 'orders'],
    ])
  })
})

function crons(list: null | string[]): Triggers {
  return {...noCrons, crons: list}
}

describe('crons', () => {
  it.each<[string, null | string[], null | string[], boolean]>([
    ['removed from the config', ['0 0 * * *'], null, true],
    ['emptied in the config', ['0 0 * * *'], [], true],
    ['kept', ['0 0 * * *'], ['0 0 * * *'], false],
    ['changed', ['0 0 * * *'], ['0 1 * * *'], false],
    ['never there', null, null, false],
    ['empty before', [], null, false],
  ])('%s', (_, before, after, expected) => {
    const result = one({triggers: crons(after), triggersHash: JSON.stringify(after)}, {triggers: crons(before), triggersHash: JSON.stringify(before)}, live)

    expect(stepOf(result).explicitEmptyCrons).toBe(expected)
  })

  it('has nothing to compare with when the state has no entry', () => {
    expect(stepOf(one({triggers: crons(null)}, null, elsewhere())).explicitEmptyCrons).toBe(false)
  })
})

describe('order', () => {
  const graph = graphOf(
    ['api', 'orders', 'shared', 'web'],
    [
      ['api', 'shared'],
      ['shared', 'orders'],
      ['web', 'api'],
    ],
  )
  const workers = {api: bundled('api'), orders: bundled('orders'), shared: bundled('shared'), web: bundled('web')}
  const state = {api: stored('api'), orders: stored('orders'), shared: stored('shared'), web: stored('web')}
  const changed = {bundleHash: 'bundle-2', fingerprint: 'fp-2'}

  it('puts steps callees first, and depends only on steps that do something', () => {
    const result = plan({
      active: {api: live, orders: live, shared: live, web: live},
      graph,
      state,
      workers: {...workers, api: bundled('api', changed), web: bundled('web', changed)},
    })

    expect(result.steps.map(({worker}) => worker)).toEqual(['orders', 'shared', 'api', 'web'])
    expect(stepOf(result, 'web').dependsOn).toEqual(['api'])
    expect(stepOf(result, 'api').dependsOn).toEqual([])
  })

  it('keeps the order through a worker that is skipped', () => {
    const result = plan({
      active: {api: live, orders: live, shared: live, web: live},
      graph,
      state,
      workers: {...workers, api: bundled('api', changed), orders: bundled('orders', changed)},
    })

    expect(stepOf(result, 'shared').action).toBe('skip')
    expect(stepOf(result, 'api').dependsOn).toEqual(['orders'])
  })

  it('gives the callers for a smoke test, whatever the action', () => {
    const result = plan({active: {api: live, orders: live, shared: live, web: live}, graph, state, workers})

    expect(stepOf(result, 'shared').callers).toEqual(['api'])
    expect(stepOf(result, 'shared').transitiveCallers).toEqual(['api', 'web'])
    expect(stepOf(result, 'web').callers).toEqual([])
  })

  it('counts callers that are not selected', () => {
    const result = plan({
      active: {orders: live},
      graph,
      repositoryWorkers: Object.keys(workers),
      state,
      workers: {orders: bundled('orders', changed)},
    })

    expect(result.steps.map(({worker}) => worker)).toEqual(['orders'])
    expect(stepOf(result).callers).toEqual(['shared'])
    expect(stepOf(result).transitiveCallers).toEqual(['api', 'shared', 'web'])
    expect(stepOf(result).dependsOn).toEqual([])
  })

  it('has no cycle in dependsOn when a queue closes one', () => {
    const result = plan({
      active: {orders: {state: 'missing'}, shared: {state: 'missing'}},
      graph: graphOf(
        ['orders', 'shared'],
        [
          ['orders', 'shared', 'queues'],
          ['shared', 'orders'],
        ],
      ),
      workers: {orders: bundled('orders'), shared: bundled('shared')},
    })

    expect(stepOf(result, 'orders').dependsOn).toEqual([])
    expect(stepOf(result, 'shared').dependsOn).toEqual([])
  })
})

describe('the rest of a step and the plan', () => {
  it('copies what the bundle says', () => {
    const worker = bundled('orders', {bundleHash: 'b', configHash: 'c', doHash: 'd', fingerprint: 'f', triggersHash: 't', version: '2.0.0'})
    const result = plan({active: {orders: {state: 'missing'}}, workers: {orders: worker}})

    expect(result).toMatchObject({
      applicable: true,
      commit: 'new-commit',
      createdAt: '2026-02-02T00:00:00.000Z',
      env: 'staging',
      schemaVersion: 1,
      state: 'file:state',
      wrangler: '4.151.1',
    })
    expect(stepOf(result)).toMatchObject({bundleHash: 'b', configHash: 'c', deployedName: 'orders-staging', doHash: 'd', fingerprint: 'f', triggers: noCrons, triggersHash: 't', version: '2.0.0'})
  })

  it('leaves out a version the worker does not have', () => {
    const worker = bundled('orders', {version: undefined})
    expect(stepOf(plan({active: {orders: {state: 'missing'}}, workers: {orders: worker}}))).not.toHaveProperty('version')
  })

  it('records which version is live', () => {
    expect(stepOf(one({}, {}, {state: 'missing'}))).not.toHaveProperty('previousVersionId')
    expect(stepOf(one({}, {}, live)).previousVersionId).toBe('version-1')
    expect(stepOf(one({}, {}, split)).previousVersionId).toBe('version-2')
  })

  it('lists an orphan and never gives it a step', () => {
    const result = plan({
      active: {orders: live},
      repositoryWorkers: ['orders'],
      state: {gone: stored('gone'), orders: stored('orders')},
      workers: {orders: bundled('orders')},
    })

    expect(result.steps.map(({worker}) => worker)).toEqual(['orders'])
    expect(result.notes).toEqual([expect.objectContaining({deployedName: 'gone-staging', kind: 'orphan', worker: 'gone'})])
  })

  it('does not call an entry an orphan when the directory is only not selected or ignored', () => {
    const result = plan({
      active: {orders: live},
      repositoryWorkers: ['ignored', 'orders'],
      state: {ignored: stored('ignored'), orders: stored('orders')},
      workers: {orders: bundled('orders')},
    })

    expect(result.notes).toEqual([])
  })

  it('treats a new deployed name as a new worker, and leaves the old name to a person', () => {
    const result = one({deployedName: 'orders-v2-staging'}, {}, {state: 'missing'})

    expect(stepOf(result).action).toBe('create')
    expect(result.notes).toEqual([expect.objectContaining({deployedName: 'orders-staging', kind: 'renamed', worker: 'orders'})])
  })

  it('does not treat a rename as a recreated provider', () => {
    const result = plan({
      active: {api: live, orders: {state: 'missing'}},
      graph: graphOf(['api', 'orders'], [['api', 'orders']]),
      state: {api: stored('api'), orders: stored('orders')},
      workers: {api: bundled('api'), orders: bundled('orders', {deployedName: 'orders-v2-staging'})},
    })

    expect(stepOf(result, 'api').action).toBe('skip')
  })

  it('is deterministic whatever order the inputs come in', () => {
    const graph = graphOf(['a', 'b'], [['a', 'b']])
    const active = {a: elsewhere(), b: elsewhere()}
    const one_ = plan({active, graph, state: {a: stored('a'), b: stored('b')}, workers: {a: bundled('a'), b: bundled('b')}})
    const two = plan({active, graph, state: {b: stored('b'), a: stored('a')}, workers: {b: bundled('b'), a: bundled('a')}})

    expect(JSON.stringify(two)).toBe(JSON.stringify(one_))
  })

  it('reads a worker named like an object property as any other', () => {
    const active: Record<string, ActiveInfo> = Object.fromEntries([['constructor', {state: 'missing'}]])

    const result = plan({active, workers: {constructor: bundled('constructor')}})

    expect(stepOf(result, 'constructor').reasons).toEqual(['new'])
  })

  it('refuses a bundle worker the graph does not know, rather than dropping it', () => {
    expect(() => plan({graph: graphOf([]), workers: {orders: bundled('orders')}})).toThrow(/not in the graph/)
  })
})

describe('needsTag', () => {
  it.each<[string, ActiveInfo, StateWorker | undefined, boolean]>([
    ['a worker that does not exist', {state: 'missing'}, undefined, false],
    ['a split rollout', split, stored('orders'), false],
    ['no entry', live, undefined, true],
    ['the version in the manifest', live, stored('orders'), false],
    ['another version', elsewhere(), stored('orders'), true],
    ['a renamed worker', live, stored('orders', {deployedName: 'old-name'}), true],
  ])('%s', (_, active, entry, expected) => {
    expect(needsTag(active, entry, 'orders-staging')).toBe(expected)
  })
})
