import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {locateWrangler} from '../../src/wrangler/locate.js'
import {spawnWrangler} from '../../src/wrangler/process.js'
import {createFixture} from '../helpers/harness.js'

describe('captured output', () => {
  const saved = process.env.FAKE_WRANGLER_RULES
  const dirs: string[] = []

  afterEach(() => {
    if (saved === undefined) delete process.env.FAKE_WRANGLER_RULES
    else process.env.FAKE_WRANGLER_RULES = saved
    for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true})
  })

  it('keeps a multi-byte character that a pipe chunk ends inside', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'monocf-process-'))
    dirs.push(dir)
    // One leading byte, so the two-byte characters straddle every even chunk size.
    const stdout = `a${'ş'.repeat(100_000)}`
    const rules = join(dir, 'rules.json')
    writeFileSync(rules, JSON.stringify([{command: 'whoami', stdout}]))
    process.env.FAKE_WRANGLER_RULES = rules
    const wrangler = locateWrangler(createFixture({workers: [{name: 'orders'}]}).root)

    const result = await spawnWrangler(wrangler, ['whoami'], {cwd: dir, mode: 'capture'}).done

    expect(result.stdout).toBe(stdout)
  })
})
