import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {createFixture, runCli} from '../helpers/harness.js'

interface Project {
  /** Flags after `-c build`. */
  args?: string[]
  config?: Record<string, unknown>
  /** Files of the worker, keyed by path relative to its directory. */
  files?: Record<string, string>
  /** Files keyed by path relative to the project root. */
  rootFiles?: Record<string, string>
}

function project({config, files = {}, rootFiles = {}}: Project) {
  return createFixture({
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

function copyOfPackage(modules: string, marker: string): Record<string, string> {
  return {
    [`${modules}/shim-pkg/index.js`]: `module.exports = '${marker}'\n`,
    [`${modules}/shim-pkg/package.json`]: JSON.stringify({main: 'index.js', name: 'shim-pkg', version: '1.0.0'}),
  }
}

describe('real wrangler finds what the rebased config points at', {timeout: 180_000}, () => {
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
  })
})
