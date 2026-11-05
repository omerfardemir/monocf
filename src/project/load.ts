import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {parse, printParseErrorCode, type ParseError} from 'jsonc-parser'

import {ConfigError, isPlainObject} from '../config/types.js'

export const CONFIG_FILE = 'monocf.config.json'

export interface FileReader {
  exists(path: string): boolean
  readDir(path: string): string[]
  readFile(path: string): string
}

export const nodeReader: FileReader = {
  exists: (path) => existsSync(path),
  readDir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
}

export interface ProjectFile {
  $schema?: string
  baseConfig?: string
  deployBindings?: boolean
  deploySecrets?: boolean
  minify?: boolean
  port?: number
  rootDir?: string
  variables?: Record<string, boolean | number | string>
  workersDirName?: string
}

const KEY_TYPES: Record<keyof ProjectFile, 'boolean' | 'number' | 'object' | 'string'> = {
  $schema: 'string',
  baseConfig: 'string',
  deployBindings: 'boolean',
  deploySecrets: 'boolean',
  minify: 'boolean',
  port: 'number',
  rootDir: 'string',
  variables: 'object',
  workersDirName: 'string',
}

/** Parses JSONC the way wrangler reads a config: comments and trailing commas are fine. */
export function parseJsonc(text: string, file: string): unknown {
  const errors: ParseError[] = []
  const value = parse(text, errors, {allowTrailingComma: true})
  if (errors.length > 0) {
    throw new ConfigError(`Invalid JSON at offset ${errors[0].offset}: ${printParseErrorCode(errors[0].error)}`, file)
  }

  return value
}

/** Searches up from a directory for the project config. */
export function findConfigFile(startDir: string, reader: FileReader = nodeReader): string | undefined {
  let dir = startDir
  while (true) {
    const candidate = join(dir, CONFIG_FILE)
    if (reader.exists(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function validateVariables(variables: object, file: string): void {
  for (const [key, value] of Object.entries(variables)) {
    if (!['boolean', 'number', 'string'].includes(typeof value)) {
      throw new ConfigError(`"variables.${key}" must be a string, number or boolean.`, file)
    }
  }
}

/** Parses and validates project config text. Unknown keys are errors, so a typo can't silently disable something. */
export function parseProjectFile(text: string, file: string): ProjectFile {
  const value = parseJsonc(text, file)
  if (!isPlainObject(value)) throw new ConfigError('The config must be an object.', file)

  for (const [key, entry] of Object.entries(value)) {
    const expected = KEY_TYPES[key as keyof ProjectFile]
    if (!Object.hasOwn(KEY_TYPES, key)) {
      throw new ConfigError(`Unknown key "${key}". Known keys: ${Object.keys(KEY_TYPES).join(', ')}.`, file)
    }

    if (expected === 'object' ? !isPlainObject(entry) : typeof entry !== expected) {
      throw new ConfigError(`"${key}" must be of type ${expected}.`, file)
    }
  }

  if (isPlainObject(value.variables)) validateVariables(value.variables, file)
  return value as ProjectFile
}

export function loadProjectFile(file: string, reader: FileReader = nodeReader): ProjectFile {
  return parseProjectFile(reader.readFile(file), file)
}
