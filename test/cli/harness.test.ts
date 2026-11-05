import {spawn} from 'node:child_process'
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createFixture, runCli} from '../helpers/harness.js'

describe('test harness', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps credentials and the home directory of the developer away from the child', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'real-token')
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'real-account')
    vi.stubEnv('CLOUDFLARE_API_KEY', 'real-key')
    vi.stubEnv('CF_API_TOKEN', 'real-legacy-token')
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const {
      calls: [{environment}],
    } = await runCli(fixture, ['whoami'])

    expect(environment.CLOUDFLARE_API_TOKEN).toBe('dummy-token-for-tests')
    expect(environment.CLOUDFLARE_ACCOUNT_ID).toBe('00000000000000000000000000000000')
    expect(environment.CLOUDFLARE_API_BASE_URL).toContain('127.0.0.1')
    expect(environment).not.toHaveProperty('CLOUDFLARE_API_KEY')
    expect(environment).not.toHaveProperty('CF_API_TOKEN')
    for (const name of ['HOME', 'USERPROFILE', 'WRANGLER_HOME', 'XDG_CONFIG_HOME']) {
      expect(environment[name]).toContain('monocf-test-')
    }
  })

  it('fails a run that logged no call, unless the test expects none', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    await expect(runCli(fixture, ['--version'])).rejects.toThrow('made no fake wrangler call')
    await expect(runCli(fixture, ['--version'], {noCalls: true})).resolves.toMatchObject({calls: [], exitCode: 0})
  })
})

describe('the harness itself', () => {
  it('lets several processes take the fake Cloudflare lock at once', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'monocf-lock-')))
    const fake = join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'fake-wrangler.mjs')
    const cloudflare = join(dir, 'cloudflare.json')
    writeFileSync(cloudflare, JSON.stringify({workers: {orders: {active: [['v1', 100]]}}}))
    const read = () =>
      new Promise<{code: null | number; stderr: string}>((done) => {
        const child = spawn(process.execPath, [fake, 'deployments', 'status', '--name', 'orders', '--json'], {
          env: {...process.env, FAKE_WRANGLER_CF: cloudflare, FAKE_WRANGLER_LOG: '', FAKE_WRANGLER_RULES: ''},
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('close', (code) => done({code, stderr}))
      })

    try {
      const results = await Promise.all(Array.from({length: 12}, () => read()))

      expect(results.filter(({code}) => code !== 0).map(({stderr}) => stderr)).toEqual([])
    } finally {
      rmSync(dir, {force: true, maxRetries: 5, recursive: true, retryDelay: 200})
    }
  })

  it('rejects a wrangler call that had no config', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})
    const stub = join(fixture.root, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js')
    const original = readFileSync(stub, 'utf8')
    writeFileSync(stub, `process.argv = process.argv.filter((arg) => !arg.endsWith('wrangler.json') && arg !== '--config')\n${original}`)

    await expect(runCli(fixture, ['worker', 'orders', '-c', 'deploy'])).rejects.toThrow('with no config')
  })
})
