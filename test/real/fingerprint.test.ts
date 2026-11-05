import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli, type Fixture} from '../helpers/harness.js'

const SERVICE_WORKER = `addEventListener('fetch', (event) => event.respondWith(new Response('ok')))\n`

interface Worker {
  bundleHash: string
  externalHash: string
  fingerprint: string
}

function project(config: Record<string, unknown>, files: Record<string, string>, wrangler: 'fake' | 'real' = 'real'): Fixture {
  return createFixture({
    environments: ['staging'],
    files: Object.fromEntries(Object.entries(files).map(([path, content]) => [`workers/orders/${path}`, content])),
    wrangler,
    workers: [{config, name: 'orders'}],
  })
}

async function bundled(fixture: Fixture): Promise<Worker> {
  const result = await runCli(fixture, ['bundle', 'orders', '-e', 'staging'])
  expect(result.exitCode, result.stderr).toBe(0)
  const manifest = JSON.parse(readFileSync(join(fixture.root, '.monocf', 'bundle', 'staging', 'manifest.json'), 'utf8'))
  return manifest.workers.orders
}

/** Two bundles, one file changed in between. Exit 0 on both, so wrangler took each of them. */
async function afterChanging(fixture: Fixture, path: string, content = 'changed'): Promise<[Worker, Worker]> {
  const before = await bundled(fixture)
  writeFileSync(join(fixture.worker('orders'), path), content)
  return [before, await bundled(fixture)]
}

function expectChanged([before, after]: [Worker, Worker]): void {
  expect(after.fingerprint).not.toBe(before.fingerprint)
  expect(after.externalHash).not.toBe(before.externalHash)
}

const serviceWorker = {files: {'src/index.ts': SERVICE_WORKER}}

describe('real wrangler: the fingerprint covers what it uploads from outside --outdir', {timeout: 180_000}, () => {
  it.each([
    ['a file in assets', {assets: {directory: './public'}}, {'public/index.html': 'one'}, 'public/index.html'],
    ['_headers', {assets: {directory: './public'}}, {'public/_headers': '/*\n  X-A: 1\n', 'public/index.html': 'one'}, 'public/_headers'],
    ['_redirects', {assets: {directory: './public'}}, {'public/_redirects': '/a /b\n', 'public/index.html': 'one'}, 'public/_redirects'],
    ['a new file in assets', {assets: {directory: './public'}}, {'public/index.html': 'one'}, 'public/new.html'],
    ['a site bucket', {site: {bucket: './site'}}, {'site/index.html': 'one', 'workers-site/index.js': 'export default {fetch: () => new Response("x")}\n'}, 'site/index.html'],
  ])('%s', async (_name, config, files, path) => {
    expectChanged(await afterChanging(project(config, files), path))
  })

  it('an assets-only worker, whose output is a fixed file', async () => {
    const fixture = project({assets: {directory: './public'}, main: undefined}, {'public/index.html': 'one'})
    writeFileSync(
      join(fixture.root, 'base.wrangler.jsonc'),
      JSON.stringify({compatibility_date: '2025-01-09', env: {staging: {vars: {STAGE: 'staging'}}}, name: '{workerName}-{version}'}),
    )

    expectChanged(await afterChanging(fixture, 'public/index.html'))
  })

  it.each([
    ['wasm_modules', {wasm_modules: {W: 'data/w.wasm'}}, {'data/w.wasm': 'one'}],
    ['text_blobs', {text_blobs: {T: 'data/w.wasm'}}, {'data/w.wasm': 'one'}],
    ['data_blobs', {data_blobs: {D: 'data/w.wasm'}}, {'data/w.wasm': 'one'}],
  ])('%s', async (_name, config, files) => {
    expectChanged(await afterChanging(project(config, {...serviceWorker.files, ...files}), 'data/w.wasm'))
  })

  it('unsafe.capnp.compiled_schema', async () => {
    const config = {env: {staging: {unsafe: {capnp: {compiled_schema: 'schema.bin'}, metadata: {}}}}}

    expectChanged(await afterChanging(project(config, {'schema.bin': 'one'}), 'schema.bin'))
  })

  it('an unrelated file changes nothing', async () => {
    const config = {assets: {directory: './public'}}
    const fixture = project(config, {'notes.txt': 'one', 'public/index.html': 'one'})

    const [before, after] = await afterChanging(fixture, 'notes.txt')

    expect(after).toEqual(before)
  })

  it('a file build.command generates into assets counts', async () => {
    const script = `require('node:fs').mkdirSync('public', {recursive: true}); require('node:fs').writeFileSync('public/gen.html', require('node:fs').readFileSync('source.txt'))`
    const config = {assets: {directory: './public'}, build: {command: 'node gen.cjs'}}
    const fixture = project(config, {'gen.cjs': script, 'source.txt': 'one'})

    expectChanged(await afterChanging(fixture, 'source.txt'))
  })
})

const withModules = (globs: string[], type: string) => ({
  find_additional_modules: true,
  rules: [{globs, type}],
})

describe('real wrangler: a module is not left out because of its name', {timeout: 180_000}, () => {
  const entry = `export default {fetch: () => new Response('ok')}\n`

  it('a text module called data.map', async () => {
    const fixture = project(withModules(['**/*.map'], 'Text'), {'src/data.map': 'one', 'src/index.ts': entry})

    const [before, after] = await afterChanging(fixture, 'src/data.map')

    expect(after.bundleHash).not.toBe(before.bundleHash)
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('a data module called wrangler.json', async () => {
    const fixture = project(withModules(['**/*.json'], 'Data'), {'src/index.ts': entry, 'src/wrangler.json': '{"a": 1}'})

    const [before, after] = await afterChanging(fixture, 'src/wrangler.json', '{"a": 2}')

    expect(after.bundleHash).not.toBe(before.bundleHash)
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('a text module called README.md, which wrangler overwrites in the output', async () => {
    const fixture = project(withModules(['**/*.md'], 'Text'), {'src/README.md': 'one', 'src/index.ts': entry})

    expectChanged(await afterChanging(fixture, 'src/README.md'))
  })

  it('a README.md with no rule that matches it can only change the fingerprint in the safe direction', async () => {
    const fixture = project(withModules(['**/*.txt'], 'Text'), {'src/README.md': 'one', 'src/index.ts': entry})

    expectChanged(await afterChanging(fixture, 'src/README.md'))
  })

  it('a README.md is no input without additional modules', async () => {
    const fixture = project({}, {'src/README.md': 'one', 'src/index.ts': entry})

    const [before, after] = await afterChanging(fixture, 'src/README.md')

    expect(after).toEqual(before)
  })
})

// The dry run builds the image with Docker, so these show monocf's side with the fake. test/real/rebase.test.ts shows that
// real wrangler finds these files.
describe('the fingerprint covers a container', () => {
  const config = {env: {staging: {containers: [{class_name: 'Box', image: './docker/Dockerfile'}]}}}
  const files = {'docker/Dockerfile': 'FROM scratch\n', 'docker/app.txt': 'one'}

  it('its Dockerfile', async () => {
    expectChanged(await afterChanging(project(config, files, 'fake'), 'docker/Dockerfile', 'FROM alpine\n'))
  })

  it('a file in its build context', async () => {
    expectChanged(await afterChanging(project(config, files, 'fake'), 'docker/app.txt'))
  })
})
