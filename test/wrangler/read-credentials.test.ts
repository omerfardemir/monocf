import {describe, expect, it} from 'vitest'

import {EXIT_ENVIRONMENT, EXIT_FAILED} from '../../src/errors.js'
import {readFailure} from '../../src/wrangler/read.js'
import {isTransient} from '../../src/wrangler/retry.js'

const failed = (stderr: string) => ({code: 1, output: {entries: []}, signal: null, stderr, stdout: ''})

describe('readFailure', () => {
  it.each([
    ['code 6003', 'Invalid request headers [code: 6003]'],
    ['code 6111', 'Invalid format for Authorization header [code: 6111]'],
    ['code 9109', 'Unauthorized to access requested resource [code: 9109]'],
    ['the words alone', 'Invalid access token'],
  ])('counts %s as a credentials failure', (_name, stderr) => {
    expect(readFailure('orders', failed(stderr)).exitCode).toBe(EXIT_ENVIRONMENT)
  })

  it('says to wait after too many authentication failures', () => {
    const error = readFailure('orders', failed('Too many authentication failures [code: 10502]'))

    expect(error.exitCode).toBe(EXIT_ENVIRONMENT)
    expect(error.message).toContain('wait')
  })

  it('counts an API rate limit as passing by itself', () => {
    expect(isTransient(failed('A request to the Cloudflare API failed. Rate limited. Please wait [code: 10429]'))).toBe(true)
  })

  it('does not hammer after too many authentication failures', () => {
    expect(isTransient(failed('Too many authentication failures [code: 10502]'))).toBe(false)
  })

  it('leaves another failure at exit 1', () => {
    expect(readFailure('orders', failed('Something else [code: 96003]')).exitCode).toBe(EXIT_FAILED)
  })
})
