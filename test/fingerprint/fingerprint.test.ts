import {describe, expect, it} from 'vitest'

import {
  bundleHash,
  canonicalConfig,
  canonicalJson,
  configHash,
  doHash,
  fingerprintOf,
  isHashed,
  normaliseModule,
  parseExportNames,
  sha256,
  triggersHash,
  triggersOf,
} from '../../src/fingerprint/fingerprint.js'

const HEX_64 = /^[0-9a-f]{64}$/

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({b: 1, a: {d: [{z: 1, y: 2}, 3], c: 2}})).toBe('{"a":{"c":2,"d":[{"y":2,"z":1},3]},"b":1}')
  })
})

function file(path: string, bytes = 'code') {
  return {bytes, path}
}

function storeModule(dir: string, code = 'var a = 1;') {
  return `// ../../../../node_modules/.pnpm/${dir}/node_modules/pkg/index.js\n${code}\n"../../node_modules/.pnpm/${dir}/node_modules/pkg/cjs.js"() {}\n`
}

describe('bundleHash', () => {
  it('is 64 hex characters', () => {
    expect(bundleHash([file('index.js')])).toMatch(HEX_64)
  })

  it('does not depend on the order of the files or on the path separator', () => {
    const a = bundleHash([file('index.js'), file('lib/a.js')])
    expect(bundleHash([file(String.raw`lib\a.js`), file('index.js')])).toBe(a)
  })

  it('changes with content, with a path, and with bytes moved between files', () => {
    const a = bundleHash([file('index.js'), file('b.js', 'x')])
    expect(bundleHash([file('index.js', 'other'), file('b.js', 'x')])).not.toBe(a)
    expect(bundleHash([file('main.js'), file('b.js', 'x')])).not.toBe(a)
    expect(bundleHash([file('a', 'xy'), file('b', 'z')])).not.toBe(bundleHash([file('a', 'x'), file('b', 'yz')]))
  })

  it('ignores README.md, source maps and wrangler configs', () => {
    const a = bundleHash([file('index.js')])
    expect(
      bundleHash([
        file('index.js'),
        file('README.md', 'Generated at 12:00'),
        file('index.js.map', 'x'),
        file('nested/a.js.map', 'x'),
        file('wrangler.json', 'x'),
        file('wrangler.jsonc', 'x'),
      ]),
    ).toBe(a)
  })

  it('counts a module that only shares a name with those, in a subdirectory', () => {
    expect(isHashed('docs/README.md')).toBe(true)
    expect(isHashed('data/wrangler.json')).toBe(true)
    expect(isHashed('README.md')).toBe(false)
  })

  describe('pnpm store directories', () => {
    it('hashes one package the same under the spellings Windows and Linux give it', () => {
      const windows = storeModule('pkg@0._771bc3ff602e092045a03cb18eea')
      const linux = storeModule('pkg@0.2.0_@standard-schema+spec@1.1.0')
      expect(bundleHash([file('index.js', windows)])).toBe(bundleHash([file('index.js', linux)]))
    })

    it('still sees a change in the code', () => {
      const before = storeModule('pkg@1.0.0', 'var a = 1;')
      const after = storeModule('pkg@1.0.1', 'var a = 2;')
      expect(bundleHash([file('index.js', before)])).not.toBe(bundleHash([file('index.js', after)]))
    })

    it('still sees which package a module comes from', () => {
      const one = '// ../node_modules/.pnpm/a@1/node_modules/a/index.js\n'
      const other = '// ../node_modules/.pnpm/b@1/node_modules/b/index.js\n'
      expect(bundleHash([file('index.js', one)])).not.toBe(bundleHash([file('index.js', other)]))
    })

    it('touches scripts only, and keeps non-text bytes as they are', () => {
      const path = 'node_modules/.pnpm/a@1/node_modules/'
      const other = 'node_modules/.pnpm/b@1/node_modules/'
      expect(bundleHash([file('data.txt', path)])).not.toBe(bundleHash([file('data.txt', other)]))
      const binary = Uint8Array.from([0, 200, 255, 10])
      expect(normaliseModule('index.js', binary)).toEqual(Buffer.from(binary))
    })
  })

  it('reads CRLF as different bytes, because they are', () => {
    expect(bundleHash([file('index.js', 'a\r\n')])).not.toBe(bundleHash([file('index.js', 'a\n')]))
  })
})

