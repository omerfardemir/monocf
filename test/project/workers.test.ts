import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

import {discoverWorkers, findIgnoredWorkers, inferWorker, selectWorkers} from '../../src/project/workers.js'
import {memoryReader, projectRoot} from '../helpers/memory-reader.js'

const options = {rootDir: projectRoot, workersDirName: 'workers'}
const workerFiles = {
  'workers/billing/wrangler.jsonc': {},
  'workers/exp-a/wrangler.jsonc': {},
  'workers/orders/wrangler.jsonc': {},
}
const all = ['billing', 'exp-a', 'orders']

describe('discoverWorkers', () => {
  it('lists directories with a wrangler config, sorted', () => {
    const reader = memoryReader({
      'workers/orders/wrangler.jsonc': {},
      'workers/billing/wrangler.jsonc': {},
      'workers/no-config/package.json': {},
      'workers/README.md': 'text',
    })
    expect(discoverWorkers(options, reader)).toEqual(['billing', 'orders'])
  })

  it('reports a missing workers directory', () => {
    expect(() => discoverWorkers(options, memoryReader({'a.json': {}}))).toThrow('Workers directory not found')
  })

  it('supports workers directly under the root', () => {
    const reader = memoryReader({'orders/wrangler.jsonc': {}})
    expect(discoverWorkers({rootDir: projectRoot, workersDirName: ''}, reader)).toEqual(['orders'])
  })
})

function ignored(patterns: string, location = options): string[] {
  return findIgnoredWorkers(location, all, memoryReader({...workerFiles, '.monocfignore': patterns}))
}

describe('findIgnoredWorkers', () => {
  it('returns nothing with no ignore file', () => {
    expect(findIgnoredWorkers(options, all, memoryReader(workerFiles))).toEqual([])
  })

  it('matches a name, a path from the root and a glob', () => {
    expect(ignored('billing')).toEqual(['billing'])
    expect(ignored('workers/orders')).toEqual(['orders'])
    expect(ignored('**/exp-*')).toEqual(['exp-a'])
  })

  it('matches a line with a trailing slash, which means a directory', () => {
    expect(ignored('billing/')).toEqual(['billing'])
    expect(ignored('workers/orders/')).toEqual(['orders'])
  })

  it('skips comments and blank lines', () => {
    expect(ignored('# billing\n\norders\n')).toEqual(['orders'])
  })

  it('works when workers sit directly under the root', () => {
    expect(ignored('orders', {rootDir: projectRoot, workersDirName: ''})).toEqual(['orders'])
  })

  it('handles a workers directory written with ./', () => {
    expect(ignored('workers/orders', {rootDir: projectRoot, workersDirName: './workers'})).toEqual(['orders'])
  })
})

describe('selectWorkers', () => {
  it('removes ignored workers from a bulk selection', () => {
    expect(selectWorkers(all, ['exp-a'])).toEqual(['billing', 'orders'])
  })

  it('fails when a bulk selection ends up empty', () => {
    expect(() => selectWorkers(['orders'], ['orders'])).toThrow('No workers found')
  })

  it('returns a named worker', () => {
    expect(selectWorkers(all, [], 'orders')).toEqual(['orders'])
  })

  it('fails for a named worker that does not exist', () => {
    expect(() => selectWorkers(all, [], 'ghost')).toThrow('Worker not found: ghost')
  })

  it('fails for a named worker that is ignored, instead of doing nothing', () => {
    expect(() => selectWorkers(all, ['orders'], 'orders')).toThrow('listed in .monocfignore')
  })
})

describe('inferWorker', () => {
  const location = {rootDir: resolve('/repo'), workersDirName: 'workers'}

  it('finds the worker from its own directory and from below it', () => {
    expect(inferWorker(location, resolve('/repo', 'workers', 'orders'))).toBe('orders')
    expect(inferWorker(location, resolve('/repo', 'workers', 'orders', 'src', 'lib'))).toBe('orders')
  })

  it.each([
    ['the workers directory', resolve('/repo', 'workers')],
    ['the root', resolve('/repo')],
    ['outside the project', resolve('/elsewhere', 'workers', 'orders')],
    ['a sibling that starts with the same name', resolve('/repo', 'workers-old', 'orders')],
  ])('finds none in %s', (_, cwd) => {
    expect(inferWorker(location, cwd)).toBeUndefined()
  })

  it('finds none when workers sit directly under the root', () => {
    expect(inferWorker({rootDir: resolve('/repo'), workersDirName: ''}, resolve('/repo', 'orders'))).toBeUndefined()
  })
})
