import {isAbsolute, join, posix, relative, sep} from 'node:path'
import ignore from 'ignore'

import {ConfigError} from '../config/types.js'
import {nodeReader, type FileReader} from './load.js'
import type {Options} from './options.js'

export const WORKER_CONFIG_FILE = 'wrangler.jsonc'
export const IGNORE_FILE = '.monocfignore'

type WorkerLocation = Pick<Options, 'rootDir' | 'workersDirName'>

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

/** Applies the ignore file. Patterns match a directory name or its path from the root, as in `workers/orders`. */
export function findIgnoredWorkers(
  options: WorkerLocation,
  workers: string[],
  reader: FileReader = nodeReader,
): string[] {
  const ignorePath = join(options.rootDir, IGNORE_FILE)
  if (!reader.exists(ignorePath)) return []

  const patterns = ignore().add(reader.readFile(ignorePath))
  const prefix = posix.normalize(options.workersDirName.replaceAll('\\', '/'))
  return workers.filter(
    (worker) => patterns.ignores(worker) || (prefix !== '.' && patterns.ignores(posix.join(prefix, worker))),
  )
}

/**
 * Picks the workers a command runs for. The ignore list removes workers from a bulk selection, and only there:
 * an ignored worker stays discoverable as a binding target, and naming one is an error rather than a silent no-op.
 */
export function selectWorkers(workers: string[], ignored: string[], name?: string): string[] {
  if (name === undefined) {
    const selected = workers.filter((worker) => !ignored.includes(worker))
    if (selected.length === 0) throw new ConfigError('No workers found.')
    return selected
  }

  if (!workers.includes(name)) throw new ConfigError(`Worker not found: ${name}. Please check the worker name.`)
  if (ignored.includes(name)) {
    throw new ConfigError(
      `Worker ${name} is listed in ${IGNORE_FILE}, which applies only to --all. Remove it from the file to run it by name.`,
    )
  }

  return [name]
}
