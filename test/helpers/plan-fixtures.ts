/* eslint-disable max-params */
import type {ManifestWorker} from '../../src/app/bundle.js'
import type {Graph} from '../../src/graph/graph.js'
import {createPlan, type Plan, type PlanOptions} from '../../src/plan/plan.js'
import type {StateManifest, StateWorker} from '../../src/state/manifest.js'
import type {ActiveInfo} from '../../src/wrangler/read.js'

export const triggers = {consumers: [], crons: null, previewUrls: null, routes: [], streamingTailConsumers: null, tailConsumers: null, workersDev: true, workflows: []}

export function bundled(name: string, change: Partial<ManifestWorker> = {}): ManifestWorker {
  return {bundleHash: `b-${name}`, configHash: 'c', deployedName: name, doHash: 'd', externalHash: 'e', fingerprint: `f-${name}`, triggers, triggersHash: 't', ...change}
}

export function entry(name: string, change: Partial<StateWorker> = {}): StateWorker {
  return {...bundled(name), commit: 'old', deployedAt: 'then', versionId: `live-${name}`, ...change} as StateWorker
}

export function live(name: string, change: object = {}): ActiveInfo {
  return {state: 'active', versionId: `live-${name}`, ...change}
}

export function manifest(workers: Record<string, StateWorker>, change: Partial<StateManifest> = {}): StateManifest {
  return {env: 'dev', schemaVersion: 1, updatedAt: 'then', workers, ...change}
}

/** gateway binds to orders, and orders to billing. */
export const chain: Graph = {
  edges: [
    {from: 'gateway', kind: 'services', to: 'orders', via: 'B'},
    {from: 'orders', kind: 'services', to: 'billing', via: 'B'},
  ],
  external: [],
  nodes: ['billing', 'gateway', 'orders'],
}

export function planFor(
  workers: Record<string, ManifestWorker>,
  state: null | StateManifest,
  active: Record<string, ActiveInfo>,
  options: Partial<PlanOptions> = {},
  graph: Graph = chain,
): Plan {
  return createPlan({commit: 'c', env: 'dev', workers, wrangler: '4'}, state, active, graph, {
    createdAt: 'now',
    onDrift: 'warn',
    repositoryWorkers: Object.keys(workers),
    state: 'file:state',
    ...options,
  })
}

export const three = {billing: bundled('billing'), gateway: bundled('gateway'), orders: bundled('orders')}
export const threeEntries = {billing: entry('billing'), gateway: entry('gateway'), orders: entry('orders')}
export const threeLive = {billing: live('billing'), gateway: live('gateway'), orders: live('orders')}

export function actions(plan: {steps: {action: string; worker: string}[]}): Record<string, string> {
  return Object.fromEntries(plan.steps.map(({action, worker}) => [worker, action]))
}
