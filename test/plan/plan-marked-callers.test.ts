import {describe, expect, it} from 'vitest'

import type {Graph} from '../../src/graph/graph.js'
import {actions, bundled, chain, entry, live, manifest, planFor, three, threeEntries, threeLive} from '../helpers/plan-fixtures.js'

const withoutOrders = {billing: three.billing, gateway: three.gateway}

describe('callers marked as needing a new version', () => {
  it('upload whatever else the table says', () => {
    const plan = planFor(three, manifest(threeEntries, {needsNewVersion: ['orders']}), threeLive)

    expect(plan.steps.find(({worker}) => worker === 'orders')).toMatchObject({action: 'upload', reasons: ['provider-recreated']})
    expect(actions(plan).gateway).toBe('skip')
  })

  it('upload when they would otherwise be adopted, with the triggers the adopt would have run', () => {
    const entries = {billing: threeEntries.billing, gateway: threeEntries.gateway}
    const adopted = {...threeLive, orders: live('other', {tag: 'monocf:f-orders'})}

    expect(actions(planFor(three, manifest(entries), adopted)).orders).toBe('adopt')
    const plan = planFor(three, manifest(entries, {needsNewVersion: ['orders']}), adopted)

    expect(plan.steps.find(({worker}) => worker === 'orders')).toMatchObject({action: 'upload', reasons: ['provider-recreated'], triggersChanged: true})
  })

  it('are left alone when they are gone from the repository, which the orphan note covers', () => {
    const plan = planFor(withoutOrders, manifest(threeEntries, {needsNewVersion: ['orders']}), threeLive, {repositoryWorkers: ['billing', 'gateway']})

    expect(plan.notes.map(({kind, worker}) => [kind, worker])).toEqual([['orphan', 'orders']])
  })

  it('keep an action that already makes a new version', () => {
    const fullDeploy = {...three, orders: bundled('orders', {doHash: 'new', fingerprint: 'new'})}

    expect(actions(planFor(fullDeploy, manifest(threeEntries, {needsNewVersion: ['orders']}), threeLive)).orders).toBe('full-deploy')
  })

  it('stay blocked when drift blocks them', () => {
    const plan = planFor(three, manifest(threeEntries, {needsNewVersion: ['orders']}), {...threeLive, orders: live('other')}, {onDrift: 'fail'})

    expect(actions(plan).orders).toBe('blocked')
  })

  it('get a note when they are not selected', () => {

    const plan = planFor(withoutOrders, manifest(threeEntries, {needsNewVersion: ['orders']}), threeLive, {repositoryWorkers: ['billing', 'gateway', 'orders']})

    expect(plan.notes).toEqual([{kind: 'caller-not-selected', message: expect.stringContaining('needs a new version'), worker: 'orders'}])
  })

  it('in .monocfignore are never touched, and a note names them', () => {

    const plan = planFor(withoutOrders, manifest(threeEntries, {needsNewVersion: ['orders']}), threeLive, {
      ignored: {graph: chain, workers: ['orders']},
      repositoryWorkers: ['billing', 'gateway', 'orders'],
    })

    expect(plan.steps.map(({worker}) => worker)).not.toContain('orders')
    expect(plan.notes).toEqual([{kind: 'caller-ignored', message: expect.stringContaining('.monocfignore'), worker: 'orders'}])
  })
})

describe('a create of a worker the manifest knows', () => {
  const gone = {...threeLive, billing: {state: 'missing'} as const}

  it('says which callers to mark first', () => {
    const plan = planFor(three, manifest(threeEntries), gone)

    expect(plan.steps.find(({worker}) => worker === 'billing')).toMatchObject({action: 'create', markCallers: ['orders']})
  })

  it('marks no caller for a worker the manifest does not know', () => {
    const entries = {gateway: entry('gateway'), orders: entry('orders')}

    expect(planFor(three, manifest(entries), gone).steps.find(({worker}) => worker === 'billing')!.markCallers).toBeUndefined()
  })

  it('names a caller in .monocfignore in a note', () => {
    const graph: Graph = {...chain, nodes: ['billing', 'gateway']}

    const plan = planFor(withoutOrders, manifest(threeEntries), gone, {ignored: {graph: chain, workers: ['orders']}, repositoryWorkers: ['billing', 'gateway', 'orders']}, {...graph, edges: []})

    const notes = plan.notes.filter(({kind}) => kind === 'caller-ignored')
    expect(notes).toEqual([{kind: 'caller-ignored', message: expect.stringContaining('billing'), worker: 'orders'}])
  })
})
