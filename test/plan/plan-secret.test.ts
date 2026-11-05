import {describe, expect, it} from 'vitest'

import {tagFor} from '../../src/plan/plan.js'
import {actions, bundled, entry, live, manifest, planFor, three, threeEntries, threeLive} from '../helpers/plan-fixtures.js'

describe('a version that a secret command made', () => {
  const rotated = {...threeLive, orders: live('other', {sourceTag: tagFor('f-orders'), triggeredBy: 'secret'})}

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

  it("is drift on top of code the state doesn't name, as a manual deploy is", () => {
    const hidden = {...threeLive, orders: live('other', {sourceTag: 'monocf:f-something-else', triggeredBy: 'secret'})}
    const unknown = {...threeLive, orders: live('other', {triggeredBy: 'secret'})}

    for (const active of [hidden, unknown]) {
      const plan = planFor(three, manifest(threeEntries), active, {onDrift: 'fail'})
      expect(plan.steps.find(({worker}) => worker === 'orders')).toMatchObject({action: 'blocked', reasons: ['drift']})
      expect(plan.notes.find(({worker}) => worker === 'orders')!.message).toContain('secret command')
    }
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

    expect(actions(plan).orders).toBe('triggers')
    expect(plan.notes.map(({kind}) => kind)).toEqual(['state-behind'])
  })
})
