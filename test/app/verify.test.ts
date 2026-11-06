import {describe, expect, it} from 'vitest'

import {STALE_READ_DELAYS_MS, verifyActive} from '../../src/app/deployment.js'
import type {WranglerCall} from '../../src/wrangler/read.js'

/** Answers `deployments status` with each version in turn, and the last one from then on. */
function reading(...versions: string[]): {call: WranglerCall; reads: () => number} {
  let reads = 0
  const call: WranglerCall = async () => {
    const versionId = versions[Math.min(reads, versions.length - 1)]
    reads++
    return {code: 0, output: {entries: []}, signal: null, stderr: '', stdout: JSON.stringify({versions: [{percentage: 100, version_id: versionId}]})}
  }

  return {call, reads: () => reads}
}

const where = {deployedName: 'billing-v1-staging', dir: 'billing'}

describe('verifyActive', () => {
  it('waits 30 s at most for a read that names the replaced version', () => {
    expect(STALE_READ_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBe(30_000)
  })

  it('fails once every read still names the replaced version', async () => {
    const {call, reads} = reading('old')

    await expect(verifyActive(call, where, 'new', {delaysMs: [0, 0, 0], replaced: 'old'})).rejects.toThrow('verify-mismatch: expected new at 100%, and Cloudflare serves old.')
    expect(reads()).toBe(4)
  })

  it('passes once a later read names the new version', async () => {
    const {call, reads} = reading('old', 'old', 'new')

    await verifyActive(call, where, 'new', {delaysMs: [0, 0, 0], replaced: 'old'})
    expect(reads()).toBe(3)
  })

  it("doesn't read again with nothing replaced, as for a new worker", async () => {
    const {call, reads} = reading('old')

    await expect(verifyActive(call, where, 'new', {delaysMs: [0, 0, 0]})).rejects.toThrow('verify-mismatch')
    expect(reads()).toBe(1)
  })
})
