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

/** The commit a deployed version is labelled with. Resolved once per run. */
export function resolveRelease(rootDir: string, notice: (message: string) => void): string {
  const {GITHUB_SHA: sha} = process.env
  if (sha) return sha.slice(0, SHORT_SHA_LENGTH)

  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    notice('Could not read the git commit, so RELEASE is "unknown".')
    return 'unknown'
  }
}
