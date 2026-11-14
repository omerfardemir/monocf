import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {beforeAll, describe, expect, it} from 'vitest'

import {formatCodesMarkdown, formatReadmeTables, replaceMarked} from '../../src/explain/markdown.js'
import {CHECK_RULES, ERROR_CODES, PLAN_REASONS} from '../../src/explain/registry.js'
import {loadCommands, repoRoot, type CommandClass} from '../helpers/commands.js'
import {createFixture, runCli} from '../helpers/harness.js'

const SAFETY = ['offline', 'reads-cloudflare', 'writes-cloudflare']

let commands = new Map<string, CommandClass>()

beforeAll(async () => {
  commands = await loadCommands()
})

function sourceFiles(): string[] {
  const dir = join(repoRoot, 'src')
  return (readdirSync(dir, {recursive: true}) as string[]).filter((file) => file.endsWith('.ts')).map((file) => join(dir, file))
}

describe('every command', () => {
  it('declares its own safety and exit codes', () => {
    expect(commands.size).toBeGreaterThan(15)
    for (const [id, command] of commands) {
      // Its own, as the manifest that ships keeps only a command's own statics.
      expect(Object.hasOwn(command, 'safety'), id).toBe(true)
      expect(SAFETY, id).toContain(command.safety)
      expect(Object.hasOwn(command, 'exitCodes'), id).toBe(true)
      expect(command.exitCodes!['0'], id).toBeDefined()
    }
  })
})

describe('monocf commands', () => {
  it('lists every command, with its flags, required flags, exit codes and safety', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['commands', '--json'], {noCalls: true})

    expect(result.exitCode).toBe(0)
    const {commands: listed, schemaVersion} = JSON.parse(result.stdout)
    expect(schemaVersion).toBe(1)
    expect(listed.map(({id}: {id: string}) => id).sort()).toEqual([...commands.keys()].sort())
    const plan = listed.find(({id}: {id: string}) => id === 'plan')
    expect(plan).toMatchObject({requiredFlags: ['env', 'state'], safety: 'reads-cloudflare'})
    expect(plan.exitCodes['1']).toContain('Drift')
    expect(plan.flags.find(({name}: {name: string}) => name === 'on-drift')).toMatchObject({default: 'warn', options: ['warn', 'fail'], type: 'option'})
    expect(plan.examples[0]).toMatch(/^monocf plan /)
    expect(listed.find(({id}: {id: string}) => id === 'secrets deploy')).toMatchObject({safety: 'writes-cloudflare'})
    // wrangler dev runs without --local, so a remote binding reaches Cloudflare.
    expect(listed.find(({id}: {id: string}) => id === 'dev')).toMatchObject({safety: 'reads-cloudflare'})
    expect(listed.find(({id}: {id: string}) => id === 'worker')).toMatchObject({deprecated: true})
  })

  it('prints a line per command without --json', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['commands'], {noCalls: true})

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^apply +writes-cloudflare +Run a plan/m)
    expect(result.stdout.trim().split('\n')).toHaveLength(commands.size)
  })
})

describe('monocf explain', () => {
  it.each([
    ['state-scheme-unsupported', 'error'],
    ['self-binding', 'check-rule'],
    ['provider-recreated', 'plan-reason'],
  ])('explains %s', async (code, kind) => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['explain', code, '--json'], {noCalls: true})

    expect(result.exitCode).toBe(0)
    const {entries} = JSON.parse(result.stdout)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({code, kind})
    expect(entries[0].meaning.length).toBeGreaterThan(10)
  })

  it('gives every kind a code has', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['explain', 'unknown-placeholder'], {noCalls: true})

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('unknown-placeholder (error code, exit 2)')
    expect(result.stdout).toContain('unknown-placeholder (check rule, error)')
  })

  it('lists every code with none given', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['explain', '--json'], {noCalls: true})

    const {entries} = JSON.parse(result.stdout)
    const total = Object.keys(ERROR_CODES).length + Object.keys(CHECK_RULES).length + Object.keys(PLAN_REASONS).length
    expect(entries).toHaveLength(total)
  })

  it('refuses a code it does not know', async () => {
    const fixture = createFixture({workers: [{name: 'orders'}]})

    const result = await runCli(fixture, ['explain', 'nope', '--json'], {noCalls: true})

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({code: 'unknown-code', type: 'error'})
  })
})

describe('the registry', () => {
  it.each([
    ['docs/json-output.md', () => ({codes: formatCodesMarkdown()})],
    ['README.md', formatReadmeTables],
  ])('is what %s lists. Run npm run docs after npm run build if not', (file, tables) => {
    const text = readFileSync(join(repoRoot, file), 'utf8').replaceAll('\r\n', '\n')
    expect(replaceMarked(text, tables())).toBe(text)
  })

  it('has no error code that nothing raises', () => {
    const source = sourceFiles()
      .filter((file) => !file.endsWith(join('explain', 'registry.ts')))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(Object.keys(ERROR_CODES).filter((code) => !source.includes(`'${code}'`))).toEqual([])
  })

  it('has no check rule that nothing reports', () => {
    const source = sourceFiles()
      .filter((file) => !file.endsWith(join('explain', 'registry.ts')))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(Object.keys(CHECK_RULES).filter((rule) => !source.includes(`'${rule}'`))).toEqual([])
  })

  it('gives every error code something to do', () => {
    expect(Object.entries(ERROR_CODES).filter(([, {next}]) => next === undefined)).toEqual([])
  })
})
