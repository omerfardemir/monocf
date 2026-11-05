import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, listTree, runCli, startCli, type Fixture} from '../helpers/harness.js'

const REVEAL = `require('node:fs').writeFileSync('seen.json', JSON.stringify({A: process.env.A, B: process.env.B, C: process.env.C, D: process.env.D, E: process.env.E}))`
const SECRET = 'value-that-must-stay-out-of-every-log'

function project(files: Record<string, string>): Fixture {
  const fixture = createFixture({
    environments: ['staging'],
    files: Object.fromEntries(Object.entries({'reveal.cjs': REVEAL, ...files}).map(([path, content]) => [`workers/orders/${path}`, content])),
    wrangler: 'real',
    workers: [{config: {build: {command: 'node reveal.cjs'}}, name: 'orders'}],
  })
  mkdirSync(join(fixture.root, 'state'), {recursive: true})
  return fixture
}

function seen(fixture: Fixture): Record<string, string | undefined> {
  return JSON.parse(readFileSync(join(fixture.worker('orders'), 'seen.json'), 'utf8'))
}

describe('real wrangler: a worker keeps its .env files', {timeout: 180_000}, () => {
  it('reach build.command, in wrangler precedence, with the real environment winning', async () => {
    const fixture = project({
      '.env': 'A=base\nB=base\nC=base\nD=base\nE=base\n',
      '.env.local': 'B=local\nC=local\nD=local\n',
      '.env.staging': 'C=env\nD=env\n',
      '.env.staging.local': 'D=env-local\n',
    })

    const result = await runCli(fixture, ['bundle', 'orders', '-e', 'staging'], {env: {E: 'real'}})

    expect(result.exitCode, result.stderr).toBe(0)
    expect(seen(fixture)).toEqual({A: 'base', B: 'local', C: 'env', D: 'env-local', E: 'real'})
  })

  it('expands references as a run in place does', async () => {
    const fixture = project({'.env': 'A=one\nB=$A-two\n'})

    const result = await runCli(fixture, ['bundle', 'orders', '-e', 'staging'])

    expect(result.exitCode, result.stderr).toBe(0)
    expect(seen(fixture)).toMatchObject({A: 'one', B: 'one-two'})
  })

  it('never prints a value, in text or in events', async () => {
    const fixture = project({'.env': `A=${SECRET}\n`})

    const text = await runCli(fixture, ['bundle', 'orders', '-e', 'staging'])
    const json = await runCli(fixture, ['bundle', 'orders', '-e', 'staging', '--json'])

    expect(seen(fixture).A).toBe(SECRET)
    expect(`${text.stdout}${text.stderr}${json.stdout}${json.stderr}`).not.toContain(SECRET)
  })

  it('dev reads local values from .env when there is no .dev.vars, and leaves nothing behind', async () => {
    const fixture = createFixture({
      files: {
        'workers/orders/.env': `LOCAL_VALUE=from-dot-env\n`,
        'workers/orders/src/index.ts': `export default {fetch: (_request: Request, env: {LOCAL_VALUE?: string}) => new Response(String(env.LOCAL_VALUE))}\n`,
      },
      wrangler: 'real',
      workers: [{name: 'orders'}],
    })
    const port = 19_417

    const running = startCli(fixture, ['worker', 'orders', '-c', 'dev', '-p', String(port)])
    try {
      const deadline = Date.now() + 90_000
      let body: string | undefined
      while (body === undefined && Date.now() < deadline) {
        try {
          body = await (await fetch(`http://127.0.0.1:${port}/`)).text()
        } catch {
          await new Promise((resolve) => {
            setTimeout(resolve, 250)
          })
        }
      }

      expect(body).toBe('from-dot-env')
      const copies = listTree(join(fixture.root, '.monocf')).filter((path) => path.endsWith('/.env'))
      expect(copies).toHaveLength(1)
    } finally {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(running.child.pid), '/T', '/F'], {stdio: 'ignore'})
      } else {
        running.child.kill('SIGTERM')
      }

      await running.done
    }

    // On Windows the kill above leaves the run directory for the next run to remove, as any kill from outside does.
    if (process.platform !== 'win32') expect(existsSync(join(fixture.root, '.monocf', 'runs'))).toBe(false)
    expect(readFileSync(join(fixture.worker('orders'), '.env'), 'utf8')).toContain('from-dot-env')
  })
})
