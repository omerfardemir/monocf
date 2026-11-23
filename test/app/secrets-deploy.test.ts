import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {runSecretsDeploy} from '../../src/app/secrets.js'
import {createFixture, type FakeCloudflare, type WranglerCall} from '../helpers/harness.js'

const savedEnvironment = {...process.env}
let logPath: string
let cloudflarePath: string
let stderr: string
let stdout: string

beforeEach(() => {
  stderr = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  stdout = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  process.env = {...savedEnvironment}
  process.exitCode = undefined
})

/** The fixture's base config names a worker `<dir>-v1`, and an env adds its own name. */
function deployedName(dir: string): string {
  return `${dir}-v1-production`
}

function useFixture(root: string, live: string[]): void {
  logPath = join(root, 'calls.ndjson')
  cloudflarePath = join(root, 'cloudflare.json')
  const cloudflare: FakeCloudflare = {
    workers: Object.fromEntries(live.map((dir) => [deployedName(dir), {active: [[`first-of-${dir}`, 100]], tags: {[`first-of-${dir}`]: null}}])),
  }
  writeFileSync(cloudflarePath, JSON.stringify(cloudflare))
  process.env.FAKE_WRANGLER_LOG = logPath
  process.env.FAKE_WRANGLER_CF = cloudflarePath
  delete process.env.FAKE_WRANGLER_RULES
}

function project(files: Record<string, string> = {}, workers = ['orders', 'user-service'], {live = workers}: {live?: string[]} = {}) {
  const fixture = createFixture({
    environments: ['production'],
    files,
    workers: workers.map((name) => ({config: {env: {production: {secrets: {required: ['API_KEY', 'DATABASE_URL']}}}}, name})),
  })
  useFixture(fixture.root, live)
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
    useFixture(fixture.root, ['static'])

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

describe('secrets deploy checks', () => {
  it('reports the live version each upload made', async () => {
    const {root} = project({}, ['orders'])
    Object.assign(process.env, {API_KEY: 'k', DATABASE_URL: 'd'})

    await runSecretsDeploy('orders', {env: 'production', fromEnv: true, json: true, rootDir: root})

    const events = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(events).toContainEqual(expect.objectContaining({action: 'secrets', status: 'ok', type: 'step-finished', versionId: 'version-1-of-orders', worker: 'orders'}))
  })

  it('uploads nothing when any selected worker does not exist, and names each one', async () => {
    const {root} = project({}, ['orders', 'user-service', 'billing'], {live: ['orders']})
    Object.assign(process.env, {API_KEY: 'k', DATABASE_URL: 'd'})

    const run = runSecretsDeploy(undefined, {all: true, env: 'production', fromEnv: true, rootDir: root})

    await expect(run).rejects.toMatchObject({code: 'worker-not-deployed'})
    await expect(run).rejects.toThrow('billing, user-service: these workers do not exist on Cloudflare.')
    expect(bulkCalls()).toEqual([])
  })

  it('creates a missing worker with --create', async () => {
    const {root} = project({}, ['orders'], {live: []})
    Object.assign(process.env, {API_KEY: 'k', DATABASE_URL: 'd'})

    await runSecretsDeploy('orders', {create: true, env: 'production', fromEnv: true, rootDir: root})

    expect(bulkCalls()).toHaveLength(1)
    const cloudflare = JSON.parse(readFileSync(cloudflarePath, 'utf8')) as FakeCloudflare
    expect(cloudflare.workers?.[deployedName('orders')]?.secrets).toEqual(['API_KEY', 'DATABASE_URL'])
  })

  it('prints which variables it uses only once every worker is known to exist', async () => {
    const {root} = project({}, ['orders'], {live: []})
    Object.assign(process.env, {API_KEY: 'k', DATABASE_URL: 'd'})

    await expect(runSecretsDeploy('orders', {env: 'production', fromEnv: true, rootDir: root})).rejects.toThrow()
    expect(stderr).not.toContain('uploading')
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
