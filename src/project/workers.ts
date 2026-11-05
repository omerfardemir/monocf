import {isAbsolute, join, posix, relative, sep} from 'node:path'
import ignore from 'ignore'

import {ConfigError} from '../config/types.js'
import {nodeReader, type FileReader} from './load.js'
import type {Options} from './options.js'

export const WORKER_CONFIG_FILE = 'wrangler.jsonc'
export const IGNORE_FILE = '.monocfignore'

type WorkerLocation = Pick<Options, 'rootDir' | 'workersDirName'>
type IgnoreOptions = WorkerLocation & Pick<Options, 'env'>

export function workerPath({rootDir, workersDirName}: WorkerLocation, dir: string): string {
  return join(rootDir, workersDirName, dir)
}

/** Lists every directory in the workers directory that has a wrangler config, ignored or not, sorted. */
export function discoverWorkers(options: WorkerLocation, reader: FileReader = nodeReader): string[] {
  const workersDir = join(options.rootDir, options.workersDirName)
  if (!reader.exists(workersDir)) {
    throw new ConfigError(`Workers directory not found at ${workersDir}. Please check the workers directory.`)
  }

  return reader
    .readDir(workersDir)
    .filter((dir) => reader.exists(join(workerPath(options, dir), WORKER_CONFIG_FILE)))
    .sort()
}

/** The worker whose directory contains `cwd`. A project with no workers directory name has no such thing. */
export function inferWorker({rootDir, workersDirName}: WorkerLocation, cwd: string): string | undefined {
  if (workersDirName === '') return undefined
  const path = relative(join(rootDir, workersDirName), cwd)
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined
  return path.split(sep)[0]
}

export interface IgnoreScope {
  envs: string[]
  kind: 'except' | 'in'
}

export interface IgnoreLine {
  /** What goes to the matcher: the line as written, without its scope. */
  pattern: string
  /** Why the scope can't be read. No env gets such a line, and a command that selects workers stops on it. */
  problem?: string
  scope?: IgnoreScope
  /** The line as written. */
  text: string
}

