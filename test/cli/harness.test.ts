import {afterEach, describe, expect, it, vi} from 'vitest'

import {createFixture, runCli} from '../helpers/harness.js'

describe('test harness (R6)', () => {
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
