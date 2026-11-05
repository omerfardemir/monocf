import {execFileSync} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path'

import {ConfigError} from '../config/types.js'
import {isSameOrWithin} from '../fingerprint/external.js'
import {findConfigFile, loadProjectFile} from '../project/load.js'
import {resolveOptions, type OptionFlags, type Options} from '../project/options.js'
import {discoverWorkers, findIgnoredWorkers, ignoredIn, inferWorker, readIgnoreLines, selectWorkers} from '../project/workers.js'

const SHORT_SHA_LENGTH = 7

/** Combines flags and the project config. With --root-dir, the config is looked for from there. */
export function loadOptions(flags: OptionFlags, cwd: string = process.cwd()): Options {
  const configPath = findConfigFile(flags.rootDir ? resolve(cwd, flags.rootDir) : cwd)
  return resolveOptions({configPath, cwd, file: configPath ? loadProjectFile(configPath) : undefined, flags})
}

export interface Selection {
  ignored: string[]
  selected: string[]
}

/** Turns a worker argument, or the current directory, or --all into the workers a command runs for. */
export function selectFromArguments(options: Options, name?: string, cwd: string = process.cwd()): Selection {
  if (options.all && name !== undefined) throw new ConfigError('Worker name is not allowed when using --all flag')

  const target = name ?? (options.all ? undefined : inferWorker(options, cwd))
  if (!options.all && target === undefined) throw new ConfigError('Worker name is required if --all flag is not set')

  const workers = discoverWorkers(options)
  const ignored = findIgnoredWorkers(options, workers)
  return {ignored, selected: selectWorkers(workers, ignored, target, options.env)}
}

/** Every worker the ignore file leaves in for this env. */
export function selectAll(options: Options): Selection {
  const workers = discoverWorkers(options)
  const ignored = findIgnoredWorkers(options, workers)
  return {ignored, selected: selectWorkers(workers, ignored)}
}

/** The named workers, or all of them when none is named. */
export function selectNamed(options: Options, names: string[]): Selection {
  if (names.length === 0) return selectAll(options)
  const workers = discoverWorkers(options)
  const ignored = findIgnoredWorkers(options, workers)
  return {ignored, selected: [...new Set(names.flatMap((name) => selectWorkers(workers, ignored, name, options.env)))].sort()}
}

/**
 * What each env leaves in, for a command that looks at several and reports a malformed line itself. An env can leave nothing
 * in while another still has workers, but with nothing left in any env there's nothing to look at.
 */
export function selectPerEnv(options: Options, envs: (string | undefined)[]): (Selection & {env?: string})[] {
  const workers = discoverWorkers(options)
  const lines = readIgnoreLines(options)
  const selections = envs.map((env) => {
    const ignored = ignoredIn(lines, {...options, env}, workers)
    return {env, ignored, selected: workers.filter((worker) => !ignored.includes(worker))}
  })
  if (selections.every(({selected}) => selected.length === 0)) selectWorkers(workers, workers)
  return selections
}

function gitRevParse(rootDir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', ...args, 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

/** What is really checked out, whatever CI's variables say. Undefined without git. */
export function checkoutHead(rootDir: string): string | undefined {
  return gitRevParse(rootDir)
}

/** Whether the checkout differs from its commit, the bundle's own directory aside. Without git, nothing says that it doesn't. */
export function isTreeDirty(rootDir: string, bundleDir: string): boolean {
  const inside = relative(rootDir, bundleDir).replaceAll('\\', '/')
  const paths = inside === '' || inside.startsWith('..') || isAbsolute(inside) ? [] : ['--', '.', `:(exclude)${inside}`]
  try {
    const status = execFileSync('git', ['status', '--porcelain', ...paths], {cwd: rootDir, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'ignore']})
    return status.trim() !== ''
  } catch {
    return true
  }
}

/** A path that doesn't exist yet takes the real path of the deepest parent that does. */
export function realPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(realPath(parent), basename(path))
  }
}

/**
 * `apply` doesn't count what monocf writes as a change to the checkout, so a directory it writes can't also hold what gets
 * deployed: an uncommitted change in there would ship under the plan's fingerprint.
 */
export function assertHoldsNoSource(what: string, dir: string, {rootDir, workers}: {rootDir: string; workers: {dir: string; path: string}[]}): void {
  const real = realPath(dir)
  const contains = (path: string): boolean => isSameOrWithin(real, realPath(path))
  const held = contains(rootDir) ? 'the project root' : workers.find(({path}) => contains(path))?.dir
  if (held === undefined) return
  const name = held === 'the project root' ? held : `the worker ${held}`
  throw new ConfigError(`${what} ${dir} holds ${name}, so apply couldn't tell a change to the code from monocf's own files. Use a directory of its own.`)
}

const STATUS_MAX_BUFFER = 256 * 1024 * 1024

/**
 * What differs from the commit across the whole repository, as a worker can import from outside `rootDir`, apart from
 * `excluded`. Paths from the root, or undefined when git can't say.
 */
export function dirtyPaths(rootDir: string, excluded: string[]): string[] | undefined {
  const git = (...args: string[]): string => execFileSync('git', args, {cwd: rootDir, encoding: 'utf8', maxBuffer: STATUS_MAX_BUFFER, shell: false, stdio: ['ignore', 'pipe', 'ignore']})
  try {
    const top = realPath(git('rev-parse', '--show-toplevel').trim())
    const fields = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0')
    const skipped = excluded.map((path) => realPath(path))
    const paths: string[] = []
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index]
      if (field.length > 3) {
        paths.push(resolve(top, field.slice(3)))
        // A rename is followed by the name it came from, which an exempt new name mustn't hide. A copy's source hasn't changed.
        if (field[0] === 'R' || field[1] === 'R') paths.push(resolve(top, fields[++index]))
        else if (field[0] === 'C' || field[1] === 'C') index++
      }
    }

    // Git answers with the real path, and the root may not be one: a link, or a short name such as RUNNER~1 on Windows.
    const root = realPath(rootDir)
    return paths.filter((path) => !skipped.some((skip) => isSameOrWithin(skip, path))).map((path) => relative(root, path).replaceAll('\\', '/'))
  } catch {
    return undefined
  }
}

/** The commit a deployed version is labelled with. Resolved once per run. */
export function resolveRelease(rootDir: string, notice: (message: string) => void): string {
  const {GITHUB_SHA: sha} = process.env
  if (sha) return sha.slice(0, SHORT_SHA_LENGTH)

  const short = gitRevParse(rootDir, '--short')
  if (short !== undefined) return short
  notice('Could not read the git commit, so RELEASE is "unknown".')
  return 'unknown'
}

/** The full commit a bundle manifest records. */
export function resolveCommit(rootDir: string, notice: (message: string) => void): string {
  const commit = process.env.GITHUB_SHA || gitRevParse(rootDir)
  if (commit) return commit
  notice('Could not read the git commit, so the manifest says "unknown".')
  return 'unknown'
}
