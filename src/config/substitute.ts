import {isPlainObject, type RawConfig} from './types.js'

// One word in braces, in any script, with or without spaces around it. Text with quotes, colons, commas or several
// words isn't a placeholder, so JSON, a glob such as `*.{js,ts}` and a quantifier such as `{3,5}` don't match.
const PLACEHOLDER = /\{\s*[^\s{}"':,]+\s*\}/g
// A regex quantifier such as `\d{3}`.
const QUANTIFIER = /^\{\d+\}$/

function substituteText(text: string, variables: Record<string, string>): string {
  let result = text
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{${key}}`, value)
  }

  return result
}

function substituteValue(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === 'string') return substituteText(value, variables)
  if (Array.isArray(value)) return value.map((element) => substituteValue(element, variables))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        substituteText(key, variables),
        substituteValue(entry, variables),
      ]),
    )
  }

  return value
}

/**
 * Replaces `{key}` in every string of a config, object keys included. Variables apply in order, so one can expand
 * into another. A value can't break the config, since it never passes through JSON text.
 */
export function substituteConfig(config: RawConfig, variables: Record<string, string>): RawConfig {
  return substituteValue(config, variables) as RawConfig
}

function collectPlaceholders(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    for (const [placeholder] of value.matchAll(PLACEHOLDER)) {
      if (!QUANTIFIER.test(placeholder)) found.add(placeholder)
    }
  } else if (Array.isArray(value)) {
    for (const element of value) collectPlaceholders(element, found)
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      collectPlaceholders(key, found)
      collectPlaceholders(entry, found)
    }
  }
}

/**
 * Finds what still looks like a placeholder after substitution. A key in `known` isn't reported, so a variable
 * mapped to itself, such as `"id": "{id}"`, keeps literal braces in a config.
 */
export function findUnknownPlaceholders(config: RawConfig, known: Iterable<string>): string[] {
  const found = new Set<string>()
  collectPlaceholders(config, found)
  for (const key of known) found.delete(`{${key}}`)
  return [...found].sort()
}
