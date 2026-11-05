import {describe, expect, it} from 'vitest'

import {EXIT_ENVIRONMENT, EXIT_FAILED} from '../../src/errors.js'
import type {WranglerResult} from '../../src/wrangler/process.js'
import {
  parseDeploymentStatus,
  parseVersionTag,
  readActiveVersion,
  readFailure,
  readVersionTag,
  type WranglerCall,
} from '../../src/wrangler/read.js'

function result(overrides: Partial<WranglerResult>): WranglerResult {
  return {code: 0, output: {entries: []}, signal: null, stderr: '', stdout: '', ...overrides}
}

const answering =
  (answer: Partial<WranglerResult>): WranglerCall =>
  async () =>
    result(answer)

describe('parseDeploymentStatus', () => {
  it('reads one version as active', () => {
    expect(parseDeploymentStatus('w', '{"versions":[{"version_id":"v1","percentage":100}]}')).toEqual({
      state: 'active',
      versionId: 'v1',
    })
  })

  it('reads two versions as a split, largest share first, whatever order they come in', () => {
    const stdout = '{"versions":[{"version_id":"v1","percentage":40},{"version_id":"v2","percentage":60}]}'

    expect(parseDeploymentStatus('w', stdout)).toEqual({
      shares: [
        {percentage: 60, versionId: 'v2'},
        {percentage: 40, versionId: 'v1'},
      ],
      state: 'split',
    })
  })

  it('does not count a version with no traffic', () => {
    const stdout = '{"versions":[{"version_id":"v1","percentage":100},{"version_id":"v2","percentage":0}]}'

    expect(parseDeploymentStatus('w', stdout)).toEqual({state: 'active', versionId: 'v1'})
  })

  it.each(['', 'not json', '{}', '{"versions":[]}', '{"versions":[{"percentage":100}]}'])('fails on %j', (stdout) => {
    expect(() => parseDeploymentStatus('w', stdout)).toThrow(expect.objectContaining({exitCode: EXIT_FAILED}))
  })
})

describe('parseVersionTag', () => {
  it('reads the tag from the annotations', () => {
    expect(parseVersionTag('w', '{"annotations":{"workers/tag":"monocf:abc"}}')).toBe('monocf:abc')
  })

  it.each(['{}', '{"annotations":{}}', '{"annotations":[]}', '{"annotations":{"workers/tag":1}}'])('finds no tag in %s', (stdout) => {
    expect(parseVersionTag('w', stdout)).toBeUndefined()
  })

  it('fails on text that is no JSON', () => {
    expect(() => parseVersionTag('w', 'oops')).toThrow(/isn't JSON/)
  })
})

describe('readActiveVersion', () => {
  it('asks by name, with the account of the worker', async () => {
    const seen: unknown[] = []
    const call: WranglerCall = async (step, accountId) => {
      seen.push([step, accountId])
      return result({stdout: '{"versions":[{"version_id":"v1","percentage":100}]}'})
    }

    await readActiveVersion(call, 'orders-staging', 'an-account')

    expect(seen).toEqual([[{action: 'active-version', name: 'orders-staging'}, 'an-account']])
  })

  it('says a worker is missing only on code 10007', async () => {
    const stderr = 'This Worker does not exist on your account. [code: 10007]'

    await expect(readActiveVersion(answering({code: 1, stderr}), 'w')).resolves.toEqual({state: 'missing'})
  })

  it.each([
    ['another API error', 'Something broke [code: 10013]'],
    ['a network failure', 'fetch failed'],
    ['nothing at all', ''],
    ['a longer code that starts the same', 'Something broke [code: 100070]'],
  ])('fails on %s, and never calls it missing', async (_, stderr) => {
    await expect(readActiveVersion(answering({code: 1, stderr}), 'w')).rejects.toMatchObject({exitCode: EXIT_FAILED})
  })

  it('does not trust a kill, whatever the output says', async () => {
    const answer = answering({code: null, signal: 'SIGKILL', stderr: 'code: 10007'})

    await expect(readActiveVersion(answer, 'w')).rejects.toMatchObject({message: expect.stringContaining('killed by SIGKILL')})
  })
})

describe('readVersionTag', () => {
  it('fails rather than saying no tag', async () => {
    await expect(readVersionTag(answering({code: 1, stderr: 'Unknown [code: 100146]'}), 'w', 'v1')).rejects.toMatchObject({
      exitCode: EXIT_FAILED,
    })
  })
})

describe('readFailure', () => {
  it.each([
    "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable",
    'You are not authenticated. Please run `wrangler login`.',
    'Authentication error [code: 10000]',
    'More than one account available but unable to select one',
  ])('calls missing credentials an environment error: %s', (stderr) => {
    expect(readFailure('w', result({code: 1, stderr})).exitCode).toBe(EXIT_ENVIRONMENT)
  })

  it('quotes the error lines, without colours and without the account', () => {
    const stderr = '\u001B[31m✘ [ERROR] A request to the Cloudflare API (/accounts/0123456789abcdef0123456789abcdef/x) failed.\u001B[0m\n\n  Nope [code: 7]\n\nlogs: somewhere\n'

    const {message} = readFailure('w', result({code: 1, stderr}))

    expect(message).toBe('w: wrangler failed with exit code 1: ✘ [ERROR] A request to the Cloudflare API (/accounts/<account>/x) failed. Nope [code: 7]')
  })

  it('falls back to the last line', () => {
    expect(readFailure('w', result({code: 1, stderr: 'one\ntwo\n'})).message).toBe('w: wrangler failed with exit code 1: two')
  })

  it('still says what failed with nothing on stderr', () => {
    expect(readFailure('w', result({code: 1})).message).toBe('w: wrangler failed with exit code 1.')
  })
})
