import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {compareVersions, locateWrangler, nodeFloor} from '../../src/wrangler/locate.js'
import {parseOutput} from '../../src/wrangler/output.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true})
})

function project(packageJson: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monocf-locate-')))
  dirs.push(root)
  const dir = join(root, 'node_modules', 'wrangler')
  mkdirSync(join(dir, 'wrangler-dist'), {recursive: true})
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name: 'wrangler', ...packageJson}))
  writeFileSync(join(dir, 'wrangler-dist', 'cli.js'), '')
  return root
}

describe('compareVersions', () => {
  it.each([
    ['4.151.0', '4.151.0', 0],
    ['4.151.1', '4.151.0', 1],
    ['4.150.9', '4.151.0', -1],
    ['5.0.0', '4.151.0', 1],
    ['4.200.0-beta.1', '4.151.0', 1],
  ])('%s against %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b)!)).toBe(sign)
  })

  it('returns undefined for something that is not a version', () => {
    expect(compareVersions('latest', '4.151.0')).toBeUndefined()
  })
})

describe('nodeFloor', () => {
  it.each([
    ['>=22.0.0', '22.0.0'],
    ['>= 22', '22.0.0'],
    ['>=22.1', '22.1.0'],
  ])('reads %s', (engines, floor) => {
    expect(nodeFloor(engines)).toBe(floor)
  })

  it.each(['^22.0.0', '22 || 24', undefined, 22])('has none for %s', (engines) => {
    expect(nodeFloor(engines)).toBeUndefined()
  })
})

describe('locateWrangler', () => {
  it('finds the entry and the version from the project root', () => {
    const root = project({engines: {node: '>=22.0.0'}, version: '4.151.1'})

    const wrangler = locateWrangler(root, '22.0.0')

    expect(wrangler.version).toBe('4.151.1')
    expect(wrangler.cli).toBe(join(root, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js'))
  })

  it('takes exactly the version floor', () => {
    expect(locateWrangler(project({version: '4.151.0'})).version).toBe('4.151.0')
  })

  it('exits 3 below the Node floor', () => {
    const root = project({engines: {node: '>=22.0.0'}, version: '4.151.0'})

    expect(() => locateWrangler(root, '20.19.0')).toThrow(expect.objectContaining({exitCode: 3}))
  })

  it('exits 3 below the version floor', () => {
    expect(() => locateWrangler(project({version: '4.150.9'}))).toThrow(expect.objectContaining({exitCode: 3}))
  })

  it('exits 3 when the project has none', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'monocf-locate-')))
    dirs.push(root)

    expect(() => locateWrangler(root)).toThrow(expect.objectContaining({exitCode: 3}))
  })
})

describe('parseOutput', () => {
  it('reads the version ID of a deploy and of an upload', () => {
    expect(parseOutput('{"type":"deploy","version_id":"a"}\n').versionId).toBe('a')
    expect(parseOutput('{"type":"version-upload","version_id":"b"}\n').versionId).toBe('b')
  })

  it('takes no version ID from any other entry', () => {
    expect(parseOutput('{"type":"wrangler-session","version_id":"a"}\n').versionId).toBeUndefined()
  })

  it('reads a failure', () => {
    const output = parseOutput('{"type":"command-failed","code":10007,"message":"nope"}\n')

    expect(output.failure).toEqual({code: 10_007, message: 'nope'})
  })

  it('leaves out fields of the wrong type', () => {
    expect(parseOutput('{"type":"command-failed","code":"x"}\n').failure).toEqual({})
  })

  it('skips lines that are not JSON objects', () => {
    const output = parseOutput('oops\n\n7\n{"type":"deploy","version_id":"a"}\n{"type":"dep')

    expect(output.entries).toHaveLength(1)
    expect(output.versionId).toBe('a')
  })
})
