import type {Command} from '@oclif/core'

import {SCHEMA_VERSION} from '../report/events.js'
import type {ExitCodes, Safety} from './base-command.js'

/** What `monocf commands --json` says of one command: enough to pick it and call it, without parsing `--help`. */
export interface CommandInfo {
  args: {description?: string; name: string; required: boolean}[]
  /** Deprecated commands still run, and say what replaces them. */
  deprecated?: true
  description?: string
  examples: string[]
  exitCodes: ExitCodes
  flags: FlagInfo[]
  id: string
  requiredFlags: string[]
  safety: Safety
  summary?: string
}

export interface FlagInfo {
  allowNo?: true
  char?: string
  default?: unknown
  description?: string
  exclusive?: string[]
  name: string
  options?: readonly string[]
  required: boolean
  type: 'boolean' | 'option'
}

/** What oclif keeps of a command, from the manifest or the class, with the statics every monocf command declares. */
type Loadable = Command.Loadable & {exitCodes?: ExitCodes; safety?: Safety}

function firstSentence(text: string | undefined): string | undefined {
  return text?.split(/(?<=\.)\s|\n/)[0]
}

function flagInfo(flag: Command.Flag.Cached): FlagInfo {
  return {
    ...(flag.type === 'boolean' && flag.allowNo && {allowNo: true as const}),
    ...(flag.char !== undefined && {char: flag.char}),
    ...(flag.default !== undefined && {default: flag.default}),
    ...(flag.description !== undefined && {description: flag.description}),
    ...(flag.exclusive?.length && {exclusive: flag.exclusive}),
    name: flag.name,
    ...(flag.type === 'option' && flag.options !== undefined && {options: flag.options}),
    required: flag.required === true,
    type: flag.type,
  }
}

export function commandInfo(command: Loadable, bin: string): CommandInfo {
  const id = command.id.replaceAll(':', ' ')
  const flags = Object.values(command.flags)
    .filter((flag) => !flag.hidden)
    .map((flag) => flagInfo(flag))
    .sort((a, b) => a.name.localeCompare(b.name))
  const summary = command.summary ?? firstSentence(command.description)
  const examples = (command.examples ?? []).map((example) =>
    (typeof example === 'string' ? example : example.command).replaceAll('<%= config.bin %>', bin).replaceAll('<%= command.id %>', id),
  )
  return {
    args: Object.values(command.args).map(({description, name, required}) => ({
      ...(description !== undefined && {description}),
      name,
      required: required === true,
    })),
    ...(command.description?.startsWith('Deprecated') && {deprecated: true as const}),
    ...(command.description !== undefined && {description: command.description}),
    examples,
    exitCodes: command.exitCodes ?? {},
    flags,
    id,
    requiredFlags: flags.filter(({required}) => required).map(({name}) => name),
    safety: command.safety!,
    ...(summary !== undefined && {summary}),
  }
}

/** Built from what oclif loaded, so it's the same whether the manifest ships or the commands were read from their files. */
export function describeCommands(commands: Loadable[], bin: string): {commands: CommandInfo[]; schemaVersion: number} {
  const visible = commands.filter((command) => !command.hidden).sort((a, b) => a.id.localeCompare(b.id))
  return {commands: visible.map((command) => commandInfo(command, bin)), schemaVersion: SCHEMA_VERSION}
}

export function formatCommands({commands}: {commands: CommandInfo[]}): string {
  const width = Math.max(...commands.map(({id}) => id.length))
  return commands.map(({id, safety, summary}) => `${id.padEnd(width)}  ${safety.padEnd(17)}  ${summary ?? ''}\n`).join('')
}
