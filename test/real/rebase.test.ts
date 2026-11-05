import {execFileSync, spawnSync} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {rebaseConfig} from '../../src/runtime/path-fields.js'
import {createFixture, runCli, runRealWrangler, startCli} from '../helpers/harness.js'

interface Project {
  /** Flags after `-c build`. */
  args?: string[]
  /** Merged over the base config. */
  base?: Record<string, unknown>
  config?: Record<string, unknown>
  /** Files of the worker, keyed by path relative to its directory. */
  files?: Record<string, string>
  /** Files keyed by path relative to the project root. */
  rootFiles?: Record<string, string>
}

function project({base, config, files = {}, rootFiles = {}}: Project) {
  return createFixture({
    base,
    environments: ['staging'],
    files: {
      ...rootFiles,
      ...Object.fromEntries(Object.entries(files).map(([path, content]) => [`workers/orders/${path}`, content])),
    },
    wrangler: 'real',
    workers: [{config, name: 'orders'}],
  })
}

/** Builds with real wrangler, offline, and gives back the bundle: the test checks what wrangler made of the file. */
async function bundleOf(spec: Project): Promise<string> {
  const fixture = project(spec)
  const result = await runCli(fixture, ['worker', 'orders', '-c', 'build', ...(spec.args ?? [])])
  expect(result.exitCode, result.stderr).toBe(0)
  return readFileSync(join(fixture.worker('orders'), 'dist', 'index.js'), 'utf8')
}

const respondsWith = (expression: string) => `export default {fetch: () => new Response(${expression})}\n`

/** A tsconfig that maps an import to a file holding this marker, so the marker shows which tsconfig was read. */
function mapped(marker: string, file: string): Record<string, string> {
  return {
    [file]: JSON.stringify({compilerOptions: {baseUrl: '..', paths: {'via-tsconfig': [`lib/${marker}.ts`]}}}),
    [`lib/${marker}.ts`]: `export const value = '${marker}'\n`,
  }
}

/** The exit code of a build, for a field whose file shows up in no bundle: wrangler reads it, or fails to. */
async function exitOf(spec: Project): Promise<number | null> {
  const result = await runCli(project(spec), ['worker', 'orders', '-c', 'build'])
  return result.exitCode
}

/** The test image is a Linux one, and a Windows runner's Docker has Windows containers. */
const dockerRuns = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {encoding: 'utf8'}).stdout?.trim() === 'linux'
const serviceWorker = (body: string) => `addEventListener('fetch', (event) => event.respondWith(new Response(${body})))\n`

function copyOfPackage(modules: string, marker: string): Record<string, string> {
  return {
    [`${modules}/shim-pkg/index.js`]: `module.exports = '${marker}'\n`,
    [`${modules}/shim-pkg/package.json`]: JSON.stringify({main: 'index.js', name: 'shim-pkg', version: '1.0.0'}),
  }
}

function pythonProject(main: string, files: Record<string, string>) {
  return createFixture({
    environments: ['staging'],
    files: Object.fromEntries(Object.entries(files).map(([path, content]) => [`workers/orders/${path}`, content])),
    wrangler: 'real',
    workers: [{config: {compatibility_flags: ['python_workers'], main}, name: 'orders'}],
  })
}

