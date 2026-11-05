import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

import {discoverWorkers, findIgnoredWorkers, ignoredByScope, inferWorker, selectWorkers} from '../../src/project/workers.js'
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

function ignoredIn(env: string | undefined, patterns: string, workers = all): string[] {
  return findIgnoredWorkers({...options, env}, workers, memoryReader({...workerFiles, '.monocfignore': patterns}))
}

describe('findIgnoredWorkers with a scope', () => {
  it('applies an in line only in the envs it names', () => {
    expect(ignoredIn('dev', 'billing in dev,staging')).toEqual(['billing'])
    expect(ignoredIn('staging', 'billing in dev,staging')).toEqual(['billing'])
    expect(ignoredIn('production', 'billing in dev,staging')).toEqual([])
  })

  it('applies an except line everywhere but the envs it names', () => {
    expect(ignoredIn('dev', 'billing except production')).toEqual(['billing'])
    expect(ignoredIn('production', 'billing except production')).toEqual([])
    expect(ignoredIn('local', 'billing except production')).toEqual(['billing'])
  })

  it('with no env, applies an except line and no in line', () => {
    expect(ignoredIn(undefined, 'billing except production')).toEqual(['billing'])
    expect(ignoredIn(undefined, 'billing in production')).toEqual([])
    expect(ignoredIn(undefined, 'billing')).toEqual(['billing'])
  })

  it('takes spaces after commas, tabs, and a path or a glob as the pattern', () => {
    expect(ignoredIn('staging', 'billing in dev,  staging')).toEqual(['billing'])
    expect(ignoredIn('staging', 'billing\tin\tstaging')).toEqual(['billing'])
    expect(ignoredIn('dev', 'workers/orders in dev')).toEqual(['orders'])
    expect(ignoredIn('dev', '**/exp-* in dev')).toEqual(['exp-a'])
    expect(ignoredIn('dev', 'billing/ in dev')).toEqual(['billing'])
  })

  it('matches env names exactly, case included', () => {
    expect(ignoredIn('dev', 'billing in Dev')).toEqual([])
    expect(ignoredIn('Dev', 'billing in Dev')).toEqual(['billing'])
    expect(ignoredIn('dev', 'billing except Dev')).toEqual(['billing'])
    expect(ignoredIn('dev', 'billing in dev2')).toEqual([])
  })

  it('keeps ! on a scoped line, and the last match wins across scoped and unscoped lines', () => {
    expect(ignoredIn('production', 'billing\n!billing in production')).toEqual([])
    expect(ignoredIn('dev', 'billing\n!billing in production')).toEqual(['billing'])
    expect(ignoredIn('dev', 'billing in dev\n!billing')).toEqual([])
    expect(ignoredIn('dev', '!billing\nbilling in dev')).toEqual(['billing'])
    const file = 'orders\nbilling except production\n!orders in dev'
    expect(ignoredIn('dev', file)).toEqual(['billing'])
    expect(ignoredIn('staging', file)).toEqual(['billing', 'orders'])
    expect(ignoredIn('production', file)).toEqual(['orders'])
  })

  it.each(['billing except production\r\n', 'billing except production\r', 'orders in dev\r\nbilling except production\r\n'])('reads CRLF, with no env holding the line end: %j', (file) => {
    expect(ignoredIn('production', file)).not.toContain('billing')
    expect(ignoredIn('dev', file)).toContain('billing')
  })

  it('takes a whole word only: a path segment called in or except is a pattern', () => {
    const workers = ['in', 'except', 'orders']
    const found = (env: string, file: string, names = workers) => findIgnoredWorkers({...options, env}, names, memoryReader({'.monocfignore': file}))
    expect(found('dev', 'workers/in\nworkers/except\n')).toEqual(['in', 'except'])
    expect(found('dev', 'in\n')).toEqual(['in'])
    expect(found('dev', 'workers/in in production\n')).toEqual([])
    expect(found('production', 'workers/in in production\n')).toEqual(['in'])
    expect(found('dev', 'in-x\n', ['in-x', 'orders'])).toEqual(['in-x'])
  })

  it('leaves a commented-out scoped line alone', () => {
    expect(ignoredIn('dev', '# billing in\n#orders in dev,,\n')).toEqual([])
  })

  it('keeps an escaped space in the pattern, so a directory with such a name can still be written', () => {
    const reader = memoryReader({'.monocfignore': 'my\\ in\\ tray\nx\\ in\\ y in dev\n'})
    expect(findIgnoredWorkers({...options, env: 'staging'}, ['my in tray', 'x in y'], reader)).toEqual(['my in tray'])
    expect(findIgnoredWorkers({...options, env: 'dev'}, ['my in tray', 'x in y'], reader)).toEqual(['my in tray', 'x in y'])
  })

  it('keeps a word after an escaped space in the pattern, even at the end of the line', () => {
    const workers = ['a in', 'orders']
    expect(ignoredIn('dev', 'a\\ in\n', workers)).toEqual(['a in'])
    expect(ignoredIn('dev', 'a\\ in in production\n', workers)).toEqual([])
    expect(ignoredIn('production', 'a\\ in in production\n', workers)).toEqual(['a in'])
  })

  it.each([
    ['billing in', 'names no environment'],
    ['billing except', 'names no environment'],
    ['billing in   ', 'names no environment'],
    ['billing except a,,b', 'empty name'],
    ['billing in dev,', 'empty name'],
    ['billing in ,dev', 'empty name'],
    ['billing except production # a note', '"production # a note"'],
    ['billing except production#note', '"production#note"'],
    ['billing in dev staging', '"dev staging"'],
    ['billing in dev , staging', '"dev "'],
    ['billing in dev except production', '"dev except production"'],
  ])('refuses the malformed line %j, in every env and with none', (line, message) => {
    for (const env of [undefined, 'dev', 'production']) {
      expect(() => ignoredIn(env, `orders\n${line}\n`)).toThrow(message)
      expect(() => ignoredIn(env, `orders\n${line}\n`)).toThrow('.monocfignore')
    }
  })
})

const byScope = (env: string, patterns: string) => ignoredByScope({...options, env}, all, memoryReader({...workerFiles, '.monocfignore': patterns}))

describe('ignoredByScope', () => {
  it('holds what only a scope leaves out, and nothing a line with no scope leaves out', () => {
    expect(byScope('dev', 'billing\norders except production')).toEqual(['orders'])
    expect(byScope('production', 'billing\norders except production')).toEqual([])
    expect(byScope('dev', 'billing\nbilling in dev')).toEqual([])
    expect(byScope('dev', 'billing')).toEqual([])
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

  it('names the env and the way out when a named worker is ignored', () => {
    expect(() => selectWorkers(all, ['orders'], 'orders', 'dev')).toThrow('Worker orders is ignored in dev by .monocfignore. To run it in dev, change its line in that file')
    expect(() => selectWorkers(all, ['orders'], 'orders')).toThrow("Pass an env it isn't ignored in with -e, or change its line in that file")
  })

  it('fails for a named worker that is ignored, instead of doing nothing', () => {
    expect(() => selectWorkers(all, ['orders'], 'orders')).toThrow('is ignored by .monocfignore')
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
