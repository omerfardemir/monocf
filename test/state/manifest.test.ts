import {describe, expect, it} from 'vitest'

import {EXIT_ENVIRONMENT} from '../../src/errors.js'
import {manifestKey, parseStateManifest, runKey, STATE_SCHEMA_VERSION} from '../../src/state/manifest.js'

const worker = {
  bundleHash: 'b',
  commit: 'c',
  configHash: 'g',
  deployedAt: '2026-01-01T00:00:00.000Z',
  deployedName: 'orders-staging',
  doHash: 'd',
  externalHash: 'e',
  fingerprint: 'f',
  triggers: {consumers: [], crons: null, previewUrls: null, routes: [], streamingTailConsumers: null, tailConsumers: null, workersDev: true, workflows: []},
  triggersHash: 't',
  versionId: 'v',
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({env: 'staging', schemaVersion: 1, updatedAt: '2026-01-01', workers: {orders: worker}, ...overrides})
}

describe('keys', () => {
  it('holds one manifest per env, and its runs beside it', () => {
    expect(manifestKey('staging')).toBe('staging/manifest.json')
    expect(runKey('staging', 'r1')).toBe('staging/runs/r1.json')
  })
})

describe('parseStateManifest', () => {
  it('reads a valid manifest', () => {
    expect(parseStateManifest(body(), 'staging').workers.orders.versionId).toBe('v')
  })

  it('takes a worker without a version', () => {
    expect(parseStateManifest(body(), 'staging').workers.orders.version).toBeUndefined()
  })

  it.each<[string, string, RegExp]>([
    ['a newer schema version', body({schemaVersion: STATE_SCHEMA_VERSION + 1}), /Upgrade monocf/],
    ['no schema version', body({schemaVersion: undefined}), /schemaVersion/],
    ['a schema version that is no number', body({schemaVersion: '1'}), /schemaVersion/],
    ['another env', body({env: 'production'}), /is for env production/],
    ['no workers', body({workers: undefined}), /has no workers/],
    ['an empty file', '', /not valid JSON/],
    ['text that is no JSON', 'oops', /not valid JSON/],
    ['JSON that is no object', '[]', /not an object/],
    ['a worker that is no object', body({workers: {orders: 1}}), /isn't an object/],
    ['a worker with no version ID', body({workers: {orders: {...worker, versionId: undefined}}}), /no versionId for orders/],
    ['a worker with no triggers', body({workers: {orders: {...worker, triggers: undefined}}}), /no triggers for orders/],
  ])('stops at %s, rather than planning from nothing', (_, text, message) => {
    expect(() => parseStateManifest(text, 'staging')).toThrow(message)
    expect(() => parseStateManifest(text, 'staging')).toThrow(expect.objectContaining({exitCode: EXIT_ENVIRONMENT}))
  })
})