describe('real wrangler: a Python worker', {timeout: 180_000}, () => {
  const python = 'from foo import x\nfrom workers import Response\ndef on_fetch(request):\n    return Response(x)\n'
  const modules = {'python_modules/foo/__init__.py': 'x = "from-a-vendored-module"\n'}

  it('keeps python_modules, which wrangler reads from next to the config', async () => {
    const fixture = pythonProject('src/entry.py', {...modules, 'src/entry.py': python})

    const result = await runCli(fixture, ['bundle', 'orders', '-e', 'staging'])

    expect(result.exitCode, result.stderr).toBe(0)
    const output = join(fixture.root, '.monocf', 'bundle', 'staging', 'orders', 'python_modules', 'foo', '__init__.py')
    expect(readFileSync(output, 'utf8')).toContain('from-a-vendored-module')
  })

  it('leaves the limit of an entry at the top of the directory to wrangler, which says so', async () => {
    const fixture = pythonProject('entry.py', {...modules, 'entry.py': python})

    const result = await runCli(fixture, ['bundle', 'orders', '-e', 'staging'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('python_modules')
  })
})

describe('real wrangler finds what the rebased config points at', {timeout: 180_000}, () => {
  describe('main', () => {
    const files = {
      'src/index.ts': respondsWith("'from-the-top-main'"),
      'src/staging.ts': respondsWith("'from-the-env-main'"),
    }

    it('at the top level', async () => {
      expect(await bundleOf({files})).toContain('from-the-top-main')
    })

    it('under an env', async () => {
      const fixture = project({config: {env: {staging: {main: 'src/staging.ts'}}}, files})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build', '-e', 'staging'])

      expect(result.exitCode, result.stderr).toBe(0)
      expect(readFileSync(join(fixture.worker('orders'), 'dist', 'staging.js'), 'utf8')).toContain('from-the-env-main')
    })
  })

  describe('assets.directory', () => {
    const config = {assets: {directory: './public'}}

    it('reads the directory', async () => {
      expect(await exitOf({config, files: {'public/index.html': 'hello'}})).toBe(0)
    })

    it('fails when it is not there', async () => {
      expect(await exitOf({config})).toBe(1)
    })
  })

  describe('base_dir', () => {
    it('finds the additional modules under it, with the globs of rules', async () => {
      const fixture = project({
        config: {
          base_dir: './lib',
          find_additional_modules: true,
          main: './lib/index.js',
          rules: [{globs: ['extra/*.js'], type: 'ESModule'}],
        },
        files: {
          'lib/extra/more.js': `export const more = 'from-an-additional-module'\n`,
          'lib/index.js': `const {more} = await import('./extra/more.js')\n${respondsWith('more')}`,
        },
      })

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'])

      expect(result.exitCode, result.stderr).toBe(0)
      const module = readFileSync(join(fixture.worker('orders'), 'dist', 'extra', 'more.js'), 'utf8')
      expect(module).toContain('from-an-additional-module')
    })
  })

  describe.each([
    ['wasm_modules', 'a.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]).toString('latin1')],
    ['text_blobs', 'a.txt', 'text'],
    ['data_blobs', 'a.bin', 'data'],
  ])('%s', (field, file, content) => {
    const worker = {'src/index.ts': serviceWorker('typeof MAPPED')}
    const config = {[field]: {MAPPED: file}}

    it('reads the file', async () => {
      expect(await exitOf({config, files: {...worker, [file]: content}})).toBe(0)
    })

    it('fails when it is not there', async () => {
      expect(await exitOf({config, files: worker})).toBe(1)
    })

    it('under an env', async () => {
      const result = await runCli(
        project({config: {env: {staging: config}}, files: {...worker, [file]: content}}),
        ['worker', 'orders', '-c', 'build', '-e', 'staging'],
      )

      expect(result.exitCode, result.stderr).toBe(0)
    })
  })

  describe('unsafe.capnp', () => {
    const config = {
      unsafe: {bindings: [{name: 'SCHEMA', type: 'internal_capnp_test'}], capnp: {compiled_schema: 'schema.bin'}},
    }

    it('reads compiled_schema', async () => {
      expect(await exitOf({config, files: {'schema.bin': 'compiled'}})).toBe(0)
    })

    it('fails when compiled_schema is not there', async () => {
      expect(await exitOf({config})).toBe(1)
    })
  })

  describe.runIf(dockerRuns)('containers, which need Docker', () => {
    const dockerfile = 'FROM scratch\nCOPY only-in-the-context.txt /\n'

    it('reads image and image_build_context', async () => {
      const config = {
        containers: [{class_name: 'Box', image: './docker/Dockerfile', image_build_context: './context', max_instances: 1}],
        durable_objects: {bindings: [{class_name: 'Box', name: 'BOX'}]},
        migrations: [{new_sqlite_classes: ['Box'], tag: 'v1'}],
      }
      const files = {
        'context/only-in-the-context.txt': 'x',
        'docker/Dockerfile': dockerfile,
        'src/index.ts': `export class Box {}\n${respondsWith("'x'")}`,
      }

      expect(await exitOf({config, files})).toBe(0)
    })
  })

  describe('d1_databases, which only wrangler d1 reads', () => {
    it('reads migrations_dir and migrations_pattern from the rebased config', () => {
      const fixture = project({
        files: {'db/0001_first.sql': 'select 1;\n', 'db/skipped.txt': 'not a migration\n'},
      })
      const from = fixture.worker('orders')
      const to = join(fixture.root, '.monocf', 'runs', 'manual', 'orders')
      mkdirSync(to, {recursive: true})
      const config = rebaseConfig(
        {
          compatibility_date: '2025-01-09',
          d1_databases: [
            {
              binding: 'DB',
              database_id: '00000000-0000-0000-0000-000000000000',
              database_name: 'db',
              migrations_dir: 'db',
              migrations_pattern: 'db/*.sql',
            },
          ],
          name: 'orders',
        },
        {from, to},
      )
      writeFileSync(join(to, 'wrangler.json'), JSON.stringify(config))

      const {exitCode, output} = runRealWrangler(['d1', 'migrations', 'list', 'DB', '--local', '--config', 'wrangler.json'], to)

      expect(exitCode, output).toBe(0)
      expect(output).toContain('0001_first.sql')
      expect(output).not.toContain('skipped.txt')
    })
  })

  describe('tsconfig', () => {
    const files = {
      'src/index.ts': `import {value} from 'via-tsconfig'\n${respondsWith('value')}`,
    }

    it('at the top level', async () => {
      const bundle = await bundleOf({
        config: {tsconfig: 'config/custom.json'},
        files: {...files, ...mapped('from-the-top-tsconfig', 'config/custom.json')},
      })

      expect(bundle).toContain('from-the-top-tsconfig')
    })

    it('under an env', async () => {
      const bundle = await bundleOf({
        args: ['-e', 'staging'],
        config: {env: {staging: {tsconfig: 'config/staging.json'}}, tsconfig: 'config/custom.json'},
        files: {
          ...files,
          ...mapped('from-the-top-tsconfig', 'config/custom.json'),
          ...mapped('from-the-env-tsconfig', 'config/staging.json'),
        },
      })

      expect(bundle).toContain('from-the-env-tsconfig')
      expect(bundle).not.toContain('from-the-top-tsconfig')
    })
  })

  describe('alias', () => {
    const files = {'src/index.ts': `import value from 'aliased'\n${respondsWith('value')}`}
    const config = {alias: {aliased: 'shim-pkg'}}

    it('bundles the copy of a package the worker sees, when the root has another', async () => {
      const bundle = await bundleOf({
        config,
        files: {...files, ...copyOfPackage('node_modules', 'worker-copy')},
        rootFiles: copyOfPackage('node_modules', 'root-copy'),
      })

      expect(bundle).toContain('worker-copy')
      expect(bundle).not.toContain('root-copy')
    })

    it('finds a package only the worker has, as in a pnpm workspace', async () => {
      const bundle = await bundleOf({config, files: {...files, ...copyOfPackage('node_modules', 'worker-copy')}})

      expect(bundle).toContain('worker-copy')
    })

    it('finds a package only the root has', async () => {
      const bundle = await bundleOf({config, files, rootFiles: copyOfPackage('node_modules', 'root-copy')})

      expect(bundle).toContain('root-copy')
    })

    it('finds a relative path', async () => {
      const bundle = await bundleOf({
        config: {alias: {aliased: './lib/shim.ts'}},
        files: {...files, 'lib/shim.ts': `export default 'from-a-relative-alias'\n`},
      })

      expect(bundle).toContain('from-a-relative-alias')
    })

    it('fails the build on a package nothing has', async () => {
      const fixture = project({config, files})

      const result = await runCli(fixture, ['worker', 'orders', '-c', 'build'])

      expect(result.exitCode).toBe(1)
    })
  })

  describe('site', () => {
    it('reads site.bucket', async () => {
      const config = {site: {bucket: './static'}}

      expect(await exitOf({config, files: {'static/a.html': 'a'}})).toBe(0)
    })

    const noMain = {main: undefined}
    const files = {
      'static/a.html': 'a',
      'workers-site/index.js': respondsWith("'from-the-site-entry'"),
      'workers-site/package.json': JSON.stringify({name: 'site-worker', version: '1.0.0'}),
    }

    it('reads site.entry-point', async () => {
      const bundle = await bundleOf({
        base: noMain,
        config: {site: {bucket: './static', 'entry-point': 'workers-site/index.js'}},
        files,
      })

      expect(bundle).toContain('from-the-site-entry')
    })

    it('finds the default entry point of a site with no main', async () => {
      const bundle = await bundleOf({base: noMain, config: {site: {bucket: './static'}}, files})

      expect(bundle).toContain('from-the-site-entry')
    })
  })

  describe('build', () => {
    const generator = `import {writeFileSync} from 'node:fs'
import {basename, dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
const worker = dirname(dirname(fileURLToPath(import.meta.url)))
writeFileSync(join(worker, 'src', 'generated.ts'), \`export const at = 'ran-in-\${basename(process.cwd())}'\\n\`)
`
    const files = {
      'src/index.ts': `import {at} from './generated'\n${respondsWith('at')}`,
      'tools/generate.mjs': generator,
    }

    it('runs the command in build.cwd', async () => {
      const bundle = await bundleOf({config: {build: {command: 'node generate.mjs', cwd: 'tools'}}, files})

      expect(bundle).toContain('ran-in-tools')
    })

    it('runs the command in the worker with no build.cwd, and not in the run directory', async () => {
      const bundle = await bundleOf({config: {build: {command: 'node tools/generate.mjs'}}, files})

      expect(bundle).toContain('ran-in-orders')
    })

    it('rebuilds in dev when a file in build.watch_dir changes', async () => {
      const copy = `import {readFileSync, writeFileSync} from 'node:fs'
writeFileSync('src/generated.ts', 'export const at = ' + JSON.stringify(readFileSync('input/value.txt', 'utf8')))
`
      const fixture = project({
        config: {build: {command: 'node tools/copy.mjs', watch_dir: 'input'}},
        files: {...files, 'input/value.txt': 'first-value', 'tools/copy.mjs': copy},
      })
      const port = 18_760
      const running = startCli(fixture, ['worker', 'orders', '-c', 'dev', '-p', String(port)])
      const answers = async (expected: string): Promise<void> => {
        await expect
          .poll(
            async () => {
              try {
                const response = await fetch(`http://127.0.0.1:${port}/`, {signal: AbortSignal.timeout(3000)})
                return await response.text()
              } catch {
                return 'no answer'
              }
            },
            {interval: 500, timeout: 60_000},
          )
          .toBe(expected)
      }

      try {
        await answers('first-value')
        writeFileSync(join(fixture.worker('orders'), 'input', 'value.txt'), 'second-value')
        await answers('second-value')
      } finally {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/pid', String(running.child.pid), '/T', '/F'], {stdio: 'ignore'})
        } else {
          running.child.kill('SIGTERM')
        }

        await running.done
      }
    })
  })
})
