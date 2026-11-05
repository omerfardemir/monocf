import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {EXIT_ENVIRONMENT, EXIT_FAILED, EXIT_USAGE} from '../../src/errors.js'
import {buildArgv, type Step} from '../../src/wrangler/argv.js'
import {locateWrangler} from '../../src/wrangler/locate.js'
import {spawnWrangler} from '../../src/wrangler/process.js'
import type {WranglerCall} from '../../src/wrangler/read.js'
import {openStateStore, parseStateUrl} from '../../src/state/store.js'
import {createFixture, type FakeCloudflare, type WranglerCall as LoggedCall} from '../helpers/harness.js'

const refuse: WranglerCall = () => {
  throw new Error('A file store must not call wrangler.')
}

describe('parseStateUrl', () => {
  it('reads a file location against the working directory', () => {
    expect(parseStateUrl('file:state', resolve('work'))).toEqual({dir: resolve('work', 'state'), kind: 'file', url: 'file:state'})
  })

  it.each([
    ['r2://monocf-state/ci/deploys', 'monocf-state', 'ci/deploys'],
    ['r2://monocf-state', 'monocf-state', ''],
    ['r2://monocf-state/', 'monocf-state', ''],
  ])('reads %s', (url, bucket, prefix) => {
    expect(parseStateUrl(url)).toEqual({bucket, kind: 'r2', prefix, url})
  })

  it.each(['s3://bucket/key', 'state', 'https://example.com/state', 'r2://', 'r2:///prefix', 'r2://-flag', 'file:', 'R2://bucket'])(
    'refuses %s as a usage error',
    (url) => {
      expect(() => parseStateUrl(url)).toThrow(expect.objectContaining({exitCode: EXIT_USAGE}))
    },
  )
})

