import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'

import {ConfigError} from '../config/types.js'
import {findConfigFile, loadProjectFile} from '../project/load.js'
import {resolveOptions, type OptionFlags, type Options} from '../project/options.js'
import {discoverWorkers, findIgnoredWorkers, inferWorker, selectWorkers} from '../project/workers.js'

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
  return {ignored, selected: selectWorkers(workers, ignored, target)}
}

/** Every worker the ignore file leaves in. */
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
  return {ignored, selected: [...new Set(names.flatMap((name) => selectWorkers(workers, ignored, name)))].sort()}
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
