import {describe, expect, it} from 'vitest'

import {confirmSecretsUpload, type LiveSecrets} from '../../src/app/live-secrets.js'

/** Answers each read with the next version in turn, and the last one from then on. */
function reading(...answers: (LiveSecrets | undefined)[]): {read: () => Promise<LiveSecrets | undefined>; reads: () => number} {
  let reads = 0
  return {
    async read() {
      const answer = answers[Math.min(reads, answers.length - 1)]
      reads++
      return answer
    },
    reads: () => reads,
  }
}

const upload = {before: 'old', dir: 'orders', names: ['API_KEY', 'DATABASE_URL']}
const delays = {delaysMs: [0, 0, 0]}

describe('confirmSecretsUpload', () => {
  it('confirms a new live version that holds every name, and returns it', async () => {
    const {read, reads} = reading({names: ['API_KEY', 'DATABASE_URL', 'OTHER'], versionId: 'new'})

    await expect(confirmSecretsUpload(read, upload, delays)).resolves.toBe('new')
    expect(reads()).toBe(1)
  })

  it('fails when the version from before is still live, as after input wrangler could not read', async () => {
    const {read, reads} = reading({names: ['API_KEY', 'DATABASE_URL'], versionId: 'old'})

    await expect(confirmSecretsUpload(read, upload, delays)).rejects.toMatchObject({
      code: 'upload-unconfirmed',
      message: 'orders: wrangler secret bulk exited 0, but Cloudflare serves the version from before, old, so the upload is unconfirmed.',
    })
    expect(reads()).toBe(4)
  })

  it('waits out a stale read', async () => {
    const {read, reads} = reading({names: [], versionId: 'old'}, {names: [], versionId: 'old'}, {names: ['API_KEY', 'DATABASE_URL'], versionId: 'new'})

    await expect(confirmSecretsUpload(read, upload, delays)).resolves.toBe('new')
    expect(reads()).toBe(3)
  })

  it('fails when the new version lacks a name', async () => {
    const {read} = reading({names: ['API_KEY'], versionId: 'new'})

    await expect(confirmSecretsUpload(read, upload, delays)).rejects.toThrow('Cloudflare serves new, which lacks some of them')
  })

  it('confirms the first version of a worker that --create made', async () => {
    const {read} = reading(undefined, {names: ['API_KEY', 'DATABASE_URL'], versionId: 'first'})

    await expect(confirmSecretsUpload(read, {...upload, before: undefined}, delays)).resolves.toBe('first')
  })
})
