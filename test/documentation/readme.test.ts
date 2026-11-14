import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {beforeAll, describe, expect, it} from 'vitest'

import {CHECK_RULES, PLAN_REASONS} from '../../src/explain/registry.js'
import {flagsNoCommandTakes, loadCommands, repoRoot, unknownFlagsInInvocations, type CommandClass} from '../helpers/commands.js'

const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8').replaceAll('\r\n', '\n')

let commands = new Map<string, CommandClass>()

beforeAll(async () => {
  commands = await loadCommands()
})

/** The README with the generated reference left out, so this checks what a person wrote. */
function written(): string {
  return readme.replace(/<!-- commands -->[\s\S]*<!-- commandsstop -->/, '')
}

function section(title: string): string {
  const start = readme.indexOf(`\n## ${title}\n`)
  const end = readme.indexOf('\n## ', start + 1)
  return readme.slice(start, end)
}

/** The backticked names in one column of every table in the text, as `| \`name\` |` rows. */
function tableColumn(text: string, column: number): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('|---'))
    .flatMap((line) => [...(line.split('|')[column + 1] ?? '').matchAll(/`([a-z-]+)`/g)].map(([, name]) => name))
}

describe('README', () => {
  it('names only commands that exist, and flags they take', () => {
    expect(written().match(/\bmonocf [a-z]/g)!.length).toBeGreaterThan(20)
    expect(unknownFlagsInInvocations(commands, written())).toEqual([])
  })

  it('names only flags that some command takes', () => {
    // Flags of wrangler or git that the guide names, not monocf's, oclif's own --help, and the `--no-` prefix itself.
    const others = new Set(['--help', '--no-', '--no-tags', '--depth', '--secrets-file', '--var', '--save-dev', '--short'])
    expect(flagsNoCommandTakes(commands, written(), others)).toEqual([])
  })

  it('has a generated entry for every command', () => {
    const generated = /<!-- commands -->([\s\S]*)<!-- commandsstop -->/.exec(readme)?.[1] ?? ''
    for (const id of commands.keys()) expect(generated).toContain(`## \`monocf ${id}`)
    for (const [id, {flags = {}}] of commands) {
      const start = generated.indexOf(`## \`monocf ${id}`)
      const end = generated.indexOf('\n## `', start + 1)
      const body = generated.slice(start, end === -1 ? undefined : end)
      for (const name of Object.keys(flags)) expect(body, `${id} --${name}`).toContain(name)
    }
  })

  it('states every field of monocf.config.json', () => {
    const source = readFileSync(join(repoRoot, 'src', 'project', 'load.ts'), 'utf8')
    const block = /const KEY_TYPES[^{]*=\s*{([^}]*)}/.exec(source)![1]
    const fields = [...block.matchAll(/^\s*(\$?\w+):/gm)].map(([, field]) => field)
    expect(fields.length).toBeGreaterThan(5)
    for (const field of fields) expect(readme).toContain(`| \`${field}\` |`)
  })

  it('links only to sections that exist', () => {
    const anchors = new Set(
      [...readme.matchAll(/^#{1,6} (.+)$/gm)].map(([, title]) =>
        title.toLowerCase().replaceAll(/[^\w\s-]/g, '').trim().replaceAll(/\s/g, '-'),
      ),
    )
    const links = [...written().matchAll(/\]\(#([^)]+)\)/g)].map(([, anchor]) => anchor)
    expect(links.length).toBeGreaterThan(5)
    expect(links.filter((anchor) => !anchors.has(anchor))).toEqual([])
  })
})

describe('README and the registry that monocf explain reads', () => {
  it('names every plan reason in its table of redeploys, and no other', () => {
    const redeploys = section('What causes a redeploy')
    const named = new Set(tableColumn(redeploys, 2))
    expect([...named].filter((reason) => !Object.hasOwn(PLAN_REASONS, reason))).toEqual([])
    const mentioned = Object.keys(PLAN_REASONS).filter((reason) => named.has(reason) || redeploys.includes(`\`${reason}\``))
    expect(mentioned).toEqual(Object.keys(PLAN_REASONS))
  })

  it('names only check rules that exist', () => {
    const rules = tableColumn(readme, 0).filter((name) => name.startsWith('ignored-'))
    expect(rules.length).toBeGreaterThan(3)
    expect(rules.filter((rule) => !Object.hasOwn(CHECK_RULES, rule))).toEqual([])
  })
})
