import {describe, expect, it} from 'vitest'

import type {ManifestWorker} from '../../src/app/bundle.js'
import type {Graph} from '../../src/graph/graph.js'
import {createPlan, tagFor, type PlanOptions} from '../../src/plan/plan.js'
import type {StateManifest, StateWorker} from '../../src/state/manifest.js'
import type {ActiveInfo} from '../../src/wrangler/read.js'

const triggers = {crons: null, previewUrls: null, routes: [], workersDev: true}

function bundled(name: string, change: Partial<ManifestWorker> = {}): ManifestWorker {
  return {bundleHash: `b-${name}`, configHash: 'c', deployedName: name, doHash: 'd', externalHash: 'e', fingerprint: `f-${name}`, triggers, triggersHash: 't', ...change}
}

function entry(name: string, change: Partial<StateWorker> = {}): StateWorker {
  return {...bundled(name), commit: 'old', deployedAt: 'then', versionId: `live-${name}`, ...change} as StateWorker
}

const live = (name: string, change: object = {}): ActiveInfo => ({state: 'active', versionId: `live-${name}`, ...change})

function manifest(workers: Record<string, StateWorker>, change: Partial<StateManifest> = {}): StateManifest {
  return {env: 'dev', schemaVersion: 1, updatedAt: 'then', workers, ...change}
}

const chain: Graph = {
  edges: [
    {from: 'gateway', kind: 'services', to: 'orders', via: 'B'},
    {from: 'orders', kind: 'services', to: 'billing', via: 'B'},
  ],
  external: [],
  nodes: ['billing', 'gateway', 'orders'],
}

function planFor(
  workers: Record<string, ManifestWorker>,
  state: null | StateManifest,
  active: Record<string, ActiveInfo>,
  options: Partial<PlanOptions> = {},
  graph: Graph = chain,
) {
  return createPlan({commit: 'c', env: 'dev', workers, wrangler: '4'}, state, active, graph, {
    createdAt: 'now',
    onDrift: 'warn',
    repositoryWorkers: Object.keys(workers),
    state: 'file:state',
    ...options,
  })
}

const three = {billing: bundled('billing'), gateway: bundled('gateway'), orders: bundled('orders')}
const threeEntries = {billing: entry('billing'), gateway: entry('gateway'), orders: entry('orders')}
const threeLive = {billing: live('billing'), gateway: live('gateway'), orders: live('orders')}
const actions = (plan: {steps: {action: string; worker: string}[]}) => Object.fromEntries(plan.steps.map(({action, worker}) => [worker, action]))

describe('a version that a secret command made', () => {
  const rotated = {...threeLive, orders: live('other', {triggeredBy: 'secret'})}

  it('takes an upload with its own reason, at note level', () => {
    const plan = planFor(three, manifest(threeEntries), rotated)
    const step = plan.steps.find(({worker}) => worker === 'orders')!

    expect(step).toMatchObject({action: 'upload', reasons: ['secret-changed']})
    expect(plan.notes.map(({kind}) => kind)).toEqual(['secret-changed'])
  })

  it('is not blocked by --on-drift fail', () => {
    const plan = planFor(three, manifest(threeEntries), rotated, {onDrift: 'fail'})

    expect(plan.applicable).toBe(true)
    expect(actions(plan).orders).toBe('upload')
  })

  it('keeps the reasons of a change that came with it', () => {
    const plan = planFor({...three, orders: bundled('orders', {bundleHash: 'new', fingerprint: 'new'})}, manifest(threeEntries), rotated)

    expect(plan.steps.find(({worker}) => worker === 'orders')!.reasons).toEqual(['secret-changed', 'bundle-changed'])
  })

  it('still takes a full deploy across a Durable Object change', () => {
    const plan = planFor({...three, orders: bundled('orders', {doHash: 'new', fingerprint: 'new'})}, manifest(threeEntries), rotated)

    expect(actions(plan).orders).toBe('full-deploy')
  })

  it('stays drift when anything else made it', () => {
    const plan = planFor(three, manifest(threeEntries), {...threeLive, orders: live('other', {triggeredBy: 'upload'})}, {onDrift: 'fail'})

    expect(actions(plan).orders).toBe('blocked')
  })

  it('stays a baseline with no state entry, whose lineage is unknown', () => {
    const plan = planFor(three, manifest({billing: entry('billing'), gateway: entry('gateway')}), rotated, {onDrift: 'fail'})

    expect(actions(plan).orders).toBe('blocked')
  })

  it('does not count when the tag says what it is', () => {
    const plan = planFor(three, manifest(threeEntries), {...threeLive, orders: live('other', {tag: tagFor('f-orders'), triggeredBy: 'secret'})})

    expect(actions(plan).orders).toBe('skip')
  })
})
