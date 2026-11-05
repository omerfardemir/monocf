import {describe, expect, it} from 'vitest'

import {deployLevels, formatMarkdown, formatSummary} from '../../src/plan/format.js'
import type {Plan, PlanStep} from '../../src/plan/plan.js'

function step(worker: string, action: PlanStep['action'], overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    action,
    bundleHash: 'hash-of-bundle',
    callers: [],
    configHash: 'hash-of-config',
    dependsOn: [],
    deployedName: `${worker}-staging`,
    doHash: 'hash-of-do',
    explicitEmptyCrons: false,
    externalHash: 'hash-of-external',
    fingerprint: 'hash-of-all',
    previousVersionId: 'version-id-of-worker',
    reasons: action === 'skip' ? ['unchanged'] : ['bundle-changed'],
    transitiveCallers: [],
    triggers: {consumers: [], crons: null, previewUrls: null, routes: [], streamingTailConsumers: null, tailConsumers: null, workersDev: true, workflows: []},
    triggersChanged: false,
    triggersHash: 'hash-of-triggers',
    worker,
    ...overrides,
  }
}

function planOf(steps: PlanStep[], overrides: Partial<Plan> = {}): Plan {
  return {
    applicable: true,
    commit: 'abc123',
    createdAt: '2026-02-02T00:00:00.000Z',
    env: 'staging',
    notes: [],
    schemaVersion: 1,
    state: 'file:state',
    steps,
    wrangler: '4.151.1',
    ...overrides,
  }
}

const steps = [
  step('billing', 'skip'),
  step('orders', 'upload', {transitiveCallers: ['gateway', 'web']}),
  step('web', 'upload', {dependsOn: ['orders'], transitiveCallers: []}),
]

describe('deployLevels', () => {
  it('groups what can run together, leaving out what does not deploy', () => {
    expect(deployLevels(planOf(steps))).toEqual([['orders'], ['web']])
  })

  it('still ends when a step waits for one that is blocked', () => {
    const blocked = [step('a', 'blocked'), step('b', 'upload', {dependsOn: ['a']})]
    expect(deployLevels(planOf(blocked, {applicable: false}))).toEqual([['b']])
  })
})

describe('formatMarkdown', () => {
  const notes: Plan['notes'] = [
    {kind: 'drift', message: 'A split rollout is live.', worker: 'orders'},
    {deployedName: 'old-staging', kind: 'orphan', message: 'Gone from the repository.', worker: 'old'},
  ]

  it('counts actions, tables what deploys, and names callers and drift', () => {
    const text = formatMarkdown(planOf(steps, {notes}))

    expect(text).toContain('| skip | 1 |')
    expect(text).toContain('| upload | 2 |')
    expect(text).toContain('| orders | upload | bundle-changed |')
    expect(text).not.toContain('| billing |')
    expect(text).toContain('`gateway`')
    expect(text).toContain('### Drift warnings')
    expect(text).toContain('drift: orders: A split rollout is live.')
    expect(text).toContain('orphan: old (old-staging)')
  })

  it('counts a worker it only adopts, without listing it as a deploy', () => {
    const text = formatMarkdown(planOf([step('orders', 'adopt', {reasons: ['state-missing']})]))

    expect(text).toContain('| adopt | 1 |')
    expect(text).not.toContain('Workers to deploy')
  })

  it('does not list a caller that deploys anyway as something to check', () => {
    const text = formatMarkdown(planOf([step('a', 'upload', {transitiveCallers: ['b']}), step('b', 'upload')]))

    expect(text).not.toContain('Callers to check')
  })

  it('holds names and no hash or version ID', () => {
    const text = formatMarkdown(planOf(steps, {notes}))

    expect(text).not.toMatch(/hash-of|version-id-of/)
  })

  it('says when the plan can not be applied', () => {
    const text = formatMarkdown(planOf([step('orders', 'blocked', {reasons: ['drift']})], {applicable: false}))

    expect(text).toContain("**Blocked: this plan can't be applied.**")
    expect(text).toContain('| orders | blocked | drift |')
  })
})

describe('formatSummary', () => {
  it('gives counts, what changes, and the order', () => {
    const text = formatSummary(planOf(steps))

    expect(text).toContain('Plan for staging at abc123: 2 upload, 1 skip.')
    expect(text).toContain('  orders: upload (bundle-changed)')
    expect(text).not.toContain('billing')
    expect(text).toContain('  1. orders\n  2. web\n')
    expect(text).toContain('Callers to check: gateway')
  })

  it('warns about drift, and says when the plan can not be applied', () => {
    const notes: Plan['notes'] = [{kind: 'drift', message: 'A split rollout is live.', worker: 'orders'}]
    const text = formatSummary(planOf([step('orders', 'blocked')], {applicable: false, notes}))

    expect(text).toContain('warning drift: orders')
    expect(text).toContain("Blocked: this plan can't be applied")
  })
})
