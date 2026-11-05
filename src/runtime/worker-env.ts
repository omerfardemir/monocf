import dotenv from 'dotenv'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

/** The files wrangler loads at startup, from its working directory, later ones first in precedence. */
export function envFileNames(env?: string): string[] {
  return ['.env', '.env.local', ...(env === undefined ? [] : [`.env.${env}`, `.env.${env}.local`])]
}

function readParsed(path: string): Record<string, string> {
  try {
    return dotenv.parse(readFileSync(path, 'utf8'))
  } catch {
    // Wrangler only logs this at debug level, whether the file is missing or can't be read.
    return {}
  }
}

const REFERENCE = /(?<!\\)\${([^{}]+)}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/
const OPERATOR = /:\+|\+|:-|-/

/** What dotenv-expand does inside wrangler: `$A`, `${A}`, `${A:-default}` and `${A:+other}`. A loop can't run forever. */
function expand(value: string, known: Record<string, string | undefined>, parsed: Record<string, string>): string {
  let result = value
  const seen = new Set<string>()
  let match = REFERENCE.exec(result)
  while (match) {
    seen.add(result)
    const [template, braced, plain] = match
    const expression = braced || plain
    const operator = OPERATOR.exec(expression)?.[0]
    const parts = operator ? expression.split(operator) : [expression]
    const key = parts.shift()!
    const rest = operator ? parts.join(operator) : ''
    const replacement =
      operator === ':+' || operator === '+'
        ? known[key]
          ? rest
          : ''
        : known[key] && !seen.has(known[key])
          ? known[key]
          : rest
    result = result.replace(template, () => replacement)
    if (result === parsed[key]) break
    match = REFERENCE.exec(result)
  }

  return result
}

/**
 * The values a worker's `.env` files add to wrangler's environment, with the same files, precedence and expansion as
 * wrangler's own startup. Wrangler reads them from its working directory, which is the run directory, so monocf loads
 * them from the worker's source. A variable already set in the real environment wins. Values never reach a log.
 */
export function readWorkerEnvironment(
  workerPath: string,
  env: string | undefined,
  current: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const name of envFileNames(env)) Object.assign(merged, readParsed(join(workerPath, name)))

  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) {
    const real = current[key]
    const expanded = real && real !== value ? real : expand(value, {...result, ...current}, result)
    result[key] = expanded.replaceAll(String.raw`\$`, '$')
  }

  return result
}
