import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {NOT_REBASED_FIELDS, REBASED_FIELDS, rebaseConfig} from '../../src/runtime/path-fields.js'

const from = '/repo/workers/orders'
const to = '/repo/.monocf/runs/abc/orders'
const context = {exists: () => false, from, to}
const up = '../../../../workers/orders'

const exists = (path: string) => path.replaceAll('\\', '/').endsWith('/Dockerfile.local')

describe('rebaseConfig', () => {
  it.each([
    ['main', {main: 'src/index.ts'}, {main: `${up}/src/index.ts`}],
    ['base_dir', {base_dir: './src'}, {base_dir: `${up}/src`}],
    ['tsconfig', {tsconfig: 'tsconfig.json'}, {tsconfig: `${up}/tsconfig.json`}],
    ['assets', {assets: {binding: 'A', directory: './public'}}, {assets: {binding: 'A', directory: `${up}/public`}}],
    ['site', {site: {bucket: './site', include: ['*.html']}}, {site: {bucket: `${up}/site`, include: ['*.html']}}],
    ['the pages output', {pages_build_output_dir: 'dist'}, {pages_build_output_dir: `${up}/dist`}],
    [
      'build fields',
      {build: {command: 'make', cwd: '.', watch_dir: ['src', 'lib']}},
      {build: {command: 'make', cwd: up, watch_dir: [`${up}/src`, `${up}/lib`]}},
    ],
    [
      'd1 fields',
      {d1_databases: [{binding: 'D', migrations_dir: 'db', migrations_pattern: 'db/*.sql'}]},
      {d1_databases: [{binding: 'D', migrations_dir: `${up}/db`, migrations_pattern: `${up}/db/*.sql`}]},
    ],
    ['module maps', {wasm_modules: {W: 'a.wasm'}}, {wasm_modules: {W: `${up}/a.wasm`}}],
    ['text blobs', {text_blobs: {T: 'a.txt'}}, {text_blobs: {T: `${up}/a.txt`}}],
    ['data blobs', {data_blobs: {T: 'a.bin'}}, {data_blobs: {T: `${up}/a.bin`}}],
    [
      'container builds',
      {containers: [{image: './Dockerfile', image_build_context: '.'}]},
      {containers: [{image: `${up}/Dockerfile`, image_build_context: up}]},
    ],
    [
      'container images',
      {containers: [{images: {a: {build_context: '.', dockerfile: 'Dockerfile', image: 'r/x:1'}}}]},
      {containers: [{images: {a: {build_context: up, dockerfile: `${up}/Dockerfile`, image: 'r/x:1'}}}]},
    ],
  ])('rewrites %s', (_, config, expected) => {
    expect(rebaseConfig(config, context)).toEqual(expected)
  })

  it('rewrites each env section the same way', () => {
    const result = rebaseConfig({env: {staging: {main: 'src/staging.ts'}}, main: 'src/index.ts'}, context)

    expect(result).toEqual({env: {staging: {main: `${up}/src/staging.ts`}}, main: `${up}/src/index.ts`})
  })

  it('rewrites the previews section the same way', () => {
    const result = rebaseConfig({env: {e: {previews: {main: 'b.ts'}}}, previews: {main: 'a.ts'}}, context)

    expect(result).toEqual({env: {e: {previews: {main: `${up}/b.ts`}}}, previews: {main: `${up}/a.ts`}})
  })

  it('leaves an absolute path alone', () => {
    const main = process.platform === 'win32' ? String.raw`C:\abs\index.ts` : '/abs/index.ts'

    expect(rebaseConfig({main}, context)).toEqual({main})
  })

  it('values stay relative', () => {
    const {main} = rebaseConfig({main: 'src/index.ts'}, context)

    expect(String(main).startsWith('..')).toBe(true)
  })

  it('rewrites an alias that is a path, and leaves one that is a package', () => {
    const result = rebaseConfig({alias: {a: './shim.ts', b: '../shared/shim.ts', c: 'other-package'}}, context)

    expect(result.alias).toEqual({a: `${up}/shim.ts`, b: '../../../../workers/shared/shim.ts', c: 'other-package'})
  })

  it('tells a registry image from a local Dockerfile', () => {
    const result = rebaseConfig(
      {containers: [{image: 'registry.example.com/x:1'}, {image: 'Dockerfile.local'}]},
      {...context, exists},
    )

    expect(result.containers).toEqual([{image: 'registry.example.com/x:1'}, {image: `${up}/Dockerfile.local`}])
  })

  it('adds the defaults of a build command, so it still runs in the worker and watches its source', () => {
    expect(rebaseConfig({build: {command: 'make'}}, context).build).toEqual({
      command: 'make',
      cwd: up,
      watch_dir: `${up}/src`,
    })
  })

  it('rewrites the unsafe capnp paths, and leaves the schemas relative to their base path', () => {
    expect(rebaseConfig({unsafe: {capnp: {compiled_schema: 'a.bin'}}}, context).unsafe).toEqual({
      capnp: {compiled_schema: `${up}/a.bin`},
    })
    expect(rebaseConfig({unsafe: {capnp: {base_path: 'schemas', source_schemas: ['a.capnp']}}}, context).unsafe).toEqual({
      capnp: {base_path: `${up}/schemas`, source_schemas: ['a.capnp']},
    })
  })

  it('does not invent a build section', () => {
    expect(rebaseConfig({}, context)).toEqual({})
  })

  it('does not change the object it was given', () => {
    const config = {env: {e: {main: 'x.ts'}}, main: 'y.ts'}

    rebaseConfig(config, context)

    expect(config).toEqual({env: {e: {main: 'x.ts'}}, main: 'y.ts'})
  })
})