describe('stores', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monocf-store-'))
  })

  afterEach(() => {
    rmSync(dir, {force: true, recursive: true})
  })

  function localStore() {
    return openStateStore(parseStateUrl(`file:${dir}`), refuse, dir)
  }

  describe('file', () => {
    it('says a missing key is null, and reads back what it wrote, in a nested key', async () => {
      await expect(localStore().read('staging/manifest.json')).resolves.toBeNull()

      await localStore().write('staging/runs/r1.json', '{"şehir":1}')

      await expect(localStore().read('staging/runs/r1.json')).resolves.toBe('{"şehir":1}')
    })

    it('replaces a file and leaves no temporary one behind', async () => {
      await localStore().write('staging/manifest.json', 'one')
      await localStore().write('staging/manifest.json', 'two')

      expect(readFileSync(join(dir, 'staging', 'manifest.json'), 'utf8')).toBe('two')
      expect(readdirSync(join(dir, 'staging'))).toEqual(['manifest.json'])
    })

    it('checks out for a directory that exists', async () => {
      await expect(localStore().check()).resolves.toBeUndefined()
    })

    it('fails the check for a directory that is missing, rather than reading as empty state', async () => {
      const missing = openStateStore(parseStateUrl(`file:${join(dir, 'nope')}`), refuse, dir)

      await expect(missing.check()).rejects.toMatchObject({exitCode: EXIT_ENVIRONMENT})
      expect(existsSync(join(dir, 'nope'))).toBe(false)
    })

    it('fails the check for a file in the way', async () => {
      writeFileSync(join(dir, 'file'), '')

      const blocked = openStateStore(parseStateUrl(`file:${join(dir, 'file')}`), refuse, dir)

      await expect(blocked.check()).rejects.toMatchObject({exitCode: EXIT_ENVIRONMENT})
    })

    it('describes itself as given', () => {
      expect(openStateStore(parseStateUrl('file:state'), refuse, dir).describe()).toBe('file:state')
    })
  })

  describe('r2, through the fake wrangler', () => {
    const savedEnvironment = {...process.env}
    let logPath: string
    let cloudflarePath: string
    let call: WranglerCall

    function setUp(cloudflare: FakeCloudflare): void {
      const {root} = createFixture({workers: [{name: 'orders'}]})
      const wrangler = locateWrangler(root)
      logPath = join(dir, 'calls.ndjson')
      cloudflarePath = join(dir, 'cloudflare.json')
      writeFileSync(cloudflarePath, JSON.stringify(cloudflare))
      process.env.FAKE_WRANGLER_CF = cloudflarePath
      process.env.FAKE_WRANGLER_LOG = logPath
      call = (step: Step) => spawnWrangler(wrangler, buildArgv(step), {cwd: dir, mode: 'quiet'}).done
    }

    afterEach(() => {
      process.env = {...savedEnvironment}
    })

    function calls(): LoggedCall[] {
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    }

    function store() {
      return openStateStore(parseStateUrl('r2://monocf-state/ci'), call, dir)
    }

    it('passes the check for a bucket that exists', async () => {
      setUp({buckets: {'monocf-state': {}}})

      await expect(store().check()).resolves.toBeUndefined()
      expect(calls()[0].argv).toEqual(['r2', 'bucket', 'info', 'monocf-state'])
    })

    it('fails the check for a missing bucket with exit 3, saying how to create it', async () => {
      setUp({buckets: {}})

      await expect(store().check()).rejects.toMatchObject({
        exitCode: EXIT_ENVIRONMENT,
        message: expect.stringContaining('wrangler r2 bucket create monocf-state'),
      })
    })

    it('keeps the account ID out of the message', async () => {
      setUp({buckets: {}})

      await expect(store().check()).rejects.toMatchObject({message: expect.not.stringMatching(/[0-9a-f]{32}/)})
    })

    it('says a missing key is null', async () => {
      setUp({buckets: {'monocf-state': {}}})

      await expect(store().read('staging/manifest.json')).resolves.toBeNull()
      expect(calls()[0].argv).toEqual(['r2', 'object', 'get', 'monocf-state/ci/staging/manifest.json', '--remote', '--pipe'])
    })

    it('reads back what it wrote, byte for byte, beyond the size of a pipe chunk', async () => {
      setUp({buckets: {'monocf-state': {}}})
      const body = `a${'ş'.repeat(100_000)}\n`

      await store().write('staging/manifest.json', body)

      await expect(store().read('staging/manifest.json')).resolves.toBe(body)
      const put = calls()[0]
      expect(put.argv.slice(0, 5)).toEqual(['r2', 'object', 'put', 'monocf-state/ci/staging/manifest.json', '--remote'])
      expect(put.argv.slice(-2)).toEqual(['--content-type', 'application/json'])
      expect(put.argv).toContain('--file')
      expect(readdirSync(dir).filter((name) => name.startsWith('state-'))).toEqual([])
    })

    it('reads a key with no prefix at the top of the bucket', async () => {
      setUp({buckets: {'monocf-state': {'staging/manifest.json': 'body'}}})

      const bare = openStateStore(parseStateUrl('r2://monocf-state'), call, dir)

      await expect(bare.read('staging/manifest.json')).resolves.toBe('body')
    })

    it('treats any other failure of a read as a failure, not as a missing key', async () => {
      setUp({})
      mkdirSync(join(dir, 'rules'))
      const rules = join(dir, 'rules', 'rules.json')
      writeFileSync(rules, JSON.stringify([{command: 'r2 object get', exitCode: 1, stderr: 'fetch failed\n'}]))
      process.env.FAKE_WRANGLER_RULES = rules

      await expect(store().read('staging/manifest.json')).rejects.toMatchObject({
        exitCode: EXIT_FAILED,
        message: expect.stringContaining('fetch failed'),
      })
    })

    it('fails a write that fails', async () => {
      setUp({buckets: {}})

      await expect(store().write('staging/manifest.json', 'x')).rejects.toMatchObject({exitCode: EXIT_FAILED})
      expect(readdirSync(dir).filter((name) => name.startsWith('state-'))).toEqual([])
    })
  })
})
