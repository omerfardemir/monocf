import dotenv from 'dotenv'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {readLocalVars, readSecrets, requireSecretsFile, serializeDevVars} from '../../src/runtime/secrets.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true})
})

function project(files: Record<string, string>): {root: string; worker: string} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monocf-secrets-')))
  dirs.push(root)
  const worker = join(root, 'workers', 'orders')
  mkdirSync(worker, {recursive: true})
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content)
  return {root, worker}
}

describe('serializeDevVars', () => {
  it.each([
    ['a hash', 'value # not a comment'],
    ['a leading hash', '#value'],
    ['single quotes', "it's"],
    ['double quotes', 'say "hi"'],
    ['backticks', 'a`b'],
    ['all three quotes', `'a' "b" \`c\``],
    ['an equals sign', 'a=b=c'],
    ['a newline', 'line1\nline2'],
    ['a pem block', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n'],
    ['a newline and every quote', `a'b"c\`d\ne`],
    ['surrounding spaces', '  padded  '],
    ['a dollar', '$HOME and $OTHER'],
    ['a backslash', String.raw`C:\new\table`],
    ['an empty value', ''],
    ['json', '{"a":"b # c","d":[1,2]}'],
  ])('keeps %s through a real dotenv parse', (_, value) => {
    expect(dotenv.parse(serializeDevVars({KEY: value, OTHER: 'x'}))).toEqual({KEY: value, OTHER: 'x'})
  })

  it('fails rather than change a value no quoting can hold', () => {
    const value = `a'b"c\`d\\ne\n#`

    let result: string | undefined
    try {
      result = serializeDevVars({KEY: value})
    } catch (error) {
      expect(error).toMatchObject({exitCode: 2})
      expect((error as Error).message).toContain('KEY')
      expect((error as Error).message).not.toContain('a\'b')
      return
    }

    expect(dotenv.parse(result)).toEqual({KEY: value})
  })
})

describe('requireSecretsFile', () => {
  it('passes with the file in the worker, in the root, or in both', () => {
    const both = project({'.dev.vars.e': '', 'workers/orders/.dev.vars.e': ''})
    const inRoot = project({'.dev.vars.e': ''})
    const inWorker = project({'workers/orders/.dev.vars.e': ''})

    for (const {root, worker} of [both, inRoot, inWorker]) {
      expect(() => requireSecretsFile(worker, root, 'e')).not.toThrow()
    }
  })

  it('fails with neither, naming both paths', () => {
    const {root, worker} = project({'.dev.vars': '', 'workers/orders/.dev.vars': ''})

    expect(() => requireSecretsFile(worker, root, 'e')).toThrow(join(worker, '.dev.vars.e'))
    expect(() => requireSecretsFile(worker, root, 'e')).toThrow(join(root, '.dev.vars.e'))
  })

  it('without an env, the exact file is .dev.vars', () => {
    const {root, worker} = project({'.dev.vars': ''})

    expect(() => requireSecretsFile(worker, root)).not.toThrow()
  })
})

describe('readSecrets', () => {
  it('merges the exact files, with the worker winning', () => {
    const {root, worker} = project({
      '.dev.vars.e': 'A=root\nB=root',
      'workers/orders/.dev.vars.e': 'B=worker',
    })

    expect(readSecrets(worker, root, 'e')).toEqual({A: 'root', B: 'worker'})
  })

  it('never reads another file', () => {
    const {root, worker} = project({'.dev.vars': 'A=dev', '.dev.vars.other': 'A=other', 'workers/orders/.dev.vars': 'A=d'})

    expect(readSecrets(worker, root, 'e')).toEqual({})
  })
})

describe('readLocalVars', () => {
  it('falls back to .dev.vars per directory', () => {
    const {root, worker} = project({'.dev.vars': 'A=root', 'workers/orders/.dev.vars.e': 'B=worker'})

    expect(readLocalVars(worker, root, 'e')).toEqual({A: 'root', B: 'worker'})
  })

  it('prefers the exact file over .dev.vars in the same directory', () => {
    const {root, worker} = project({'workers/orders/.dev.vars': 'A=plain', 'workers/orders/.dev.vars.e': 'A=exact'})

    expect(readLocalVars(worker, root, 'e')).toEqual({A: 'exact'})
  })

  it('returns undefined with no file at all, so wrangler sees none', () => {
    const {root, worker} = project({})

    expect(readLocalVars(worker, root, 'e')).toBeUndefined()
  })
})
