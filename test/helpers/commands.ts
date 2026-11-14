import {readdirSync} from 'node:fs'
import {dirname, join, relative, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const commandsDir = join(repoRoot, 'dist', 'commands')

export interface Flag {
  allowNo?: boolean
  char?: string
}

/** A command class as built, with the statics every monocf command declares. */
export interface CommandClass {
  exitCodes?: Record<string, string>
  flags?: Record<string, Flag>
  hidden?: boolean
  safety?: string
}

/** `plan/index.js` is `plan`, and `secrets/check.js` is `secrets check`. */
function commandId(file: string): string {
  return relative(commandsDir, file).replace(/\.js$/, '').split(sep).filter((part) => part !== 'index').join(' ')
}

/** Every built command by its id, read from dist, which the test setup builds. */
export async function loadCommands(): Promise<Map<string, CommandClass>> {
  const commands = new Map<string, CommandClass>()
  const files = (readdirSync(commandsDir, {recursive: true}) as string[]).filter((file) => file.endsWith('.js'))
  for (const file of files) {
    const path = join(commandsDir, file)
    const {default: command} = await import(pathToFileURL(path).href)
    commands.set(commandId(path), command)
  }

  return commands
}

export function knownFlag(flags: Record<string, Flag>, token: string): boolean {
  const name = token.replace(/^-+/, '').split('=')[0]
  if (token.startsWith('--')) {
    return Object.hasOwn(flags, name) || (name.startsWith('no-') && flags[name.slice(3)]?.allowNo === true)
  }

  return Object.values(flags).some(({char}) => char === name)
}

/** What follows `monocf` each time a text names a command, up to the end of the code span or line. A backtick before a word goes on. */
export function invocations(text: string): string[] {
  return [...text.matchAll(/\bmonocf ((?:[^\n`#|]|`(?=[\w-]))+)/g)].map(([, rest]) => rest.trim()).filter((rest) => /^[a-z]+\b/.test(rest))
}

export function commandOf(commands: Map<string, CommandClass>, line: string): string | undefined {
  const [first, second] = line.split(/\s+/)
  return commands.has(`${first} ${second}`) ? `${first} ${second}` : commands.has(first) ? first : undefined
}

/** Each `monocf <command> --flag` in the text whose flag that command doesn't take. Prose such as "monocf finds it" names no command. */
export function unknownFlagsInInvocations(commands: Map<string, CommandClass>, text: string): string[] {
  const problems: string[] = []
  for (const line of invocations(text)) {
    const command = commandOf(commands, line)
    if (command !== undefined) {
      const tokens = line.split(/\s+/).filter((token) => /^--?[a-zA-Z]/.test(token))
      const unknown = tokens.filter((token) => !knownFlag(commands.get(command)!.flags ?? {}, token))
      if (unknown.length > 0) problems.push(`monocf ${line}: ${unknown.join(', ')}`)
    }
  }

  return problems
}

/** Each `--flag` in the text that no command takes, leaving out the ones in `others`. */
export function flagsNoCommandTakes(commands: Map<string, CommandClass>, text: string, others: Set<string>): string[] {
  const all = [...commands.values()]
  const flags = [...text.matchAll(/(?<![\w-])--[a-z][a-zA-Z-]+/g)].map(([flag]) => flag)
  return flags.filter((flag) => !others.has(flag) && !all.some((each) => knownFlag(each.flags ?? {}, flag)))
}
