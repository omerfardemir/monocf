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
    )
  }
}

/** The values an upload sends, from the exact files only. The worker's values win. */
export function readSecrets(workerPath: string, rootDir: string, env?: string): EnvValues {
  return {...readValues(exactFile(rootDir, env)), ...readValues(exactFile(workerPath, env))}
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
    throw new ConfigError(`The value of ${key} can't be written to a .dev.vars file without changing it.`)
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
      throw new ConfigError(`The value of ${key} can't be written to a .dev.vars file without changing it.`)
    }
  }

  return text
}
