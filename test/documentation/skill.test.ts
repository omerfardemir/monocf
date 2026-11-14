import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {beforeAll, describe, expect, it} from 'vitest'

import {ERROR_CODES, PLAN_REASONS} from '../../src/explain/registry.js'
import {commandOf, flagsNoCommandTakes, loadCommands, repoRoot, unknownFlagsInInvocations, type CommandClass} from '../helpers/commands.js'

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8').replaceAll('\r\n', '\n')
const skill = read('skills/monocf/SKILL.md')
const agents = read('AGENTS.md')

let commands = new Map<string, CommandClass>()

beforeAll(async () => {
  commands = await loadCommands()
})

/** Besides codes, a recovery can name a command or the `blocked` action of a plan step. */
function knownName(name: string): boolean {
  return Object.hasOwn(ERROR_CODES, name) || Object.hasOwn(PLAN_REASONS, name) || commands.has(name) || name === 'blocked'
}

describe.each([
  ['the skill', skill],
  ['AGENTS.md', agents],
])('%s', (_, text) => {
  it('names only commands that exist', () => {
    const spans = [...text.matchAll(/`monocf ([^`]+)`/g)].map(([, rest]) => rest)
    expect(spans.filter((rest) => !rest.startsWith('<') && commandOf(commands, rest) === undefined)).toEqual([])
  })

  it('names only flags the command takes', () => {
    expect(unknownFlagsInInvocations(commands, text)).toEqual([])
    expect(flagsNoCommandTakes(commands, text, new Set(['--help']))).toEqual([])
  })
})

describe('the skill', () => {
  it('says what each command does to Cloudflare, as the command says itself', () => {
    const listed: Record<string, string[]> = {}
    for (const [, safety, names] of skill.matchAll(/^- `(offline|reads-cloudflare|writes-cloudflare)`: (.+)$/gm)) {
      listed[safety] = [...names.split(/\.(?:\s|$)/)[0].matchAll(/`([a-z ]+)`/g)].map(([, name]) => name).sort()
    }

    const declared: Record<string, string[]> = {}
    for (const [id, {safety}] of commands) declared[safety!] = [...(declared[safety!] ?? []), id].sort()
    expect(listed).toEqual(declared)
  })

  it('names only codes that monocf explain knows', () => {
    const recoveries = skill.slice(skill.indexOf('\n## Usual recoveries\n'))
    const named = [...recoveries.matchAll(/^- (.+?):/gm)].flatMap(([, codes]) => [...codes.matchAll(/`([a-z-]+)`/g)].map(([, code]) => code))
    expect(named.length).toBeGreaterThan(10)
    expect(named.filter((name) => !knownName(name))).toEqual([])
  })

  it('ships with the package, under a name agents look for', () => {
    expect(skill).toMatch(/^---\nname: monocf\ndescription: .{40,}\n---\n/)
    expect(JSON.parse(read('package.json')).files).toContain('./skills/monocf/SKILL.md')
  })
})
