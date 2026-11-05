import {join, resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

import {resolveOptions} from '../../src/project/options.js'
import {memoryReader, projectRoot} from '../helpers/memory-reader.js'

const configPath = join(projectRoot, 'monocf.config.json')
const reader = memoryReader({})

describe('resolveOptions', () => {
  it('uses defaults with no file and no flags', () => {
    expect(resolveOptions({cwd: projectRoot, reader})).toMatchObject({
      all: false,
      baseConfigPath: undefined,
      deployBindings: false,
      deploySecrets: false,
      minify: false,
      port: 8787,
      rootDir: projectRoot,
      variables: {},
      workersDirName: '',
    })
  })

  it('honours flags with no file, which the old flow ignored', () => {
    const options = resolveOptions({cwd: projectRoot, flags: {all: true, env: 'staging', port: 1}, reader})
    expect(options).toMatchObject({all: true, env: 'staging', port: 1})
  })

  it('lets the file beat defaults', () => {
    const file = {deployBindings: true, minify: true, port: 2, workersDirName: 'workers'}
    expect(resolveOptions({configPath, cwd: projectRoot, file, reader})).toMatchObject(file)
  })

  it('lets flags beat the file', () => {
    const file = {port: 2, workersDirName: 'workers'}
    const flags = {port: 3, workersDirName: 'services'}
    expect(resolveOptions({configPath, cwd: projectRoot, file, flags, reader})).toMatchObject(flags)
  })

  it.each(['deployBindings', 'deploySecrets', 'minify'] as const)('lets a false %s flag beat the file', (key) => {
    const options = resolveOptions({configPath, cwd: projectRoot, file: {[key]: true}, flags: {[key]: false}, reader})
    expect(options[key]).toBe(false)
  })

  it('anchors the file rootDir at the config file, not the cwd', () => {
    const cwd = join(projectRoot, 'workers', 'orders')
    const options = resolveOptions({configPath, cwd, file: {rootDir: './sub'}, reader})
    expect(options.rootDir).toBe(join(projectRoot, 'sub'))
  })

  it('anchors a rootDir flag at the cwd', () => {
    const options = resolveOptions({configPath, cwd: projectRoot, file: {rootDir: 'a'}, flags: {rootDir: 'b'}, reader})
    expect(options.rootDir).toBe(join(projectRoot, 'b'))
  })

  it('finds the default base config when it exists', () => {
    const withBase = memoryReader({'base.wrangler.jsonc': {}})
    expect(resolveOptions({cwd: projectRoot, reader: withBase}).baseConfigPath).toBe(
      join(projectRoot, 'base.wrangler.jsonc'),
    )
  })

  it('prefers a named base config', () => {
    const withBase = memoryReader({'base.wrangler.jsonc': {}})
    const options = resolveOptions({cwd: projectRoot, file: {baseConfig: 'other.jsonc'}, reader: withBase})
    expect(options.baseConfigPath).toBe(join(projectRoot, 'other.jsonc'))
  })

  it.each(['', '   '])('treats a base config of %j in the file as unset, so it uses the default (F2)', (baseConfig) => {
    const withBase = memoryReader({'base.wrangler.jsonc': {}})
    const options = resolveOptions({cwd: projectRoot, file: {baseConfig}, reader: withBase})
    expect(options.baseConfigPath).toBe(join(projectRoot, 'base.wrangler.jsonc'))
  })

  it('has no base when the file value is empty and no default exists (F2)', () => {
    expect(resolveOptions({cwd: projectRoot, file: {baseConfig: ''}, reader}).baseConfigPath).toBeUndefined()
  })

  it('anchors a rootDir flag at the cwd, not at the config directory (F8)', () => {
    const cwd = resolve('/repo', 'workers', 'orders')
    const options = resolveOptions({configPath: resolve('/repo', 'monocf.config.json'), cwd, flags: {rootDir: '..'}, reader})
    expect(options.rootDir).toBe(resolve('/repo', 'workers'))
  })

  it('turns variables into text', () => {
    const file = {variables: {flag: true, number: 1, text: 'x'}}
    expect(resolveOptions({cwd: projectRoot, file, reader}).variables).toEqual({flag: 'true', number: '1', text: 'x'})
  })
})

describe('blank values', () => {
  it.each([
    ['env', '--env'],
    ['message', '--message'],
    ['deployFromVersionId', '--deploy-from-version-id'],
    ['rootDir', '--root-dir'],
    ['workersDirName', '--workers-dir-name'],
    ['baseConfig', '--base-config'],
  ])('rejects an empty %s', (key, flag) => {
    const sources = {cwd: resolve('/repo'), flags: {[key]: ''}}

    expect(() => resolveOptions(sources)).toThrow(`${flag} must not be empty`)
    expect(() => resolveOptions({...sources, flags: {[key]: '   '}})).toThrow(`${flag} must not be empty`)
  })

  it('reports it as a usage error', () => {
    expect(() => resolveOptions({cwd: resolve('/repo'), flags: {env: ''}})).toThrow(expect.objectContaining({exitCode: 2}))
  })
})

describe('a relative root', () => {
  it('comes from the flag against the working directory', () => {
    const options = resolveOptions({cwd: resolve('/repo', 'workers', 'orders'), flags: {rootDir: '../..'}})

    expect(options.rootDir).toBe(resolve('/repo'))
  })

  it('comes from the file against the file, not the working directory', () => {
    const options = resolveOptions({
      configPath: resolve('/repo', 'monocf.config.json'),
      cwd: resolve('/repo', 'workers', 'orders'),
      file: {rootDir: './'},
    })

    expect(options.rootDir).toBe(resolve('/repo'))
  })
})
