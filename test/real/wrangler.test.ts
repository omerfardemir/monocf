import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli, snapshotTree, startCli, type RunningCli} from '../helpers/harness.js'

const isWindows = process.platform === 'win32'
const STARTUP_MS = 90_000

// Each run of real wrangler below uses its own port, and tests in this file run one at a time.
let nextPort = 18_700
function port(): number {
  nextPort += 1
  return nextPort
}

/** Ends monocf and everything under it. Windows has no signals, so there the tree is killed. */
async function stop(running: RunningCli): Promise<void> {
  if (isWindows) {
    try {
      execFileSync('taskkill', ['/pid', String(running.child.pid), '/T', '/F'], {stdio: 'ignore'})
    } catch {
      // Already gone.
    }
  } else {
    running.child.kill('SIGTERM')
  }

  await running.done
}

/** The body of the first answer that passes, while the session starts up. */
async function fetchUntil(running: RunningCli, url: string, accept: (status: number) => boolean): Promise<string> {
  const deadline = Date.now() + STARTUP_MS
  let last = 'no answer'
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) throw new Error(`monocf ended early:\n${running.stderr()}`)
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(5000)})
      const body = await response.text()
      if (accept(response.status)) return body
      last = `${response.status}: ${body}`
    } catch (error) {
      last = String(error)
    }

    await new Promise((tick) => {
      setTimeout(tick, 500)
    })
  }

  throw new Error(`No good answer from ${url}. Last: ${last}\n${running.stderr()}`)
}

const isOk = (status: number) => status === 200

const callsOrders = `export default {
  async fetch(request, env) {
    const response = await env.ORDERS.fetch(request)
    return new Response('gateway got: ' + (await response.text()), {status: response.status})
  },
}
`

function bindingProject() {
  return {
    environments: ['staging'],
    files: {'workers/gateway/src/index.ts': callsOrders},
    wrangler: 'real' as const,
    workers: [{bindings: ['orders'], envBindings: {staging: ['orders']}, name: 'gateway'}, {name: 'orders'}],
  }
}

