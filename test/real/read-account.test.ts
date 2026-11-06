import {createServer, type Server} from 'node:http'
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {createFixture, runCli, type Fixture} from '../helpers/harness.js'

const FROM_ROOT_FILE = 'a'.repeat(32)
const FROM_ENVIRONMENT = 'b'.repeat(32)
const FROM_WORKER = 'c'.repeat(32)
const FROM_DOT_ENV = 'd'.repeat(32)

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** Stands in for the API, and answers that no worker exists. The path of each request shows which account wrangler chose. */
async function fakeApi(): Promise<{accounts: () => string[]; url: string}> {
  const seen: string[] = []
  const server = createServer((request, response) => {
    const account = /\/accounts\/([0-9a-f]{32})\//.exec(request.url ?? '')?.[1]
    if (account) seen.push(account)
    response.writeHead(404, {'content-type': 'application/json'})
    response.end(JSON.stringify({errors: [{code: 10_007, message: 'This Worker does not exist on your account.'}], messages: [], result: null, success: false}))
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const {port} = server.address() as {port: number}
  return {accounts: () => [...new Set(seen)], url: `http://127.0.0.1:${port}/client/v4`}
}

function project(config: Record<string, unknown> = {}, files: Record<string, string> = {}): Fixture {
  const fixture = createFixture({
    environments: ['staging'],
    files: {'wrangler.jsonc': JSON.stringify({account_id: FROM_ROOT_FILE, name: 'at-the-root'}), ...files},
    wrangler: 'real',
    workers: [{config, name: 'orders'}],
  })
  mkdirSync(join(fixture.root, 'state'))
  return fixture
}

describe('real wrangler: a wrangler config at the project root', {timeout: 180_000}, () => {
  it('does not beat the account of a read', async () => {
    const api = await fakeApi()

    await runCli(project(), ['plan', '-e', 'staging', '--state', 'file:state', '--first-run'], {
      env: {CLOUDFLARE_ACCOUNT_ID: FROM_ENVIRONMENT, CLOUDFLARE_API_BASE_URL: api.url},
    })

    expect(api.accounts()).toEqual([FROM_ENVIRONMENT])
  })

  it("does not beat a worker's own account_id", async () => {
    const api = await fakeApi()

    await runCli(project({account_id: FROM_WORKER}), ['plan', '-e', 'staging', '--state', 'file:state', '--first-run'], {
      env: {CLOUDFLARE_ACCOUNT_ID: FROM_ENVIRONMENT, CLOUDFLARE_API_BASE_URL: api.url},
    })

    expect(api.accounts()).toEqual([FROM_WORKER])
  })

  it("does not beat the account in a worker's .env", async () => {
    const api = await fakeApi()
    const fixture = project({}, {'workers/orders/.env': `CLOUDFLARE_ACCOUNT_ID=${FROM_DOT_ENV}\n`})

    await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run'], {
      env: {CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_BASE_URL: api.url},
    })

    expect(api.accounts()).toEqual([FROM_DOT_ENV])
  })

  it('does not beat the account of a write, which passes --config', async () => {
    const api = await fakeApi()

    await runCli(project(), ['worker', 'orders', '-c', 'deploy', '-e', 'staging'], {
      env: {CLOUDFLARE_ACCOUNT_ID: FROM_ENVIRONMENT, CLOUDFLARE_API_BASE_URL: api.url},
    })

    expect(api.accounts()).toEqual([FROM_ENVIRONMENT])
  })

  it('is not what a cached account in the project is', async () => {
    const api = await fakeApi()
    const fixture = project()
    const cache = join(fixture.root, 'node_modules', '.cache', 'wrangler')
    mkdirSync(cache, {recursive: true})
    writeFileSync(join(cache, 'wrangler-account.json'), JSON.stringify({account: {id: FROM_ROOT_FILE, name: 'cached'}}))

    await runCli(fixture, ['plan', '-e', 'staging', '--state', 'file:state', '--first-run'], {
      env: {CLOUDFLARE_ACCOUNT_ID: FROM_ENVIRONMENT, CLOUDFLARE_API_BASE_URL: api.url},
    })

    expect(api.accounts()).toEqual([FROM_ENVIRONMENT])
  })
})
