import {createHash} from 'node:crypto'

import {effectiveField} from '../config/resolve.js'
import {isPlainObject, type RawConfig} from '../config/types.js'

export interface BundleFile {
  bytes: Uint8Array | string
  /** Relative to the output directory, with either separator. */
  path: string
}

export interface Triggers {
  /** Null when the config doesn't set them: wrangler then leaves the deployed crons alone, unlike an empty list. */
  crons: unknown[] | null
  previewUrls: boolean | null
  routes: unknown[]
  workersDev: boolean
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element) => sortKeys(element))
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  )
}

/** JSON with keys sorted recursively, so key order can't change a hash. Array order stays, because it means something. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function normalisePath(path: string): string {
  return path.replaceAll('\\', '/')
}

/** README.md holds a timestamp, a .map changes with line endings, and wrangler.json is the config, hashed apart. */
export function isHashed(path: string): boolean {
  const normal = normalisePath(path)
  return normal !== 'README.md' && !normal.endsWith('.map') && !/^wrangler\.json[^/]*$/.test(normal)
}

// esbuild writes module paths into comments and `__commonJS` keys. pnpm cuts a long store directory name at a limit that
// differs per platform, so the same package has two spellings on Windows and Linux. The directory says nothing the code
// doesn't: a new version or patch with different code changes the bytes around it anyway.
const PNPM_STORE_DIRECTORY = /node_modules\/\.pnpm\/[^/"'\s]+\/node_modules\//g
const SCRIPT_FILE = /\.[cm]?js$/

/** The bytes to hash. Goes through latin1, which maps every byte to one character, so nothing else can change. */
export function normaliseModule(path: string, bytes: Uint8Array | string): Uint8Array {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes)
  if (!SCRIPT_FILE.test(path)) return buffer
  return Buffer.from(buffer.toString('latin1').replaceAll(PNPM_STORE_DIRECTORY, 'node_modules/.pnpm/-/node_modules/'), 'latin1')
}

/** SHA-256 over sorted (path, bytes). Each part carries its length, so moving bytes between files changes the hash. */
export function bundleHash(files: BundleFile[]): string {
  const hash = createHash('sha256')
  const hashed = files
    .filter(({path}) => isHashed(path))
    .map(({bytes, path}) => ({bytes: normaliseModule(path, bytes), path: normalisePath(path)}))
    .sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)))
  for (const {bytes, path} of hashed) {
    hash.update(`${Buffer.byteLength(path)}:${path}\n${bytes.length}\n`)
    hash.update(bytes)
  }

  return hash.digest('hex')
}

function withoutRelease(section: RawConfig): RawConfig {
  if (!isPlainObject(section.vars)) return section
  return {...section, vars: Object.fromEntries(Object.entries(section.vars).filter(([key]) => key !== 'RELEASE'))}
}

/**
 * The resolved config as far as this env goes: other env sections can't reach the worker, so a change to them must not
 * change this one's hash. Without RELEASE, so a new commit with the same code keeps its fingerprint. Nothing here is
 * rebased, so the run directory can't show up in it.
 */
export function canonicalConfig(config: RawConfig, env?: string): RawConfig {
  const {env: sections, ...top} = withoutRelease(config)
  if (env === undefined) return top
  const section = isPlainObject(sections) ? sections[env] : undefined
  return {...top, env: {[env]: isPlainObject(section) ? withoutRelease(section) : {}}}
}

export function configHash(config: RawConfig, env?: string): string {
  return sha256(canonicalJson(canonicalConfig(config, env)))
}

export function fingerprintOf(bundle: string, config: string): string {
  return sha256(`${bundle}\n${config}`)
}

/** What wrangler reads for these fields. All of them inherit, and workers_dev follows the routes unless it's set. */
export function triggersOf(config: RawConfig, env?: string): Triggers {
  const field = (name: string) => effectiveField(config, env, name)
  const triggers = field('triggers')
  const crons = isPlainObject(triggers) ? triggers.crons : undefined
  const routes = field('routes')
  const route = field('route')
  const routeList = Array.isArray(routes) ? routes : route ? [route] : []
  const workersDev = field('workers_dev')
  const previewUrls = field('preview_urls')
  return {
    crons: Array.isArray(crons) ? crons : null,
    previewUrls: typeof previewUrls === 'boolean' ? previewUrls : null,
    routes: routeList,
    workersDev: typeof workersDev === 'boolean' ? workersDev : routeList.length === 0,
  }
}

export function triggersHash(triggers: Triggers): string {
  return sha256(canonicalJson(triggers))
}

/** The fields that change a Durable Object class's lifecycle. A binding alone doesn't. */
export function doHash(config: RawConfig, env?: string): string {
  return sha256(
    canonicalJson({
      exports: effectiveField(config, env, 'exports') ?? null,
      migrations: effectiveField(config, env, 'migrations') ?? null,
    }),
  )
}

const EXPORT_LIST = /\bexport\s*\{([^{}]*)\}\s*;?\s*(?:\/\/[^\n]*\s*)*$/

/** The names in the `export {...};` that ends unminified esbuild output. Undefined when the text has no such statement. */
export function parseExportNames(source: string): string[] | undefined {
  const match = EXPORT_LIST.exec(source)
  if (!match) return undefined
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => part.split(/\s+as\s+/).at(-1)!.replaceAll(/^["']|["']$/g, ''))
}
