import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {ConfigError} from '../config/types.js'
import type {OptionFlags} from '../project/options.js'
import {WORKER_CONFIG_FILE} from '../project/workers.js'
import {loadOptions} from './project.js'

const VALID_NAME = /^[a-z0-9][a-z0-9-]*$/
const COMPATIBILITY_DATE = '2025-09-01'
const IGNORED_PATHS = ['.wrangler', '.monocf']

const INDEX_TS = `export default {
  async fetch(): Promise<Response> {
    return new Response('Hello from your worker')
  },
}
`

const TSCONFIG = {
  compilerOptions: {
    lib: ['esnext'],
    module: 'esnext',
    moduleResolution: 'bundler',
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: 'esnext',
  },
  include: ['src'],
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** A base config supplies the name and the dates, and a worker config repeats only what it changes. */
function workerConfig(name: string, hasBase: boolean): string {
  return hasBase
    ? toJson({main: 'src/index.ts'})
    : toJson({compatibility_date: COMPATIBILITY_DATE, main: 'src/index.ts', name})
}

function addToGitignore(rootDir: string, lines: string[]): void {
  const path = join(rootDir, '.gitignore')
  const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const present = new Set(content.split(/\r?\n/).map((line) => line.trim()))
  const missing = lines.filter((line) => !present.has(line))
  if (missing.length === 0) return
  const separator = content === '' || content.endsWith('\n') ? '' : '\n'
  appendFileSync(path, `${separator}${missing.join('\n')}\n`)
}

/** `monocf worker create`: writes a minimal worker from what's embedded here, with no network and no install. */
export function createWorker(name: string, flags: OptionFlags): void {
  if (!VALID_NAME.test(name)) {
    throw new ConfigError(
      `Invalid worker name "${name}". Use lowercase letters, digits and dashes, starting with a letter or a digit.`,
    )
  }

  const options = loadOptions(flags)
  const workersDir = join(options.rootDir, options.workersDirName)
  if (!existsSync(workersDir)) {
    throw new ConfigError(`Workers directory not found at ${workersDir}. Please check the workers directory.`)
  }

  const target = join(workersDir, name)
  if (existsSync(target)) throw new ConfigError(`${target} already exists.`)

  mkdirSync(join(target, 'src'), {recursive: true})
  writeFileSync(join(target, WORKER_CONFIG_FILE), workerConfig(name, options.baseConfigPath !== undefined))
  writeFileSync(join(target, 'package.json'), toJson({name, private: true, version: '0.0.0'}))
  writeFileSync(join(target, 'tsconfig.json'), toJson(TSCONFIG))
  writeFileSync(join(target, 'src', 'index.ts'), INDEX_TS)
  addToGitignore(options.rootDir, IGNORED_PATHS)

  process.stderr.write(`Created ${target}. Install its dependencies with your package manager.\n`)
}
