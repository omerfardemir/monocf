import {describe, expect, it} from 'vitest'

import {actions, entry, live, manifest, planFor, three, threeEntries, threeLive} from '../helpers/plan-fixtures.js'

const missing = {state: 'missing'} as const
const allMissing = {billing: missing, gateway: missing, orders: missing}
const guards = {accountHashes: {}, accounts: [], allowRecreate: false, firstRun: false}

describe('known workers that read as missing', () => {
  it('refuse the plan when more than half of them are', () => {
    const plan = planFor(three, manifest(threeEntries), {...threeLive, billing: missing, orders: missing}, {guards})

    expect(plan.applicable).toBe(false)
    expect(plan.refused).toContain('--allow-recreate')
  })

  it('leave one in a larger set as a normal create', () => {
    const plan = planFor(three, manifest(threeEntries), {...threeLive, billing: missing}, {guards})

    expect(plan.refused).toBeUndefined()
    expect(plan.applicable).toBe(true)
    expect(actions(plan).billing).toBe('create')
  })

  it('need two the manifest knows', () => {
    const entries = {billing: entry('billing')}

    const plan = planFor(three, manifest(entries), {billing: missing, gateway: live('gateway'), orders: live('orders')}, {guards})

    expect(plan.refused).toBeUndefined()
  })

  it('count exactly half as fine', () => {
    const entries = {billing: entry('billing'), orders: entry('orders')}

    const plan = planFor(three, manifest(entries), {billing: missing, gateway: live('gateway'), orders: live('orders')}, {guards})

    expect(plan.refused).toBeUndefined()
  })

  it('go through with --allow-recreate', () => {
    const plan = planFor(three, manifest(threeEntries), allMissing, {guards: {...guards, allowRecreate: true}})

    expect(plan.refused).toBeUndefined()
    expect(plan.applicable).toBe(true)
  })
})

describe('the account marker', () => {
  const marked = {...threeEntries, orders: entry('orders', {accountHash: 'old-account'})}

  it('refuses a worker whose account changed', () => {
    const plan = planFor(three, manifest(marked), threeLive, {guards: {...guards, accountHashes: {orders: 'new-account'}}})

    expect(plan.applicable).toBe(false)
    expect(plan.refused).toContain('orders')
    expect(plan.refused).toContain('--allow-recreate')
  })

  it('goes through with --allow-recreate', () => {
    const plan = planFor(three, manifest(marked), threeLive, {guards: {...guards, accountHashes: {orders: 'new-account'}, allowRecreate: true}})

    expect(plan.refused).toBeUndefined()
  })

  it('has nothing to say when either side is unknown', () => {
    expect(planFor(three, manifest(marked), threeLive, {guards}).refused).toBeUndefined()
    expect(planFor(three, manifest(threeEntries), threeLive, {guards: {...guards, accountHashes: {orders: 'new-account'}}}).refused).toBeUndefined()
  })

  it('is fine with the same account', () => {
    expect(planFor(three, manifest(marked), threeLive, {guards: {...guards, accountHashes: {orders: 'old-account'}}}).refused).toBeUndefined()
  })
})

describe('no state, and nothing live', () => {
  it('refuses without --first-run', () => {
    const plan = planFor(three, null, allMissing, {guards})

    expect(plan.applicable).toBe(false)
    expect(plan.refused).toContain('--first-run')
  })

  it('goes through with --first-run', () => {
    const plan = planFor(three, null, allMissing, {guards: {...guards, firstRun: true}})

    expect(plan.refused).toBeUndefined()
    expect(actions(plan)).toEqual({billing: 'create', gateway: 'create', orders: 'create'})
  })

  it('does not apply when something is live', () => {
    expect(planFor(three, null, {...allMissing, orders: live('orders')}, {guards}).refused).toBeUndefined()
  })
})
