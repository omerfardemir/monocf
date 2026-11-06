/*
 * Merge rules, equal to `experimental_patchConfig(path, patch, true)` in wrangler for non-null values. A patch is a
 * list of edits:
 * - A scalar sets its key, replacing whatever is there, including an object or an array.
 * - An object descends into its keys. An empty object is no edit, so it vanishes and can't clear a base value.
 * - An array appends each element as it is, with no deduplication. An empty array is no edit, as above.
 * - `null` in a patch is an error, unless it sits inside an array element. In the base it's an ordinary scalar.
 *   This is monocf's own rule: wrangler's patch crashes on `null` in some versions and writes it in others, and its
 *   config reader then rejects it for fields such as `route`.
 * - An edit that has to pass through, or append to, a value of another type is an error.
 */
import {ConfigError, isPlainObject, type RawConfig} from './types.js'

type Edit = {append: boolean; path: string[]; value: unknown}

function collectEdits(patch: RawConfig, parent: string[], file?: string): Edit[] {
  return Object.entries(patch).flatMap(([key, value]): Edit[] => {
    const path = [...parent, key]
    if (Array.isArray(value)) return value.map((element) => ({append: true, path, value: element}))
    if (value === null) {
      throw new ConfigError(`"${path.join('.')}" is null, which a config merge can't apply. Remove the key.`, file)
    }

    if (isPlainObject(value)) return collectEdits(value, path, file)
    return [{append: false, path, value}]
  })
}

function conflict(path: string[], file?: string): ConfigError {
  return new ConfigError(`Can't merge "${path.join('.')}": the base and the worker use different types here.`, file)
}

function applyEdit(target: RawConfig, {append, path, value}: Edit, file?: string): void {
  let node = target
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(node, key)) node[key] = {}
    const child = node[key]
    if (!isPlainObject(child)) throw conflict(path, file)
    node = child
  }

  const last = path.at(-1)!
  if (!append) {
    node[last] = value
    return
  }

  if (!Object.hasOwn(node, last)) node[last] = []
  const list = node[last]
  if (!Array.isArray(list)) throw conflict(path, file)
  list.push(structuredClone(value))
}

/** Applies a patch to a config in place. */
export function applyPatch(target: RawConfig, patch: RawConfig, file?: string): void {
  for (const edit of collectEdits(patch, [], file)) applyEdit(target, edit, file)
}

/** Merges a worker config over a base config. Neither input changes. */
export function mergeConfig(base: RawConfig, worker: RawConfig, file?: string): RawConfig {
  const merged = structuredClone(base)
  applyPatch(merged, worker, file)
  return merged
}
