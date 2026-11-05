import {mkdirSync, mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {EXIT_ENVIRONMENT} from '../../src/errors.js'
import {parseStateManifest} from '../../src/state/manifest.js'
import {openStateStore} from '../../src/state/store.js'

const entry = {
  bundleHash: 'b',
  commit: 'c',
  configHash: 'c',
  deployedAt: 'now',
  deployedName: 'orders',
  doHash: 'd',
  externalHash: 'e',
  fingerprint: 'f',
  triggers: {},
  triggersHash: 't',
  versionId: 'v',
}

function manifest(change: object, workers?: object): string {
  return JSON.stringify({env: 'dev', schemaVersion: 1, updatedAt: 'now', workers: workers ?? {orders: entry}, ...change})
}

describe('parseStateManifest', () => {
  it.each([0, -1])('refuses schemaVersion %s', (schemaVersion) => {
    expect(() => parseStateManifest(manifest({schemaVersion}), 'dev')).toThrow('schemaVersion')
  })

  it('refuses an empty versionId', () => {
    expect(() => parseStateManifest(manifest({}, {orders: {...entry, versionId: ''}}), 'dev')).toThrow('empty versionId')
  })
})

describe('the file store', () => {
  it('does not read a file it cannot open as a first run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'monocf-store-'))
    mkdirSync(join(dir, 'dev', 'manifest.json'), {recursive: true})
    const store = openStateStore({dir, kind: 'file', url: `file:${dir}`}, () => Promise.reject(new Error('no wrangler here')), dir)

    await expect(store.read('dev/manifest.json')).rejects.toMatchObject({exitCode: EXIT_ENVIRONMENT})
  })
})
