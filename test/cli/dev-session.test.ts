import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli} from '../helpers/harness.js'

function session() {
  const fixture = createFixture({
    base: false,
    workers: [{bindings: ['billing'], name: 'gateway'}, {name: 'billing'}, {name: 'counters'}, {name: 'pipeline'}, {name: 'logs'}, {name: 'audit'}],
  })
  writeFileSync(
    join(fixture.worker('gateway'), 'wrangler.jsonc'),
    JSON.stringify({
      compatibility_date: '2025-01-09',
      durable_objects: {bindings: [{class_name: 'Counter', name: 'COUNTER', script_name: 'counters'}]},
      main: 'src/index.ts',
      name: 'gateway',
      queues: {producers: [{binding: 'JOBS', queue: 'jobs'}]},
      services: [{binding: 'BILLING', service: 'billing'}],
      tail_consumers: [{service: 'logs'}],
      workflows: [{binding: 'FLOW', class_name: 'Flow', name: 'flow', script_name: 'pipeline'}],
    }),
  )
  writeFileSync(
    join(fixture.worker('audit'), 'wrangler.jsonc'),
    JSON.stringify({compatibility_date: '2025-01-09', main: 'src/index.ts', name: 'audit', queues: {consumers: [{queue: 'jobs'}]}}),
  )
  return fixture
}

describe('dev <worker>', () => {
  it('starts the workers it calls through services, Durable Objects and Workflows, and not queue or tail ones', async () => {
    const result = await runCli(session(), ['dev', 'gateway'], {env: {GITHUB_SHA: 'abcdef0123456789'}})

    expect(result.exitCode, result.stderr).toBe(0)
    const names = result.calls[0].configs.map((config) => (config as {name: string}).name)
    expect(names[0]).toBe('gateway')
    expect(names.slice(1).sort()).toEqual(['billing', 'counters', 'pipeline'])
  })

  it('says that queue messages and tail events for a worker outside the session go nowhere', async () => {
    const result = await runCli(session(), ['dev', 'gateway'])

    expect(result.stderr).toContain("gateway sends to queue jobs, which audit consumes, and audit isn't in this session")
    expect(result.stderr).toContain("gateway sends its tail events to logs, which isn't in this session")
  })

  it('gives every worker in the session RELEASE', async () => {
    const result = await runCli(session(), ['dev', 'gateway'], {env: {GITHUB_SHA: 'abcdef0123456789'}})

    const {argv, configs} = result.calls[0]
    expect(argv).toContain('RELEASE:abcdef0')
    for (const config of configs.slice(1)) expect((config as {vars?: Record<string, string>}).vars?.RELEASE).toBe('abcdef0')
  })
})
