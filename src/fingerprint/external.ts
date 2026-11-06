import {createHash, type Hash} from 'node:crypto'
import {existsSync, readFileSync, readdirSync, readlinkSync, statSync} from 'node:fs'
import {dirname, isAbsolute, join, relative, resolve} from 'node:path'
import ignore from 'ignore'

import {effectiveField, envSection} from '../config/resolve.js'
import {isPlainObject, type RawConfig} from '../config/types.js'
import {isPathLikeImage} from '../runtime/path-fields.js'

/** Something wrangler uploads from outside `--outdir`, so the bundle can't show a change to it. */
export interface ExternalInput {
  /** Which input, so that a file moving from one to another changes the hash. */
  label: string
  path: string
  /** `assets` follows wrangler's own ignore rules. Anything else takes every file there is. */
  type: 'assets' | 'file' | 'tree'
}

// Monocf's own output, wrangler's, and git's are never the input, and all three change with no change to the worker. Under
// assets, wrangler uploads whatever .assetsignore lets through, whatever it's called, so a name there proves nothing.
const NEVER_INPUT = new Set(['.git', '.monocf', '.wrangler'])

// Wrangler leaves these three out of the asset manifest, but it sends _headers and _redirects as configuration, and
// .assetsignore decides what the others are.
const ASSET_CONFIG_FILES = new Set(['.assetsignore', '_headers', '_redirects'])

function pathsOf(value: unknown): [string, string][] {
  if (!isPlainObject(value)) return []
  return Object.entries(value).flatMap(([key, path]): [string, string][] => (typeof path === 'string' ? [[key, path]] : []))
}

function containerInputs(config: RawConfig, env: string | undefined, workerPath: string): ExternalInput[] {
  const {containers} = envSection(config, env)
  if (!Array.isArray(containers)) return []
  return containers.flatMap((container: unknown, index) => {
    if (!isPlainObject(container)) return []
    const name = String(container.name ?? container.class_name ?? index)
    const fromFile = (label: string, file: unknown, context: unknown): ExternalInput[] =>
      typeof file === 'string'
        ? [
            {label: `container:${label}:dockerfile`, path: resolve(workerPath, file), type: 'file'},
            {
              label: `container:${label}:context`,
              path: resolve(workerPath, typeof context === 'string' ? context : dirname(file)),
              type: 'tree',
            },
          ]
        : []
    const {image, images} = container
    const local = typeof image === 'string' && isPathLikeImage(image, workerPath)
    const named = isPlainObject(images)
      ? Object.entries(images).flatMap(([key, entry]) =>
          isPlainObject(entry) ? fromFile(`${name}:${key}`, entry.dockerfile, entry.build_context) : [],
        )
      : []
    return [...(local ? fromFile(name, image, container.image_build_context) : []), ...named]
  })
}

function capnpInputs(config: RawConfig, env: string | undefined, workerPath: string): ExternalInput[] {
  const {unsafe} = envSection(config, env)
  const capnp = isPlainObject(unsafe) ? unsafe.capnp : undefined
  if (!isPlainObject(capnp)) return []
  const base = typeof capnp.base_path === 'string' ? capnp.base_path : '.'
  const sources = Array.isArray(capnp.source_schemas) ? capnp.source_schemas : []
  return [
    ...(typeof capnp.compiled_schema === 'string'
      ? [{label: 'capnp:compiled', path: resolve(workerPath, capnp.compiled_schema), type: 'file' as const}]
      : []),
    ...sources.flatMap((source: unknown) =>
      typeof source === 'string'
        ? [{label: `capnp:source:${source}`, path: resolve(workerPath, base, source), type: 'file' as const}]
        : [],
    ),
  ]
}

/**
 * Wrangler overwrites a module called README.md in the output with its own, so its content is only in the source. It counts
 * whichever rules match it, which can give a false "changed" and never a false "unchanged". A Python worker and `no_bundle`
 * find additional modules whatever the field says.
 */
function readmeModule(config: RawConfig, env: string | undefined, workerPath: string): ExternalInput[] {
  const field = (name: string) => effectiveField(config, env, name)
  const main = field('main')
  const finds = field('find_additional_modules') === true || field('no_bundle') === true || (typeof main === 'string' && main.endsWith('.py'))
  const baseDir = field('base_dir')
  const root = typeof baseDir === 'string' ? baseDir : typeof main === 'string' ? dirname(main) : undefined
  if (!finds || root === undefined) return []
  const path = resolve(workerPath, root, 'README.md')
  return existsSync(path) ? [{label: 'readme-module', path, type: 'file'}] : []
}

/**
 * What this worker sends from outside the output directory, with the values for this env. Wrangler reads `site` and the
 * blobs only at the top level, and warns about them under an env, so both places count: a false "changed" costs one
 * redeploy, and a false "unchanged" never ships the change.
 */
