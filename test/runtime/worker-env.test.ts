/* eslint-disable no-template-curly-in-string */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {envFileNames, readWorkerEnvironment} from '../../src/runtime/worker-env.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true})
})

function worker(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'monocf-env-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

describe('envFileNames', () => {
  it('names the files wrangler loads', () => {
    expect(envFileNames()).toEqual(['.env', '.env.local'])
    expect(envFileNames('staging')).toEqual(['.env', '.env.local', '.env.staging', '.env.staging.local'])
  })
})

describe('readWorkerEnvironment', () => {
  it('has nothing to add without a file', () => {
    expect(readWorkerEnvironment(worker({}), 'staging', {})).toEqual({})
  })

  it('takes the later file, up to the local one of the env', () => {
    const dir = worker({
      '.env': 'A=base\nB=base\nC=base\nD=base\n',
      '.env.local': 'B=local\nC=local\nD=local\n',
      '.env.staging': 'C=env\nD=env\n',
      '.env.staging.local': 'D=env-local\n',
    })

    expect(readWorkerEnvironment(dir, 'staging', {})).toEqual({A: 'base', B: 'local', C: 'env', D: 'env-local'})
  })

  it('reads no file of another env, and no env file without an env', () => {
    const dir = worker({'.env.production': 'A=other\n', '.env.staging': 'B=this\n'})

    expect(readWorkerEnvironment(dir, 'staging', {})).toEqual({B: 'this'})
    expect(readWorkerEnvironment(dir, undefined, {})).toEqual({})
  })

  it('lets the real environment win', () => {
    expect(readWorkerEnvironment(worker({'.env': 'A=file\nB=file\n'}), undefined, {A: 'real'})).toEqual({A: 'real', B: 'file'})
  })

  it('takes the file over a real variable that is empty, as wrangler does', () => {
    expect(readWorkerEnvironment(worker({'.env': 'A=file\n'}), undefined, {A: ''})).toEqual({A: 'file'})
  })

  it('expands references the way wrangler does', () => {
    const dir = worker({
      '.env': [
        'FIRST=one',
        'SECOND=$FIRST-two',
        'BRACED=${FIRST}x',
        'FROM_REAL=$REAL',
        'UNKNOWN=[$NOPE]',
        'DEFAULTED=${NOPE:-fallback}',
        'ALTERNATE=${FIRST:+other}',
        String.raw`ESCAPED=\$FIRST`,
        "SINGLE='$FIRST'",
      ].join('\n'),
    })

    expect(readWorkerEnvironment(dir, undefined, {REAL: 'from-the-environment'})).toEqual({
      ALTERNATE: 'other',
      BRACED: 'onex',
      DEFAULTED: 'fallback',
      ESCAPED: '$FIRST',
      FIRST: 'one',
      FROM_REAL: 'from-the-environment',
      SECOND: 'one-two',
      SINGLE: 'one',
      UNKNOWN: '[]',
    })
  })

  it('ends on references that go round', () => {
    const dir = worker({'.env': 'A=$B\nB=$A\nC=$C\n'})

    expect(readWorkerEnvironment(dir, undefined, {})).toEqual({A: '', B: '', C: ''})
  })

  it('skips what it cannot read, as wrangler does', () => {
    const dir = worker({})
    mkdirSync(join(dir, '.env'))

    expect(readWorkerEnvironment(dir, undefined, {})).toEqual({})
  })
})