/** The first whole word `in` or `except` after the pattern starts a scope. An escaped space belongs to the pattern. */
const SCOPED_LINE = /^(.*?\S)(?<!\\)\s+(in|except)(?:\s+(.*))?$/
const ENV_NAME = /^[^\s,#]+$/

function scopeProblem(list: string, envs: string[]): string | undefined {
  if (list === '') return 'it names no environment'
  if (envs.includes('')) return 'its list of environments has an empty name'
  const bad = envs.find((env) => !ENV_NAME.test(env))
  return bad === undefined ? undefined : `"${bad}" isn't an environment name. Separate names with commas, and put a comment on a line of its own`
}

/** Whitespace with no backslash of its own before it. A backslash that a backslash escapes doesn't count. */
const UNESCAPED_SPACE = /(?:^|[^\\])(?:\\\\)*\s/

/** Takes the line without its trailing whitespace, which gitignore drops, and nothing else: the matcher keeps what's at the start. */
function patternProblem(pattern: string): string | undefined {
  if (/^\s/.test(pattern)) return 'it starts with whitespace, so its pattern would match nothing. Take the whitespace out'
  return UNESCAPED_SPACE.test(pattern)
    ? `its pattern "${pattern}" holds a space. A scope is a lower-case \`in\` or \`except\` and a list of environments, a space in a directory name is written "\\ ", and a comment needs a line of its own`
    : undefined
}

function malformed(text: string, problem: string | undefined): Pick<IgnoreLine, 'problem'> {
  return problem === undefined ? {} : {problem: `The ${IGNORE_FILE} line "${text.trim()}" is malformed: ${problem}.`}
}

function parseIgnoreLine(text: string): IgnoreLine {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return {pattern: text, text}

  const line = text.trimEnd()
  const scoped = SCOPED_LINE.exec(line)
  if (scoped === null) return {pattern: text, ...malformed(text, patternProblem(line)), text}

  const [, pattern, kind, list = ''] = scoped
  const envs = list.split(/,[ \t]*/)
  return {
    pattern,
    ...malformed(text, patternProblem(pattern) ?? scopeProblem(list, envs)),
    scope: {envs, kind: kind as IgnoreScope['kind']},
    text,
  }
}

/** What a pattern can match a worker by: its directory name and, while that stays under the root, its path from the root. */
function namesOf(worker: string, {workersDirName}: WorkerLocation): string[] {
  const path = posix.join(workersDirName.replaceAll('\\', '/'), worker)
  return path !== worker && ignore.isPathValid(path) ? [worker, path] : [worker]
}

function matcherOf(patterns: string, location: WorkerLocation): (worker: string) => boolean {
  const matcher = ignore().add(patterns)
  // A line with a trailing slash means a directory, and to the matcher only a path ending in one is a directory.
  return (worker) => namesOf(worker, location).some((path) => matcher.ignores(path) || matcher.ignores(`${path}/`))
}

/** Whether the line's pattern, whichever way `!` turns it, reaches any of these directories. */
export function matchesDirectory({pattern}: IgnoreLine, location: WorkerLocation, directories: string[]): boolean {
  return directories.some(matcherOf(pattern.replace(/^!/, ''), location))
}

/** Every line of the ignore file, comments and blank lines too, in order. */
export function readIgnoreLines(options: WorkerLocation, reader: FileReader = nodeReader): IgnoreLine[] {
  const ignorePath = join(options.rootDir, IGNORE_FILE)
  if (!reader.exists(ignorePath)) return []
  const lines = reader
    .readFile(ignorePath)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((text) => parseIgnoreLine(text))
  if (!lines.some(({problem, scope}) => scope !== undefined && problem === undefined)) return lines

  // A scope says someone meant this line for a worker, so unlike a plain line a removed worker left behind, matching nothing is a mistyped path.
  const directories = reader.readDir(join(options.rootDir, options.workersDirName))
  return lines.map((line) =>
    line.scope === undefined || line.problem !== undefined || matchesDirectory(line, options, directories)
      ? line
      : {...line, ...malformed(line.text, `its pattern "${line.pattern}" matches no directory`)},
  )
}

function appliesTo({problem, scope}: IgnoreLine, env: string | undefined): boolean {
  if (problem !== undefined) return false
  if (scope === undefined) return true
  const named = env !== undefined && scope.envs.includes(env)
  return scope.kind === 'in' ? named : !named
}

function matchedBy(lines: IgnoreLine[], location: WorkerLocation, workers: string[]): string[] {
  return workers.filter(matcherOf(lines.map(({pattern}) => pattern).join('\n'), location))
}

/**
 * What these lines ignore in `options.env`: the lines that apply to it, in order, so `!` and last-match-wins hold. A malformed
 * line counts for nothing here, so use this only where something reports it.
 */
export function ignoredIn(lines: IgnoreLine[], options: IgnoreOptions, workers: string[]): string[] {
  return matchedBy(lines.filter((line) => appliesTo(line, options.env)), options, workers)
}

/** Applies the ignore file for `options.env`. Patterns match a directory name or its path from the root, as in `workers/orders`. */
export function findIgnoredWorkers(options: IgnoreOptions, workers: string[], reader: FileReader = nodeReader): string[] {
  const lines = readIgnoreLines(options, reader)
  // Nothing says what this line was meant to leave out, so running anything could deploy what it was written to stop.
  const malformed = lines.find(({problem}) => problem !== undefined)
  if (malformed) throw new ConfigError(malformed.problem!)
  return ignoredIn(lines, options, workers)
}

/** Each env a scope names that isn't defined, as a message. `defined` is only asked for when there's a scope to compare. */
export function unknownEnvProblems(lines: IgnoreLine[], defined: () => string[]): string[] {
  const scoped = lines.filter(({problem, scope}) => scope !== undefined && problem === undefined)
  if (scoped.length === 0) return []
  const envs = defined()
  return scoped.flatMap(({scope, text}) =>
    scope!.envs.filter((env) => !envs.includes(env)).map((env) => `The ${IGNORE_FILE} line "${text.trim()}" names the env ${env}, which no worker defines.`),
  )
}

/** What's ignored in `options.env` only because of a scope. The lines with no scope wouldn't ignore these by themselves. */
export function ignoredByScope(options: IgnoreOptions, workers: string[], reader: FileReader = nodeReader): string[] {
  const lines = readIgnoreLines(options, reader)
  const always = matchedBy(lines.filter(({problem, scope}) => problem === undefined && scope === undefined), options, workers)
  return ignoredIn(lines, options, workers).filter((worker) => !always.includes(worker))
}

function ignoredMessage(name: string, env: string | undefined): string {
  return env === undefined
    ? `Worker ${name} is ignored by ${IGNORE_FILE} when no env is given. Pass an env it isn't ignored in with -e, or change its line in that file.`
    : `Worker ${name} is ignored in ${env} by ${IGNORE_FILE}. To run it in ${env}, change its line in that file: remove it, or give it a scope that leaves ${env} out.`
}

/**
 * Picks the workers a command runs for. The ignore list removes workers from a bulk selection, and only there:
 * an ignored worker stays discoverable as a binding target, and naming one is an error rather than a silent no-op.
 */
export function selectWorkers(workers: string[], ignored: string[], name?: string, env?: string): string[] {
  if (name === undefined) {
    const selected = workers.filter((worker) => !ignored.includes(worker))
    if (selected.length === 0) throw new ConfigError('No workers found.')
    return selected
  }

  if (!workers.includes(name)) throw new ConfigError(`Worker not found: ${name}. Please check the worker name.`)
  if (ignored.includes(name)) throw new ConfigError(ignoredMessage(name, env))

  return [name]
}
