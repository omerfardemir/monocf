import {describe, expect, it} from 'vitest'

import {mergeConfig} from '../../src/config/merge.js'
import {ConfigError} from '../../src/config/types.js'

describe('mergeConfig', () => {
  it('concatenates arrays, base first, keeping duplicates', () => {
    expect(mergeConfig({flags: ['a', 'b']}, {flags: ['a', 'c']})).toEqual({flags: ['a', 'b', 'a', 'c']})
  })

  it('adds an array the base does not have', () => {
    expect(mergeConfig({}, {routes: ['x']})).toEqual({routes: ['x']})
  })

  it('merges objects recursively', () => {
    expect(mergeConfig({a: {b: 1, c: {d: 2}}}, {a: {c: {e: 3}}})).toEqual({a: {b: 1, c: {d: 2, e: 3}}})
  })

  it('lets a worker scalar win, also over an object or an array', () => {
    expect(mergeConfig({a: 1, b: {c: 1}, d: [1]}, {a: 2, b: 'x', d: false})).toEqual({a: 2, b: 'x', d: false})
  })

  it('makes an empty array or object vanish, so it cannot clear a base value', () => {
    expect(mergeConfig({crons: ['x'], kept: {a: 1}}, {assets: {}, crons: [], kept: {}, tags: []})).toEqual({
      crons: ['x'],
      kept: {a: 1},
    })
  })

  it('drops an object holding only empties, at any depth', () => {
    expect(mergeConfig({}, {a: {b: {c: {}}, d: []}})).toEqual({})
  })

  it('keeps array elements whole, including empties and null inside them', () => {
    const element = {empty: {}, list: [], nothing: null}
    expect(mergeConfig({}, {items: [element, null]})).toEqual({items: [element, null]})
  })

  it('rejects null in a worker and names its path', () => {
    expect(() => mergeConfig({}, {a: {b: null}}, 'wrangler.jsonc')).toThrow(/wrangler\.jsonc.*"a\.b" is null/)
    expect(() => mergeConfig({}, {a: null})).toThrow(ConfigError)
  })

  it('accepts null in a base and lets a worker scalar replace it', () => {
    expect(mergeConfig({a: null, b: null}, {a: 1})).toEqual({a: 1, b: null})
  })

  it.each([
    ['an array over a scalar', {a: 1}, {a: ['x']}],
    ['an array over an object', {a: {b: 1}}, {a: ['x']}],
    ['an array over null', {a: null}, {a: ['x']}],
    ['an object over a scalar', {a: 1}, {a: {b: 1}}],
    ['an object over an array', {a: ['x']}, {a: {b: 1}}],
    ['an object over null', {a: null}, {a: {b: 1}}],
  ])('rejects %s', (_name, base, worker) => {
    expect(() => mergeConfig(base, worker)).toThrow(/Can't merge "a/)
  })

  it('applies no edit for an empty value over another type', () => {
    expect(mergeConfig({a: 1, b: ['x']}, {a: [], b: {}})).toEqual({a: 1, b: ['x']})
  })

  it('changes neither input', () => {
    const base = {a: {b: [1]}}
    const worker = {a: {b: [{c: 2}]}}
    const merged = mergeConfig(base, worker) as {a: {b: {c?: number}[]}}
    merged.a.b[1].c = 9

    expect(base).toEqual({a: {b: [1]}})
    expect(worker).toEqual({a: {b: [{c: 2}]}})
  })
})
