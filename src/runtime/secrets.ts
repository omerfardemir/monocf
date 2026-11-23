import dotenv from 'dotenv'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

import {ConfigError} from '../config/types.js'

export type EnvValues = Record<string, string>

function exactFile(dir: string, env?: string): string {
  return join(dir, env === undefined ? '.dev.vars' : `.dev.vars.${env}`)
}

function readValues(path: string): EnvValues {
  return existsSync(path) ? dotenv.parse(readFileSync(path, 'utf8')) : {}
}

/**
 * Stops an upload that has no file for exactly this env: the worker's, or the root's. Falling back to another env's
 * file would put development values into production.
 */
export function requireSecretsFile(workerPath: string, rootDir: string, env?: string): void {
  const worker = exactFile(workerPath, env)
  const root = exactFile(rootDir, env)
  if (!existsSync(worker) && !existsSync(root)) {
    throw new ConfigError(
      `Secrets file not found at ${worker} or ${root}. Uploading secrets requires one of these exact files, with no fallback to another environment.`,
      {code: 'secrets-file-missing'},
    )
  }
}

/** The values an upload sends, from the exact files only. The worker's values win. */
export function readSecrets(workerPath: string, rootDir: string, env?: string): EnvValues {
  return {...readValues(exactFile(rootDir, env)), ...readValues(exactFile(workerPath, env))}
}

/**
 * `user-service` reads `USER_SERVICE__STRIPE_KEY` before `STRIPE_KEY`. Upper case with `_`, because a GitHub secret's name takes
 * nothing else and GitHub stores it in upper case.
 */
export function workerVariablePrefix(dir: string): string {
  return `${dir.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}__`
}

/**
 * A worker's own variable comes first, so one worker can get a value that differs from what the others share. This is the one
 * place that order is written down.
 */
export function variablesFor(dir: string, name: string): [own: string, shared: string] {
  return [`${workerVariablePrefix(dir)}${name}`, name]
}

/** Two workers with one prefix would each read the other's variables, and neither could be told apart from the other. */
export function assertDistinctPrefixes(dirs: string[]): void {
  const byPrefix = new Map<string, string[]>()
  for (const dir of dirs) {
    const prefix = workerVariablePrefix(dir)
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), dir])
  }

  const clashes = [...byPrefix].filter(([, same]) => same.length > 1)
  if (clashes.length === 0) return
  const list = clashes.map(([prefix, same]) => `${same.join(', ')} all read ${prefix}*`).join('; ')
  throw new ConfigError(`Workers share a variable prefix: ${list}. Rename a worker's directory so each prefix is its own.`, {
    code: 'secret-prefix-collision',
  })
}

export interface EnvSecrets {
  /** With the variables tried, so an error can say what to set without the caller knowing the order. */
  missing: {name: string; tried: string[]}[]
  values: EnvValues
  /** Each name's variable, so a run can say where a value came from without printing it. */
  variables: Record<string, string>
}

/**
 * The values for a worker's declared names. Only declared names are read: which variables become secrets is the project's
 * choice, made where it declares them. An empty value counts as unset, as GitHub Actions gives an empty string for a secret
 * that doesn't exist in the job's environment.
 */
export function readSecretsFromEnv(dir: string, names: string[], environment: NodeJS.ProcessEnv): EnvSecrets {
  const result: EnvSecrets = {missing: [], values: {}, variables: {}}
  for (const name of names) {
    const tried = variablesFor(dir, name)
    const variable = tried.find((candidate) => (environment[candidate] ?? '') !== '')
    if (variable === undefined) {
      result.missing.push({name, tried})
      continue
    }

    result.values[name] = environment[variable]!
    result.variables[name] = variable
  }

  return result
}

function localFile(dir: string, env?: string): string {
  const exact = exactFile(dir, env)
  return existsSync(exact) ? exact : join(dir, '.dev.vars')
}

/**
 * The values for local dev, which may fall back to `.dev.vars` when the env has no file of its own. Each directory
 * falls back by itself, and the worker's values win. Returns undefined when neither directory has a file.
 */
export function readLocalVars(workerPath: string, rootDir: string, env?: string): EnvValues | undefined {
  const worker = localFile(workerPath, env)
  const root = localFile(rootDir, env)
  if (!existsSync(worker) && !existsSync(root)) return undefined
  return {...readValues(root), ...readValues(worker)}
}

function candidates(value: string): string[] {
  return [
    `'${value}'`,
    `\`${value}\``,
    `"${value.replaceAll('\r', String.raw`\r`).replaceAll('\n', String.raw`\n`)}"`,
    value,
  ]
}

function serializeEntry(key: string, value: string): string {
  const line = candidates(value)
    .map((candidate) => `${key}=${candidate}`)
    .find((candidate) => dotenv.parse(candidate)[key] === value)
  if (line === undefined) {
    throw new ConfigError(`The value of ${key} can't be written to a .dev.vars file without changing it.`, {code: 'secret-value-invalid'})
  }

  return line
}

/** Writes values in a form dotenv reads back unchanged, or fails. No quoting style suits every value. */
export function serializeDevVars(values: EnvValues): string {
  const text = Object.entries(values)
    .map(([key, value]) => `${serializeEntry(key, value)}\n`)
    .join('')

  const parsed = dotenv.parse(text)
  for (const [key, value] of Object.entries(values)) {
    if (parsed[key] !== value) {
      throw new ConfigError(`The value of ${key} can't be written to a .dev.vars file without changing it.`, {code: 'secret-value-invalid'})
    }
  }

  return text
}