describe('real wrangler, with no Cloudflare', {timeout: 180_000}, () => {
  describe('build', () => {
    it('finds every relative path through the rebased config', async () => {
      const fixture = createFixture({
        files: {
          'workers/orders/lib/shim.ts': `export const shim = 'from-the-alias'\n`,
          'workers/orders/public/index.html': 'hello',
          'workers/orders/src/index.ts': `import {shim} from 'shim-target'
export default {fetch: () => new Response(shim)}
`,
        },
        wrangler: 'real',
        workers: [
          {
            config: {alias: {'shim-target': './lib/shim.ts'}, assets: {directory: './public'}},
            name: 'orders',
          },
        ],
      })
      const before = snapshotTree(fixture.root)

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build', '-m'])

      expect(result.exitCode).toBe(0)
      const bundle = readFileSync(join(fixture.worker('orders'), 'dist', 'index.js'), 'utf8')
      expect(bundle).toContain('from-the-alias')
      const added = Object.keys(snapshotTree(fixture.root)).filter((path) => !(path in before))
      expect(added.filter((path) => !path.startsWith('workers/orders/dist/'))).toEqual([])
    })

    it('runs two envs at once without either seeing the other', async () => {
      const fixture = createFixture({
        environments: ['dev', 'staging'],
        files: {'workers/orders/src/index.ts': `export default {fetch: (_, env) => new Response(env.STAGE)}\n`},
        wrangler: 'real',
        workers: [{name: 'orders'}],
      })

      const [dev, staging] = await Promise.all([
        startCli(fixture, ['worker', 'orders', '-c', 'build', '-e', 'dev']).done,
        startCli(fixture, ['worker', 'orders', '-c', 'build', '-e', 'staging']).done,
      ])

      expect(dev.exitCode).toBe(0)
      expect(staging.exitCode).toBe(0)
      expect(existsSync(join(fixture.root, '.monocf'))).toBe(false)
    })
  })

  describe('dev', () => {
    it('hands the worker its env values unchanged, from a file outside the source tree (F02, F03)', async () => {
      const values = {
        EQUALS: 'a=b=c',
        HASH: 'value # not a comment',
        NEWLINE: 'line1\nline2',
        QUOTES: `it's "quoted"`,
      }
      const source = Object.entries(values)
        .map(([key, value]) => `${key}=\`${value}\``)
        .join('\n')
      const fixture = createFixture({
        files: {
          'workers/orders/.dev.vars': source,
          'workers/orders/src/index.ts': `export default {fetch: (_, env) => Response.json(env)}\n`,
        },
        wrangler: 'real',
        workers: [{name: 'orders'}],
      })
      const before = snapshotTree(fixture.root)
      const devPort = port()

      const running = startCli(fixture, ['worker', 'orders', '-c', 'dev', '-p', String(devPort)])
      try {
        const body = await fetchUntil(running, `http://127.0.0.1:${devPort}/`, isOk)

        expect(JSON.parse(body)).toMatchObject({...values, RELEASE: expect.any(String)})
        expect(snapshotTree(fixture.root)).toMatchObject({'workers/orders/.dev.vars': source})
        const added = Object.keys(snapshotTree(fixture.root)).filter((path) => !(path in before))
        expect(added.filter((path) => !/^\.monocf\/|^workers\/orders\/\.wrangler\//.test(path))).toEqual([])
      } finally {
        await stop(running)
      }
    })

    it.each([
      ['without an env', []],
      ['with an env', ['-e', 'staging']],
    ])('one worker reaches another through a service binding, %s', async (_, envFlags) => {
      const fixture = createFixture(bindingProject())
      const devPort = port()

      const running = startCli(fixture, ['worker', 'gateway', '-c', 'dev', '-p', String(devPort), ...envFlags])
      try {
        const body = await fetchUntil(running, `http://127.0.0.1:${devPort}/`, isOk)

        expect(body).toBe('gateway got: orders')
      } finally {
        await stop(running)
      }
    })

    it.each([
      ['without an env', []],
      ['with an env', ['-e', 'staging']],
    ])('dev -a: a worker reaches another through a service binding, %s', async (_, envFlags) => {
      const fixture = createFixture(bindingProject())
      const devPort = port()

      const running = startCli(fixture, ['worker', '-a', '-c', 'dev', '-p', String(devPort), ...envFlags])
      try {
        const body = await fetchUntil(running, `http://127.0.0.1:${devPort}/gateway`, isOk)

        expect(body).toBe('gateway got: orders')
      } finally {
        await stop(running)
      }
    })

    it.skipIf(isWindows)('fails when the process running wrangler is killed (F04)', async () => {
      const fixture = createFixture({
        files: {'workers/orders/src/index.ts': `export default {fetch: () => new Response('up')}\n`},
        wrangler: 'real',
        workers: [{name: 'orders'}],
      })
      const devPort = port()
      const running = startCli(fixture, ['worker', 'orders', '-c', 'dev', '-p', String(devPort)])
      await fetchUntil(running, `http://127.0.0.1:${devPort}/`, isOk)

      const childrenOf = (pid: number): number[] => {
        try {
          return execFileSync('pgrep', ['-P', String(pid)], {encoding: 'utf8'})
            .split('\n')
            .filter(Boolean)
            .map(Number)
        } catch {
          return []
        }
      }

      const [wrangler] = childrenOf(running.child.pid!)
      expect(readFileSync(`/proc/${wrangler}/cmdline`, 'utf8')).toContain(join('wrangler-dist', 'cli.js'))
      const descendants = childrenOf(wrangler)

      const exited = new Promise<number | null>((resolve) => {
        running.child.once('exit', resolve)
      })
      process.kill(wrangler, 'SIGKILL')
      const exitCode = await exited

      // What the kill orphaned still holds the output pipes, so it has to go before the run can be read.
      for (const pid of descendants) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }

      await running.done
      expect(exitCode).toBe(128 + 9)
    })
  })
})
