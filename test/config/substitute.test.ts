import {describe, expect, it} from 'vitest'

import {findUnknownPlaceholders, substituteConfig} from '../../src/config/substitute.js'

describe('substituteConfig', () => {
  it('replaces every occurrence in strings, at any depth', () => {
    expect(substituteConfig({a: '{v}-{v}', b: [{c: 'x{v}'}]}, {v: '1'})).toEqual({a: '1-1', b: [{c: 'x1'}]})
  })

  it('replaces in object keys too', () => {
    expect(substituteConfig({'key-{v}': {'{v}': 'x'}}, {v: '1'})).toEqual({'key-1': {'1': 'x'}})
  })

  it('leaves other types alone', () => {
    const config = {a: 1, b: true, c: null}
    expect(substituteConfig(config, {v: '1'})).toEqual(config)
  })

  it('applies variables in order, so an earlier one can expand into a later one', () => {
    expect(substituteConfig({a: '{first}'}, {first: '{second}', second: 'x'})).toEqual({a: 'x'})
  })

  it('does not expand a later variable into an earlier one', () => {
    expect(substituteConfig({a: '{second}'}, {first: 'x', second: '{first}'})).toEqual({a: '{first}'})
  })

  it('keeps a value with quotes and backslashes intact', () => {
    const value = String.raw`C:\tmp "quoted"`
    expect(substituteConfig({a: '{v}'}, {v: value})).toEqual({a: value})
  })

  it('does not change its input', () => {
    const config = {a: '{v}'}
    substituteConfig(config, {v: '1'})
    expect(config).toEqual({a: '{v}'})
  })
})

describe('findUnknownPlaceholders', () => {
  it('finds them in values and keys, sorted and once each', () => {
    expect(findUnknownPlaceholders({'{b}': '{a}', c: ['{a}']}, [])).toEqual(['{a}', '{b}'])
  })

  it('accepts names with dots and dashes', () => {
    expect(findUnknownPlaceholders({a: '{my-var} {my.var}'}, [])).toEqual(['{my-var}', '{my.var}'])
  })

  it.each([String.raw`^\d{3}$`, '{"json": true}', '{}', '{ spaced }', 'a{1,2}'])('does not treat %s as one', (text) => {
    expect(findUnknownPlaceholders({a: text}, [])).toEqual([])
  })

  it('skips a known key, which is how a variable mapped to itself keeps literal braces', () => {
    const config = substituteConfig({a: '/users/{id}'}, {id: '{id}'})
    expect(config).toEqual({a: '/users/{id}'})
    expect(findUnknownPlaceholders(config, ['id'])).toEqual([])
  })
})
