import {existsSync} from 'node:fs'
import {isAbsolute, join, relative, resolve} from 'node:path'

import {isPlainObject, type RawConfig} from '../config/types.js'

/**
 * The fields that hold a path relative to the wrangler config, which moves into the run directory. A segment `[]`
 * walks a list, and `*` walks the values of a map. A schema test keeps this list complete against wrangler.
 */
export const REBASED_FIELDS = [
  'alias.*',
  'assets.directory',
  'base_dir',
  'build.cwd',
  'build.watch_dir',
  'containers[].image',
  'containers[].image_build_context',
  'containers[].images.*.build_context',
  'containers[].images.*.dockerfile',
  'd1_databases[].migrations_dir',
  'd1_databases[].migrations_pattern',
  'data_blobs.*',
  'main',
  'pages_build_output_dir',
  'site.bucket',
  'text_blobs.*',
  'tsconfig',
  'wasm_modules.*',
] as const

/**
 * Path-like fields that stay as written, with the reason. Wrangler reads `unsafe.capnp` from the working directory,
 * and that stays the worker's source directory.
 */
export const NOT_REBASED_FIELDS: Record<string, string> = {
  'assets.base_path': 'A public URL prefix.',
  'cloudchamber.image': 'An image in a registry.',
  'containers[].images.*.image': 'An image in a registry.',
  'dev.container_engine.localDocker.containerEgressInterceptorImage': 'A local Docker image.',
  'dev.container_engine.localDocker.socketPath': 'A Docker socket, unrelated to the config location.',
  'python_modules.exclude[]': 'Globs relative to the python_modules directory.',
  'rules[].globs[]': 'Globs relative to base_dir.',
  'site.exclude[]': 'Patterns relative to site.bucket.',
  'site.include[]': 'Patterns relative to site.bucket.',
  'unsafe.capnp.base_path': 'Wrangler resolves this from the working directory, which stays the source directory.',
  'unsafe.capnp.compiled_schema': 'Wrangler resolves this from the working directory, which stays the source directory.',
  'unsafe.capnp.source_schemas[]': 'Wrangler resolves these from the working directory, which stays the source directory.',
}

export interface RebaseContext {
  exists?: (path: string) => boolean
  /** The directory the paths were written against. */
  from: string
  /** The directory the config moves to. */
  to: string
}

type Rewrite = (value: unknown, field: string) => unknown

function walk(node: unknown, segments: string[], field: string, rewrite: Rewrite): unknown {
  if (segments.length === 0) return rewrite(node, field)

  const [segment, ...rest] = segments
  if (segment === '*') {
    if (!isPlainObject(node)) return node
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value, rest, field, rewrite)]))
  }

  if (!isPlainObject(node) || !Object.hasOwn(node, segment.replace('[]', ''))) return node

  const key = segment.replace('[]', '')
  const value = node[key]
  const rewritten =
    segment.endsWith('[]') && Array.isArray(value)
      ? value.map((element) => walk(element, rest, field, rewrite))
      : walk(value, rest, field, rewrite)
  return {...node, [key]: rewritten}
}

function isPathLikeImage(value: string, {exists = existsSync, from}: RebaseContext): boolean {
  return value.startsWith('.') || exists(join(from, value))
}

function rebasePath(value: string, {from, to}: RebaseContext): string {
  if (isAbsolute(value)) return value
  return relative(to, resolve(from, value)).replaceAll('\\', '/')
}

function rewriter(context: RebaseContext): Rewrite {
  const rebase: Rewrite = (value, field) => {
    if (Array.isArray(value)) return value.map((element) => rebase(element, field))
    if (typeof value !== 'string') return value
    if (field === 'alias.*' && !value.startsWith('.')) return value
    if (field === 'containers[].image' && !isPathLikeImage(value, context)) return value
    return rebasePath(value, context)
  }

  return rebase
}

function rebaseSection(section: RawConfig, context: RebaseContext): RawConfig {
  const rewrite = rewriter(context)
  let result: RawConfig = section
  for (const field of REBASED_FIELDS) {
    result = walk(result, field.split('.'), field, rewrite) as RawConfig
  }

  // Wrangler's default for this field is relative to the config, and it matters only with a build command.
  if (isPlainObject(result.build) && result.build.command !== undefined && result.build.watch_dir === undefined) {
    result = {...result, build: {...result.build, watch_dir: rebasePath('./src', context)}}
  }

  return isPlainObject(result.previews) ? {...result, previews: rebaseSection(result.previews, context)} : result
}

/** Returns the config with every relative path rewritten for its new location. Rebased values stay relative. */
export function rebaseConfig(config: RawConfig, context: RebaseContext): RawConfig {
  const result = rebaseSection(config, context)
  if (!isPlainObject(result.env)) return result
  const env = Object.fromEntries(
    Object.entries(result.env).map(([name, section]) => [
      name,
      isPlainObject(section) ? rebaseSection(section, context) : section,
    ]),
  )
  return {...result, env}
}
