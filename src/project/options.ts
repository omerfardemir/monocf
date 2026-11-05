import {dirname, join, resolve} from 'node:path'

import {ConfigError} from '../config/types.js'
import {nodeReader, type FileReader, type ProjectFile} from './load.js'

export const DEFAULT_BASE_CONFIG = 'base.wrangler.jsonc'
const DEFAULT_PORT = 8787

export interface OptionFlags {
  all?: boolean
  baseConfig?: string
  deployBindings?: boolean
  deployFromVersionId?: string
  deploySecrets?: boolean
  env?: string
  fromVersion?: boolean
  message?: string
  minify?: boolean
  port?: number
  rootDir?: string
  workersDirName?: string
}

export interface Options {
  all: boolean
  /** Absolute path of the base config, if the project has one. */
  baseConfigPath?: string
  deployBindings: boolean
  deployFromVersionId?: string
  deploySecrets: boolean
  env?: string
  fromVersion: boolean
  message?: string
  minify: boolean
  port: number
  rootDir: string
  variables: Record<string, string>
  workersDirName: string
}

export interface OptionSources {
  /** Path of the project config, which anchors its relative rootDir. */
  configPath?: string
  cwd: string
  file?: ProjectFile
  flags?: OptionFlags
  reader?: FileReader
}

const STRING_FLAGS: [keyof OptionFlags, string][] = [
  ['baseConfig', '--base-config'],
  ['deployFromVersionId', '--deploy-from-version-id'],
  ['env', '--env'],
  ['message', '--message'],
  ['rootDir', '--root-dir'],
  ['workersDirName', '--workers-dir-name'],
]

/** A blank value usually means an unset variable in a script. It must never act like the flag wasn't given. */
function rejectBlankFlags(flags: OptionFlags): void {
  for (const [key, name] of STRING_FLAGS) {
    const value = flags[key]
    if (typeof value === 'string' && value.trim() === '') throw new ConfigError(`${name} must not be empty.`)
  }
}

function resolveRootDir({configPath, cwd, file, flags}: OptionSources): string {
  if (flags?.rootDir !== undefined) return resolve(cwd, flags.rootDir)
  const anchor = configPath ? dirname(configPath) : cwd
  return file?.rootDir ? resolve(anchor, file.rootDir) : anchor
}

function precedence<T>(flag: T | undefined, fromFile: T | undefined, fallback: T): T {
  return flag ?? fromFile ?? fallback
}

/** Combines flags > project file > defaults into one set of options. */
export function resolveOptions(sources: OptionSources): Options {
  const {file = {}, flags = {}, reader = nodeReader} = sources
  rejectBlankFlags(flags)
  const rootDir = resolveRootDir(sources)
  const defaultBase = reader.exists(join(rootDir, DEFAULT_BASE_CONFIG)) ? DEFAULT_BASE_CONFIG : undefined
  const baseConfig = precedence(flags.baseConfig, file.baseConfig, defaultBase)

  return {
    all: precedence(flags.all, undefined, false),
    baseConfigPath: baseConfig ? join(rootDir, baseConfig) : undefined,
    deployBindings: precedence(flags.deployBindings, file.deployBindings, false),
    deployFromVersionId: flags.deployFromVersionId,
    deploySecrets: precedence(flags.deploySecrets, file.deploySecrets, false),
    env: flags.env,
    fromVersion: precedence(flags.fromVersion, undefined, false),
    message: flags.message,
    minify: precedence(flags.minify, file.minify, false),
    port: precedence(flags.port, file.port, DEFAULT_PORT),
    rootDir,
    variables: Object.fromEntries(Object.entries(file.variables ?? {}).map(([key, value]) => [key, String(value)])),
    workersDirName: precedence(flags.workersDirName, file.workersDirName, ''),
  }
}
