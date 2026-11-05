import {mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

import {externalHash, externalInputs, fieldsNeedingDeploy, workerExternalHash, type ExternalInput} from '../../src/fingerprint/external.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true})
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'monocf-external-'))
  dirs.push(root)
  for (const [path, content] of Object.entries(files)) write(root, path, content)
  return root
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), {recursive: true})
  writeFileSync(join(root, path), content)
}

const assets = (root: string): ExternalInput => ({label: 'assets', path: root, type: 'assets'})
const site = (root: string): ExternalInput => ({label: 'site', path: root, type: 'tree'})

describe('externalHash', () => {
  it('does not depend on where the checkout is', () => {
    const files = {'a/b.txt': 'one', 'c.txt': 'two'}
    expect(externalHash([assets(tree(files))])).toBe(externalHash([assets(tree(files))]))
  })

  it('changes with the content of a file, a new file, and a renamed file', () => {
    const root = tree({'a.txt': 'one'})
    const before = externalHash([assets(root)])

    write(root, 'a.txt', 'two')
    const changed = externalHash([assets(root)])
    expect(changed).not.toBe(before)

    write(root, 'b.txt', 'new')
    const added = externalHash([assets(root)])
    expect(added).not.toBe(changed)

    renameSync(join(root, 'b.txt'), join(root, 'c.txt'))
    expect(externalHash([assets(root)])).not.toBe(added)
  })

  it('changes when a file moves from one input to another', () => {
    const one = tree({'a.txt': 'x'})
    const other = tree({})
    const before = externalHash([assets(one), site(other)])

    expect(externalHash([assets(other), site(one)])).not.toBe(before)
  })

  it('does not depend on the order of the inputs', () => {
    const one = tree({'a.txt': 'x'})
    const other = tree({'b.txt': 'y'})

    expect(externalHash([assets(one), site(other)])).toBe(externalHash([site(other), assets(one)]))
  })

  describe('assets', () => {
    it.each(['_headers', '_redirects'])('counts %s, which wrangler sends as configuration', (name) => {
      const root = tree({[name]: 'one', 'a.txt': 'x'})
      const before = externalHash([assets(root)])

      write(root, name, 'two')

      expect(externalHash([assets(root)])).not.toBe(before)
    })

    it('counts _headers even when .assetsignore lists it, as wrangler reads it anyway', () => {
      const root = tree({'.assetsignore': '_headers\n', _headers: 'one'})
      const before = externalHash([assets(root)])

      write(root, '_headers', 'two')

      expect(externalHash([assets(root)])).not.toBe(before)
    })

    it('leaves out what .assetsignore names, which wrangler never uploads', () => {
      const root = tree({'.assetsignore': 'drafts/\n*.tmp\n', 'a.txt': 'x', 'drafts/b.txt': 'one', 'c.tmp': 'one'})
      const before = externalHash([assets(root)])

      write(root, 'drafts/b.txt', 'two')
      write(root, 'c.tmp', 'two')

      expect(externalHash([assets(root)])).toBe(before)
    })

    it('counts a change to .assetsignore itself', () => {
      const root = tree({'.assetsignore': 'drafts/\n', 'a.txt': 'x'})
      const before = externalHash([assets(root)])

      write(root, '.assetsignore', 'other/\n')

      expect(externalHash([assets(root)])).not.toBe(before)
    })
  })

  it('takes a file under .monocf among assets, as wrangler uploads it (WP6-18)', () => {
    const root = tree({'a.txt': 'x', '.monocf/page.html': 'one'})
    const before = externalHash([assets(root)])

    write(root, '.monocf/page.html', 'two')

    expect(externalHash([assets(root)])).not.toBe(before)
  })

  it("leaves out the project's own .monocf, even from an input that holds it (WP6-18)", () => {
    const root = tree({'public/a.txt': 'x'})
    const worker = {config: {assets: {directory: '..'}}, path: join(root, 'public')}
    const before = workerExternalHash(worker, undefined, root)

    write(root, '.monocf/runs/abc/index.js', 'x')
    expect(workerExternalHash(worker, undefined, root)).toBe(before)

    write(root, 'other/.monocf/page.html', 'x')
    expect(workerExternalHash(worker, undefined, root)).not.toBe(before)
  })

  it('takes everything under a site bucket or a build context, but never git or monocf output', () => {
    const root = tree({'.dockerignore': 'x', 'a.txt': 'x'})
    const before = externalHash([site(root)])

    write(root, '.git/HEAD', 'moved')
    write(root, '.monocf/runs/abc/index.js', 'x')
    expect(externalHash([site(root)])).toBe(before)

    write(root, 'x', 'ignored by .dockerignore, but taken anyway')
    expect(externalHash([site(root)])).not.toBe(before)
  })

  it('leaves out a directory it is told is no input, such as the output', () => {
    const root = tree({'a.txt': 'x'})
    const before = externalHash([site(root)], [join(root, 'out')])

    write(root, 'out/orders/README.md', 'Generated at noon')

    expect(externalHash([site(root)], [join(root, 'out')])).toBe(before)
  })

  it('takes where a link to a directory points, so pointing it elsewhere is a change', () => {
    const root = tree({'one/x.txt': '1', 'public/index.html': 'a', 'two/x.txt': '2'})
    const link = join(root, 'public', 'linked')
    symlinkSync(join(root, 'one'), link, 'junction')
    const first = externalHash([assets(join(root, 'public'))])
    expect(externalHash([assets(join(root, 'public'))])).toBe(first)

    unlinkSync(link)
    symlinkSync(join(root, 'two'), link, 'junction')

    expect(externalHash([assets(join(root, 'public'))])).not.toBe(first)
    unlinkSync(link)
  })

  it('hashes the fact that an input is missing, and sees it appear', () => {
    const root = tree({})
    const input: ExternalInput = {label: 'text_blobs:A', path: join(root, 'a.txt'), type: 'file'}
    const missing = externalHash([input])

    expect(missing).not.toBe(externalHash([]))

    write(root, 'a.txt', '')
    expect(externalHash([input])).not.toBe(missing)
  })
})

