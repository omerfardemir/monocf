import dotenv from 'dotenv'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {envSection} from '../config/resolve.js'
import {isPlainObject, type ResolvedWorker} from '../config/types.js'

export const SECRETS_EXAMPLE_FILE = '.dev.vars.example'

/** Names only: the values in the example are dropped as soon as the file is parsed. */
function exampleNames(path: string): string[] | undefined {
  try {
    return Object.keys(dotenv.parse(readFileSync(join(path, SECRETS_EXAMPLE_FILE), 'utf8')))
  } catch {
    return undefined
  }
}

function requiredNames(config: ResolvedWorker['config'], env: string | undefined): string[] | undefined {
  const {secrets} = envSection(config, env)
  if (!isPlainObject(secrets) || !Array.isArray(secrets.required)) return undefined
  return secrets.required.filter((name): name is string => typeof name === 'string')
}

/**
 * The secret names a worker declares: `secrets.required` for the env, which wrangler doesn't inherit into an env, and the keys of
 * its `.dev.vars.example`. Undefined when it has neither, so a caller can tell "declares none" from "declares an empty list".
 */
export function declaredSecretNames({config, path}: Pick<ResolvedWorker, 'config' | 'path'>, env: string | undefined): string[] | undefined {
  const required = requiredNames(config, env)
  const example = exampleNames(path)
  if (required === undefined && example === undefined) return undefined
  return [...new Set([...(required ?? []), ...(example ?? [])])].sort()
}