export function externalInputs(config: RawConfig, env: string | undefined, workerPath: string): ExternalInput[] {
  const sections = env === undefined ? [config] : [config, envSection(config, env)]
  const assets = effectiveField(config, env, 'assets')
  return [
    ...(isPlainObject(assets) && typeof assets.directory === 'string'
      ? [{label: 'assets', path: resolve(workerPath, assets.directory), type: 'assets' as const}]
      : []),
    ...sections.flatMap(({site}) =>
      isPlainObject(site) && typeof site.bucket === 'string'
        ? [{label: 'site', path: resolve(workerPath, site.bucket), type: 'tree' as const}]
        : [],
    ),
    ...['wasm_modules', 'text_blobs', 'data_blobs'].flatMap((field) =>
      sections.flatMap((section) =>
        pathsOf(section[field]).map(([key, path]) => ({
          label: `${field}:${key}`,
          path: resolve(workerPath, path),
          type: 'file' as const,
        })),
      ),
    ),
    ...capnpInputs(config, env, workerPath),
    ...containerInputs(config, env, workerPath),
    ...readmeModule(config, env, workerPath),
  ]
}

interface InputFile {
  absolute: string
  /** What a symbolic link to a directory holds instead of bytes. */
  link?: string
  path: string
}

export function isSameOrWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function listFiles(root: string, skip: Set<string>, outside: string[]): InputFile[] {
  const files: InputFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const absolute = join(dir, entry.name)
      if (!skip.has(entry.name) && !outside.some((path) => isSameOrWithin(path, absolute))) {
        const path = relative(root, absolute).replaceAll('\\', '/')
        if (entry.isDirectory()) {
          walk(absolute)
        } else if (entry.isSymbolicLink() && existsSync(absolute) && statSync(absolute).isDirectory()) {
          files.push({absolute, link: readlinkSync(absolute), path})
        } else if (existsSync(absolute)) {
          files.push({absolute, path})
        }
      }
    }
  }

  walk(root)
  return files
}

/** The same patterns wrangler's createAssetsIgnoreFunction builds, tried the way its buildAssetManifest does. */
function withoutIgnoredAssets(root: string, files: InputFile[]): InputFile[] {
  const ignoreFile = join(root, '.assetsignore')
  if (!existsSync(ignoreFile)) return files
  const patterns = ignore().add(readFileSync(ignoreFile, 'utf8').split('\n'))
  return files.filter(({path}) => ASSET_CONFIG_FILES.has(path) || !patterns.test(path).ignored)
}

function inputFiles({path, type}: ExternalInput, outside: string[]): InputFile[] {
  if (statSync(path).isFile()) return [{absolute: path, path: ''}]
  if (type === 'assets') return withoutIgnoredAssets(path, listFiles(path, new Set(), outside))
  return listFiles(path, NEVER_INPUT, outside)
}

function comparePaths(a: {path: string}, b: {path: string}): number {
  return a.path < b.path ? -1 : Number(a.path > b.path)
}

function hashInput(hash: Hash, input: ExternalInput, outside: string[]): void {
  // Wrangler decides whether a missing input is an error. If the dry run got past it, the fact that it's missing is the
  // content: having the file appear later has to count as a change.
  if (!existsSync(input.path)) {
    hash.update(`${input.label}\nmissing\n`)
    return
  }

  for (const {absolute, link, path} of inputFiles(input, outside).sort(comparePaths)) {
    const bytes = link === undefined ? readFileSync(absolute) : Buffer.from(link)
    hash.update(`${input.label}\n${Buffer.byteLength(path)}:${path}\n${bytes.length}\n`)
    hash.update(bytes)
  }
}

/**
 * SHA-256 over sorted (label, relative path, bytes), so a checkout path can't change it. It runs after the dry run, since
 * `build.command` can generate these inputs. `outside` holds directories that are never input, such as the output.
 */
export function externalHash(inputs: ExternalInput[], outside: string[] = []): string {
  const hash = createHash('sha256')
  const sorted = [...inputs].sort((a, b) => (a.label === b.label ? comparePaths(a, b) : comparePaths({path: a.label}, {path: b.label})))
  for (const input of sorted) hashInput(hash, input, outside)
  return hash.digest('hex')
}

/**
 * A worker's hash as a plan compares it. The project's own `.monocf` holds run directories with random names and the default
 * bundle, and `outside` holds the bundle's output, so neither counts even if an input is configured to contain it.
 */
export function workerExternalHash({config, path}: {config: RawConfig; path: string}, env: string | undefined, rootDir: string, outside: string[] = []): string {
  return externalHash(externalInputs(config, env, path), [join(rootDir, '.monocf'), ...outside])
}

/** What `wrangler versions upload` can't carry, so that a change to it needs a plain `wrangler deploy`. */
export function fieldsNeedingDeploy(config: RawConfig, env?: string): string[] {
  const {containers} = envSection(config, env)
  return [
    ...(effectiveField(config, env, 'site') === undefined ? [] : ['site']),
    ...(Array.isArray(containers) && containers.length > 0 ? ['containers'] : []),
  ]
}
