import {describe, expect, it} from 'vitest'

import type {ProjectInputs, ResolvedProject} from '../../src/config/resolve.js'
import {ConfigError} from '../../src/config/types.js'
import {
  validateEnv,
  validateList,
  validateName,
  validateSelection,
  validateTargetName,
} from '../../src/config/validate.js'
import type {Options} from '../../src/project/options.js'

describe('validateEnv', () => {
  it('accepts an env from the base or the worker, even an empty one', () => {
    expect(() => validateEnv('a', {base: {env: {x: {}}}, worker: {}}, 'x')).not.toThrow()
    expect(() => validateEnv('a', {worker: {env: {x: {}}}}, 'x')).not.toThrow()
  })

  it('accepts no env at all', () => {
    expect(() => validateEnv('a', {worker: {}})).not.toThrow()
  })

  it('rejects an env neither defines, so a typo cannot create a worker', () => {
    expect(() => validateEnv('a', {base: {env: {staging: {}}}, worker: {}}, 'stagin')).toThrow(
      'Unknown environment "stagin" for worker a',
    )
  })

  it('does not mistake an inherited object key for an env', () => {
    expect(() => validateEnv('a', {worker: {env: {}}}, 'constructor')).toThrow('Unknown environment')
  })
})

describe('validateName', () => {
  it('returns a string name', () => {
    expect(validateName({name: 'x'}, 'f')).toBe('x')
  })

  it.each([[undefined], [''], [1], [null]])('rejects %s and names the file', (name) => {
    expect(() => validateName({name}, 'file.jsonc')).toThrow(/file\.jsonc.*no name/)
  })
})

describe('validateList', () => {
  it('treats a missing field as empty', () => {
    expect(validateList({}, 'services', 'f')).toEqual([])
  })

  it('returns a list of objects', () => {
    expect(validateList({services: [{a: 1}]}, 'services', 'f')).toEqual([{a: 1}])
  })

  it.each([[{}], ['x'], [['x']], [[null]]])('rejects %j', (services) => {
    expect(() => validateList({services}, 'services', 'f')).toThrow('must be a list of objects')
  })
})

describe('validateTargetName', () => {
  it('returns a string or undefined', () => {
    expect(validateTargetName({service: 'x'}, 'service', 'f')).toBe('x')
    expect(validateTargetName({}, 'service', 'f')).toBeUndefined()
  })

  it('rejects anything else', () => {
    expect(() => validateTargetName({service: 1}, 'service', 'f')).toThrow('must be a string')
  })
})

describe('validateSelection', () => {
  const inputs: ProjectInputs = {
    failures: [],
    workers: [
      {config: {env: {staging: {}}}, configPath: 'c', dir: 'orders', path: 'p'},
      {config: {}, configPath: 'c', dir: 'billing', path: 'p'},
    ],
  }
  const error = new ConfigError('broken')
  const project: ResolvedProject = {failures: [{dir: 'bad', error}], notices: [], workers: []}
  const options = {env: 'staging'} as Options

  it('accepts a selection that defines the env, whatever fails outside it', () => {
    expect(() => validateSelection(['orders'], options, inputs, project)).not.toThrow()
  })

  it('rejects a selected worker without the env', () => {
    expect(() => validateSelection(['orders', 'billing'], options, inputs, project)).toThrow('Unknown environment')
  })

  it('throws the failure of a selected worker', () => {
    expect(() => validateSelection(['bad'], options, inputs, project)).toThrow(error)
  })
})