const labels = (config: Record<string, unknown>, env?: string) =>
  externalInputs(config, env, '/worker').map(({label}) => label)

const sitePaths = (config: Record<string, unknown>) =>
  externalInputs(config, 'a', '/worker')
    .filter(({label}) => label === 'site')
    .map(({path}) => path.replaceAll('\\', '/'))

describe('externalInputs', () => {
  it('has nothing for a plain worker', () => {
    expect(labels({main: 'src/index.ts'})).toEqual([])
  })

  it('lists each field', () => {
    expect(
      labels({
        assets: {directory: './public'},
        data_blobs: {D: 'd.bin'},
        site: {bucket: './site'},
        text_blobs: {T: 't.txt'},
        unsafe: {capnp: {base_path: 'schema', compiled_schema: 'c.capnp.bin', source_schemas: ['a.capnp']}},
        wasm_modules: {W: 'w.wasm'},
      }),
    ).toEqual(['assets', 'site', 'wasm_modules:W', 'text_blobs:T', 'data_blobs:D', 'capnp:compiled', 'capnp:source:a.capnp'])
  })

  it('uses the env value of assets, inherited or not', () => {
    const config = {assets: {directory: './top'}, env: {a: {assets: {directory: './own'}}, b: {}}}
    const pathsOf = (env: string) => externalInputs(config, env, '/worker').map(({path}) => path.replaceAll('\\', '/'))

    expect(pathsOf('a')[0]).toMatch(/\/worker\/own$/)
    expect(pathsOf('b')[0]).toMatch(/\/worker\/top$/)
  })

  it('takes a site from an env section as well, where wrangler only warns about it', () => {
    expect(sitePaths({env: {a: {site: {bucket: './own'}}}, site: {bucket: './top'}})).toEqual([expect.stringMatching(/\/worker\/top$/), expect.stringMatching(/\/worker\/own$/)])
    expect(sitePaths({env: {a: {site: {bucket: './own'}}}})).toEqual([expect.stringMatching(/\/worker\/own$/)])
  })

  it('reads containers and unsafe from the env alone, as they do not inherit', () => {
    const containers = [{class_name: 'C', image: './Dockerfile'}]
    const config = {containers, env: {a: {}, b: {containers}}}

    expect(labels(config, 'a')).toEqual([])
    expect(labels(config, 'b')).toEqual(['container:C:dockerfile', 'container:C:context'])
  })

  it('takes the Dockerfile directory as the default build context, and a named context when there is one', () => {
    const inputs = externalInputs(
      {containers: [{class_name: 'A', image: './docker/Dockerfile'}, {class_name: 'B', image: './Dockerfile', image_build_context: './ctx'}]},
      undefined,
      '/worker',
    )
    const contexts = inputs.filter(({type}) => type === 'tree').map(({path}) => path.replaceAll('\\', '/'))

    expect(contexts[0]).toMatch(/\/worker\/docker$/)
    expect(contexts[1]).toMatch(/\/worker\/ctx$/)
  })

  it('takes no input from an image in a registry', () => {
    expect(labels({containers: [{class_name: 'C', image: 'registry.example.com/app:1'}]})).toEqual([])
  })

  it('reads the named images of a container', () => {
    expect(labels({containers: [{images: {web: {build_context: './ctx', dockerfile: './Dockerfile'}}, name: 'C'}]})).toEqual([
      'container:C:web:dockerfile',
      'container:C:web:context',
    ])
  })
})

describe('fieldsNeedingDeploy', () => {
  it('names a site and containers, and nothing that versions upload carries', () => {
    expect(fieldsNeedingDeploy({assets: {directory: 'p'}, text_blobs: {A: 'a'}})).toEqual([])
    expect(fieldsNeedingDeploy({site: {bucket: 'p'}})).toEqual(['site'])
    expect(fieldsNeedingDeploy({env: {a: {containers: [{image: 'x'}]}}}, 'a')).toEqual(['containers'])
  })
})
