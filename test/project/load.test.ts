import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {findConfigFile, loadProjectFile, parseJsonc, parseProjectFile} from '../../src/project/load.js'
import {memoryReader, projectRoot} from '../helpers/memory-reader.js'

describe('findConfigFile', () => {
  it('searches up from a nested directory', () => {
    const reader = memoryReader({'monocf.config.json': {}, 'workers/orders/wrangler.jsonc': {}})
    expect(findConfigFile(join(projectRoot, 'workers', 'orders'), reader)).toBe(join(projectRoot, 'monocf.config.json'))
  })

  it('returns undefined when there is none', () => {
    expect(findConfigFile(projectRoot, memoryReader({'a.json': {}}))).toBeUndefined()
  })
})

describe('parseProjectFile', () => {
  it('accepts comments and trailing commas', () => {
    expect(parseProjectFile('{\n// comment\n"workersDirName": "workers",\n}', 'f')).toEqual({workersDirName: 'workers'})
  })

  it('reads through the given reader', () => {
    const reader = memoryReader({'monocf.config.json': {minify: true}})
    expect(loadProjectFile(join(projectRoot, 'monocf.config.json'), reader)).toEqual({minify: true})
  })

  it('names the file on a syntax error', () => {
    expect(() => parseProjectFile('{"a": ', 'monocf.config.json')).toThrow(/monocf\.config\.json.*Invalid JSON/)
  })

  it('rejects a non-object', () => {
    expect(() => parseProjectFile('[]', 'f')).toThrow('must be an object')
  })

  it('rejects an unknown key, so a typo cannot silently disable something', () => {
    expect(() => parseProjectFile('{"deployBinding": true}', 'f')).toThrow('Unknown key "deployBinding"')
  })

  it.each([
    ['port', '"8787"'],
    ['minify', '"yes"'],
    ['rootDir', '1'],
    ['variables', '[]'],
  ])('rejects the wrong type for %s', (key, value) => {
    expect(() => parseProjectFile(`{"${key}": ${value}}`, 'f')).toThrow(`"${key}" must be of type`)
  })

  it('rejects a variable that cannot become text', () => {
    expect(() => parseProjectFile('{"variables": {"a": {}}}', 'f')).toThrow('"variables.a" must be')
  })
})

describe('parseJsonc', () => {
  it('rejects text that wrangler would also reject', () => {
    expect(() => parseJsonc('{"a": 1 "b": 2}', 'f')).toThrow('Invalid JSON')
  })
})
