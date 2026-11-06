import {readFileSync, readdirSync} from 'node:fs'
import {dirname, join, relative, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {beforeAll, describe, expect, it} from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8').replaceAll('\r\n', '\n')
const commandsDir = join(repoRoot, 'dist', 'commands')

interface Flag {
  allowNo?: boolean
  char?: string
}

const commands = new Map<string, Record<string, Flag>>()

/** `plan/index.js` is `plan`, and `secrets/check.js` is `secrets check`. */
function commandId(file: string): string {
  return relative(commandsDir, file).replace(/\.js$/, '').split(sep).filter((part) => part !== 'index').join(' ')
}

beforeAll(async () => {
  const files = (readdirSync(commandsDir, {recursive: true}) as string[]).filter((file) => file.endsWith('.js'))
  for (const file of files) {
    const path = join(commandsDir, file)
    const {default: command} = await import(pathToFileURL(path).href)
    commands.set(commandId(path), command.flags ?? {})
  }
})

/** The README with the generated reference left out, so this checks what a person wrote. */
function written(): string {
  return readme.replace(/<!-- commands -->[\s\S]*<!-- commandsstop -->/, '')
}

function invocations(): string[] {
  return [...written().matchAll(/\bmonocf ((?:[^\n`#|]|`(?=\S))+)/g)].map(([, rest]) => rest.trim()).filter((rest) => /^[a-z]+\b/.test(rest))
}

function commandOf(line: string): string | undefined {
  const [first, second] = line.split(/\s+/)
  return commands.has(`${first} ${second}`) ? `${first} ${second}` : commands.has(first) ? first : undefined
}

function knownFlag(flags: Record<string, Flag>, token: string): boolean {
  const name = token.replace(/^-+/, '').split('=')[0]
  if (token.startsWith('--')) {
    return Object.hasOwn(flags, name) || (name.startsWith('no-') && flags[name.slice(3)]?.allowNo === true)
  }

  return Object.values(flags).some(({char}) => char === name)
}

describe('README', () => {
  it('names only commands that exist, and flags they take', () => {
    const found = invocations()
    expect(found.length).toBeGreaterThan(20)
    const problems: string[] = []
    for (const line of found) {
      // Words such as "monocf finds it" are prose: only something a command starts counts.
      const command = commandOf(line)
      if (command !== undefined) {
        const tokens = line.split(/\s+/).filter((token) => /^--?[a-zA-Z]/.test(token))
        const unknown = tokens.filter((token) => !knownFlag(commands.get(command)!, token))
        if (unknown.length > 0) problems.push(`monocf ${line}: ${unknown.join(', ')}`)
      }
    }

    expect(problems).toEqual([])
  })

  it('names only flags that some command takes', () => {
    const all = [...commands.values()]
    const flags = [...written().matchAll(/(?<![\w-])--[a-z][a-zA-Z-]+/g)].map(([flag]) => flag)
    // Flags of wrangler or git that the guide names, not monocf's, and the `--no-` prefix itself.
    const others = new Set(['--no-', '--no-tags', '--depth', '--secrets-file', '--var', '--save-dev', '--short'])
    const unknown = flags.filter((flag) => !others.has(flag) && !all.some((each) => knownFlag(each, flag)))
    expect(unknown).toEqual([])
  })

  it('has a generated entry for every command', () => {
    const generated = /<!-- commands -->([\s\S]*)<!-- commandsstop -->/.exec(readme)?.[1] ?? ''
    for (const id of commands.keys()) expect(generated).toContain(`## \`monocf ${id}`)
    for (const [id, flags] of commands) {
      const start = generated.indexOf(`## \`monocf ${id}`)
      const end = generated.indexOf('\n## `', start + 1)
      const section = generated.slice(start, end === -1 ? undefined : end)
      for (const name of Object.keys(flags)) expect(section, `${id} --${name}`).toContain(name)
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
