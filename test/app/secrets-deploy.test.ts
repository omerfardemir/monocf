import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {runSecretsDeploy} from '../../src/app/secrets.js'
import {createFixture, type WranglerCall} from '../helpers/harness.js'

const savedEnvironment = {...process.env}
let logPath: string
let stderr: string

beforeEach(() => {
  stderr = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.env = {...savedEnvironment}
  process.exitCode = undefined
})

function project(files: Record<string, string> = {}, workers = ['orders', 'user-service']) {
  const fixture = createFixture({
    environments: ['production'],
    files,
    workers: workers.map((name) => ({config: {env: {production: {secrets: {required: ['API_KEY', 'DATABASE_URL']}}}}, name})),
  })
  logPath = join(fixture.root, 'calls.ndjson')
  process.env.FAKE_WRANGLER_LOG = logPath
  delete process.env.FAKE_WRANGLER_CF
  delete process.env.FAKE_WRANGLER_RULES
  for (const name of ['API_KEY', 'DATABASE_URL', 'ORDERS__API_KEY', 'ORDERS__DATABASE_URL', 'USER_SERVICE__API_KEY', 'USER_SERVICE__DATABASE_URL']) {
    delete process.env[name]
  }

  return fixture
}

function bulkCalls(): WranglerCall[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WranglerCall)
    .filter((call) => call.argv[0] === 'secret')
}

function workerOf(call: WranglerCall): string {
  return call.configDir!.split(/[\\/]/).at(-1)!
}

describe('secrets deploy --from-env', () => {
  it("gives each worker its prefixed variable over the shared one, on wrangler's stdin", async () => {
    const {root} = project()
    Object.assign(process.env, {API_KEY: 'shared-key', DATABASE_URL: 'shared-db', USER_SERVICE__DATABASE_URL: 'user-db'})

    await runSecretsDeploy(undefined, {all: true, env: 'production', fromEnv: true, rootDir: root})

    const calls = bulkCalls()
    expect(calls.map((call) => [workerOf(call), call.secretInput?.vars, call.secretFile])).toEqual([
      ['orders', {API_KEY: 'shared-key', DATABASE_URL: 'shared-db'}, undefined],
      ['user-service', {API_KEY: 'shared-key', DATABASE_URL: 'user-db'}, undefined],
    ])
    expect(calls[0].argv).toEqual(['secret', 'bulk', '--env', 'production', '--config', calls[0].configPaths[0]])
    expect(stderr).toContain('user-service: uploading API_KEY, DATABASE_URL from USER_SERVICE__DATABASE_URL.')
  })

  it('reads only the names a worker declares', async () => {
    const {root} = project({}, ['orders'])
    Object.assign(process.env, {API_KEY: 'k', DATABASE_URL: 'd', ORDERS__OTHER: 'not declared'})

    await runSecretsDeploy('orders', {env: 'production', fromEnv: true, rootDir: root})

    expect(Object.keys(bulkCalls()[0].secretInput!.vars)).toEqual(['API_KEY', 'DATABASE_URL'])
  })

  it('uploads nothing when any worker is missing a value, and names every variable it tried', async () => {
    const {root} = project()
    // GitHub Actions gives an empty string for a secret the environment doesn't have.
    Object.assign(process.env, {API_KEY: 'k', ORDERS__DATABASE_URL: 'd', USER_SERVICE__DATABASE_URL: ''})

    const run = runSecretsDeploy(undefined, {all: true, env: 'production', fromEnv: true, rootDir: root})

    await expect(run).rejects.toMatchObject({code: 'secret-env-missing', exitCode: 2})
    await expect(run).rejects.toThrow('user-service: DATABASE_URL (set USER_SERVICE__DATABASE_URL or DATABASE_URL)')
    expect(bulkCalls()).toEqual([])
  })

  it('never puts a value in an error', async () => {
    const {root} = project({}, ['orders'])
    Object.assign(process.env, {API_KEY: 'super-secret-value'})

    await expect(runSecretsDeploy('orders', {env: 'production', fromEnv: true, rootDir: root})).rejects.not.toThrow('super-secret-value')
  })

  it('refuses two workers that read the same prefix', async () => {
    const {root} = project({}, ['user-service', 'user_service'])
    Object.assign(process.env, {API_KEY: 'k', DATABASE_URL: 'd'})

    await expect(runSecretsDeploy('user-service', {env: 'production', fromEnv: true, rootDir: root})).rejects.toMatchObject({
      code: 'secret-prefix-collision',
    })
    expect(bulkCalls()).toEqual([])
  })

  it('skips a worker that declares no names, with a notice', async () => {
    const fixture = createFixture({environments: ['production'], workers: [{name: 'static'}]})
    logPath = join(fixture.root, 'calls.ndjson')
    process.env.FAKE_WRANGLER_LOG = logPath

    await runSecretsDeploy('static', {env: 'production', fromEnv: true, rootDir: fixture.root})

    expect(bulkCalls()).toEqual([])
    expect(stderr).toContain('static: no secret names to read: it has no secrets.required and no .dev.vars.example.')
  })

  it('needs no .dev.vars file, and reads none', async () => {
    const {root} = project({'.dev.vars.production': 'API_KEY=from-file\nDATABASE_URL=from-file\n'}, ['orders'])
    Object.assign(process.env, {API_KEY: 'from-env', DATABASE_URL: 'from-env'})

    await runSecretsDeploy('orders', {env: 'production', fromEnv: true, rootDir: root})

    expect(bulkCalls()[0].secretInput!.vars).toEqual({API_KEY: 'from-env', DATABASE_URL: 'from-env'})
  })
})

describe('secrets deploy from files', () => {
  it('sends the values on stdin, not in a file', async () => {
    const {root} = project({'.dev.vars.production': 'API_KEY=k\nDATABASE_URL="line1\\nline2"\n'}, ['orders'])

    await runSecretsDeploy('orders', {env: 'production', rootDir: root})

    const [call] = bulkCalls()
    expect(call.secretInput!.vars).toEqual({API_KEY: 'k', DATABASE_URL: 'line1\nline2'})
    expect(call.secretFile).toBeUndefined()
    expect(call.argv).toEqual(['secret', 'bulk', '--env', 'production', '--config', call.configPaths[0]])
  })
})