// A string field whose name or description suggests a location. Wording changes in wrangler can only widen this.
const PATH_NAME = /path|dir|file|location|cwd|folder|bucket|main|root|image|context|module|blob|alias|capnp|include|exclude|glob|pattern|tsconfig/i
const PATH_DESCRIPTION = /\bpaths?\b|director|relative to|folder|\bfiles?\b/i

/** Read as the schema reads, but whose content isn't a location on disk, despite its name or description. */
const UNRELATED_FIELDS: Record<string, string> = {
  'cloudchamber.location': 'A Cloudflare location.',
  'containers[].image_vars.*': 'Values passed to an image build.',
  'containers[].images.*.build_vars.*': 'Values passed to an image build.',
  'dependencies_instrumentation.exclude_packages[]': 'Package name patterns.',
  'images.binding': 'A binding name.',
  'r2_buckets[].binding': 'A binding name.',
  'r2_buckets[].bucket_name': 'A bucket on Cloudflare.',
  'r2_buckets[].jurisdiction': 'A region keyword.',
  'r2_buckets[].local_dev.experimental_s3_credentials.accessKeyId': 'A credential.',
  'r2_buckets[].local_dev.experimental_s3_credentials.secretAccessKey': 'A credential.',
  'r2_buckets[].preview_bucket_name': 'A bucket on Cloudflare.',
  'route.pattern': 'A URL pattern.',
  'routes[].pattern': 'A URL pattern.',
}

interface SchemaNode {
  $ref?: string
  additionalProperties?: boolean | SchemaNode
  allOf?: SchemaNode[]
  anyOf?: SchemaNode[]
  description?: string
  items?: SchemaNode | SchemaNode[]
  oneOf?: SchemaNode[]
  properties?: Record<string, SchemaNode>
  type?: string | string[]
}

function stringFields(schema: {definitions: Record<string, SchemaNode>}): Map<string, string> {
  const fields = new Map<string, string>()
  const stack = new Set<string>()

  const walk = (node: SchemaNode | undefined, path: string, description: string): void => {
    if (!node || typeof node !== 'object') return
    if (node.$ref) {
      if (stack.has(node.$ref)) return
      stack.add(node.$ref)
      walk(schema.definitions[node.$ref.split('/').pop()!], path, node.description ?? description)
      stack.delete(node.$ref)
      return
    }

    const text = node.description ?? description
    const types = Array.isArray(node.type) ? node.type : [node.type]
    if (types.includes('string')) fields.set(path, text)
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      walk(child, path ? `${path}.${key}` : key, child.description ?? '')
    }

    if (typeof node.additionalProperties === 'object') walk(node.additionalProperties, `${path}.*`, text)
    if (node.items && !Array.isArray(node.items)) walk(node.items, `${path}[]`, text)
    for (const list of [node.anyOf, node.oneOf, node.allOf]) {
      for (const child of list ?? []) walk(child, path, text)
    }
  }

  walk(schema as SchemaNode, '', '')
  return fields
}

/**
 * The field as the rebase lists name it: an env or previews section has the same fields as the top level. The schema
 * also repeats the whole config under a few fields of previews, which comes from how its types are generated and isn't
 * a place where wrangler reads paths.
 */
function canonical(path: string): string {
  return path
    .replace(/^env\.\*\./, '')
    .replace(/^previews\.(cache|limits|logpush|observability|placement)\./, 'generated-copy.')
    .replace(/^previews\./, '')
}

describe('the list of rebased fields against the schema of real wrangler', () => {
  const require = createRequire(import.meta.url)
  const schema = JSON.parse(readFileSync(join(dirname(require.resolve('wrangler/package.json')), 'config-schema.json'), 'utf8'))
  const fields = stringFields(schema)

  it('finds the schema it should be reading', () => {
    expect(fields.size).toBeGreaterThan(100)
    expect(fields.has('main')).toBe(true)
  })

  it('has decided on every path-like string field', () => {
    const known = new Set<string>([
      ...REBASED_FIELDS,
      ...Object.keys(NOT_REBASED_FIELDS),
      ...Object.keys(UNRELATED_FIELDS),
    ])
    const undecided = [...fields]
      .filter(([path, description]) => PATH_NAME.test(path) || PATH_DESCRIPTION.test(description))
      .map(([path]) => canonical(path))
      .filter((path) => !path.startsWith('generated-copy.'))
      .filter((path) => !known.has(path) && !known.has(path.replace(/\[\]$/, '')))

    expect([...new Set(undecided)].sort()).toEqual([])
  })

  it('lists no field that wrangler does not have', () => {
    const paths = new Set([...fields.keys()].map((path) => canonical(path)))
    const has = (field: string) => paths.has(field) || paths.has(`${field}[]`)

    expect(REBASED_FIELDS.filter((field) => !has(field))).toEqual([])
    expect(Object.keys(NOT_REBASED_FIELDS).filter((field) => !has(field))).toEqual([])
    expect(Object.keys(UNRELATED_FIELDS).filter((field) => !has(field))).toEqual([])
  })
})
