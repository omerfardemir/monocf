import {describe, expect, it} from 'vitest'

import {tagFor} from '../../src/plan/plan.js'
import {bundled, entry, live, manifest, planFor, three, threeEntries, threeLive, triggers} from '../helpers/plan-fixtures.js'

describe('recordState', () => {
  it('is set on an adopted worker', () => {
    const plan = planFor(three, manifest({billing: entry('billing'), gateway: entry('gateway')}), {...threeLive, orders: live('other', {tag: tagFor('f-orders')})})

    expect(plan.steps.find(({worker}) => worker === 'orders')).toMatchObject({action: 'adopt', previousVersionId: 'live-other', recordState: true})
  })

  it('is set on a step behind the state, with the active version', () => {
    const plan = planFor(three, manifest(threeEntries), {...threeLive, orders: live('other', {tag: tagFor('f-orders')})})

    expect(plan.steps.find(({worker}) => worker === 'orders')).toMatchObject({action: 'triggers', previousVersionId: 'live-other', recordState: true})
    expect(plan.notes.map(({kind}) => kind)).toEqual(['state-behind'])
  })

  it('is not set on a step that is in sync', () => {
    expect(planFor(three, manifest(threeEntries), threeLive).steps.some(({recordState}) => recordState)).toBe(false)
  })
})

describe('routes-removed', () => {
  const route = {...triggers, routes: ['example.com/*'], workersDev: false}

  it('tells a person when the last route goes', () => {
    const entries = {...threeEntries, orders: entry('orders', {triggers: route, triggersHash: 'routed'})}

    const plan = planFor({...three, orders: bundled('orders', {configHash: 'new', fingerprint: 'new'})}, manifest(entries), threeLive)

    expect(plan.notes).toEqual([{kind: 'routes-removed', message: expect.stringContaining('takes a person'), worker: 'orders'}])
  })

  it('stays quiet while a route remains', () => {
    const entries = {...threeEntries, orders: entry('orders', {triggers: route, triggersHash: 'routed'})}

    const plan = planFor({...three, orders: bundled('orders', {fingerprint: 'new', triggers: {...route, routes: ['other.example.com/*']}})}, manifest(entries), threeLive)

    expect(plan.notes).toEqual([])
  })
})