describe('configHash', () => {
  const config = {
    env: {production: {vars: {A: '1'}}, staging: {name: 'x-staging', vars: {A: '1', VERSION: '1.0.0'}}},
    name: 'x',
  }

  it('does not depend on key order', () => {
    const reordered = {
      name: 'x',
      env: {staging: {vars: {VERSION: '1.0.0', A: '1'}, name: 'x-staging'}, production: {vars: {A: '1'}}},
    }
    expect(configHash(reordered, 'staging')).toBe(configHash(config, 'staging'))
  })

  it('changes with VERSION', () => {
    const bumped = structuredClone(config)
    bumped.env.staging.vars.VERSION = '1.0.1'
    expect(configHash(bumped, 'staging')).not.toBe(configHash(config, 'staging'))
  })

  it('does not change with RELEASE, wherever it sits', () => {
    const released = structuredClone(config) as typeof config & {vars?: object}
    released.vars = {RELEASE: 'abc'}
    ;(released.env.staging.vars as Record<string, string>).RELEASE = 'abc'
    const canonical = canonicalConfig(released, 'staging')
    expect(JSON.stringify(canonical)).not.toContain('RELEASE')
    expect(configHash({...released, vars: {RELEASE: 'def'}}, 'staging')).toBe(configHash(released, 'staging'))
  })

  it('changes with a value in the selected env only', () => {
    const changed = structuredClone(config)
    changed.env.production.vars.A = '2'
    expect(configHash(changed, 'staging')).toBe(configHash(config, 'staging'))
    expect(configHash(changed, 'production')).not.toBe(configHash(config, 'production'))
  })

  it('changes with a top-level field, since an env can inherit it', () => {
    expect(configHash({...config, main: 'a.ts'}, 'staging')).not.toBe(configHash(config, 'staging'))
  })

  it('leaves out env sections with no env', () => {
    expect(canonicalConfig({env: {a: {}}, name: 'x'})).toEqual({name: 'x'})
  })
})

describe('fingerprintOf', () => {
  it('is the hash of both hashes, on two lines', () => {
    expect(fingerprintOf('a', 'b', 'c')).toBe(sha256('a\nb\nc'))
    expect(fingerprintOf('a', 'b', 'c')).toMatch(HEX_64)
    expect(`monocf:${fingerprintOf('a', 'b', 'c')}`.length).toBeLessThanOrEqual(100)
  })
})

describe('triggersOf', () => {
  it('gives defaults with nothing set', () => {
    expect(triggersOf({})).toEqual({crons: null, previewUrls: null, routes: [], workersDev: true})
  })

  it('tells an empty list of crons from none, as wrangler does', () => {
    expect(triggersOf({triggers: {crons: []}}).crons).toEqual([])
    expect(triggersOf({triggers: {}}).crons).toBeNull()
  })

  it('inherits every field from the top level', () => {
    const config = {
      env: {staging: {}},
      preview_urls: false,
      routes: ['a.com/*'],
      triggers: {crons: ['* * * * *']},
      workers_dev: true,
    }
    expect(triggersOf(config, 'staging')).toEqual({
      crons: ['* * * * *'],
      previewUrls: false,
      routes: ['a.com/*'],
      workersDev: true,
    })
  })

  it('lets the env section win', () => {
    const config = {
      env: {staging: {preview_urls: true, routes: [], triggers: {crons: []}, workers_dev: false}},
      preview_urls: false,
      routes: ['a.com/*'],
      triggers: {crons: ['* * * * *']},
      workers_dev: true,
    }
    expect(triggersOf(config, 'staging')).toEqual({crons: [], previewUrls: true, routes: [], workersDev: false})
  })

  it('reads a single route, and turns workers_dev off by default when routes exist', () => {
    expect(triggersOf({route: 'a.com/*'})).toEqual({crons: null, previewUrls: null, routes: ['a.com/*'], workersDev: false})
  })
})

describe('triggersHash', () => {
  it('follows the content', () => {
    const triggers = triggersOf({routes: ['a.com/*']})
    expect(triggersHash(triggers)).toMatch(HEX_64)
    expect(triggersHash({...triggers})).toBe(triggersHash(triggers))
    expect(triggersHash({...triggers, workersDev: true})).not.toBe(triggersHash(triggers))
  })
})

describe('doHash', () => {
  const migrations = [{new_sqlite_classes: ['Room'], tag: 'v1'}]

  it('changes with migrations and exports', () => {
    expect(doHash({migrations})).not.toBe(doHash({}))
    expect(doHash({exports: {Room: {}}})).not.toBe(doHash({}))
  })

  it('does not change with a binding alone', () => {
    const bindings = {durable_objects: {bindings: [{class_name: 'Room', name: 'ROOM'}]}}
    expect(doHash({...bindings, migrations})).toBe(doHash({migrations}))
  })

  it('inherits from the top level, and lets the env section win', () => {
    expect(doHash({env: {staging: {}}, migrations}, 'staging')).toBe(doHash({migrations}))
    expect(doHash({env: {staging: {migrations: []}}, migrations}, 'staging')).not.toBe(doHash({migrations}))
  })
})

describe('parseExportNames', () => {
  it('reads the closing statement of esbuild output', () => {
    expect(parseExportNames('var a = 1;\nexport {\n  Api,\n  worker as default\n};\n')).toEqual(['Api', 'default'])
  })

  it('reads one line, and a trailing source map comment', () => {
    expect(parseExportNames('export { a, b as default };\n//# sourceMappingURL=index.js.map\n')).toEqual(['a', 'default'])
  })

  it('reads a quoted export name', () => {
    expect(parseExportNames('export { a as "my name" };\n')).toEqual(['my name'])
  })

  it('reads an empty list', () => {
    expect(parseExportNames('export {};\n')).toEqual([])
  })

  it.each(['', 'var a = 1;\n', 'export default {};\n', 'export { a };\nvar later = 1;\n'])('gives up on %j', (source) => {
    expect(parseExportNames(source)).toBeUndefined()
  })
})
