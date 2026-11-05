import {randomBytes} from 'node:crypto'
import {chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

const MONOCF_DIR = '.monocf'
const RUNS_DIR = 'runs'
const OWNER_FILE = 'owner.pid'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface RunDir {
  /** The next unused output file for a worker. Each spawn gets its own. */
  outputFile(worker: string): string
  path: string
  /** Safe to call more than once, and it never throws. */
  remove(): void
  /** Creates the worker's directory on first use. */
  workerDir(worker: string): string
}

function makePrivateDir(path: string): void {
  mkdirSync(path, {mode: 0o700, recursive: true})
  chmodSync(path, 0o700)
}

function removeDir(path: string): void {
  try {
    rmSync(path, {force: true, maxRetries: 3, recursive: true, retryDelay: 100})
  } catch {
    // Left for the next run's cleanup. A failure here can't change a run's result.
  }
}

function removeIfEmpty(path: string): void {
  try {
    rmdirSync(path)
  } catch {
    // Not empty, or already gone.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isStale(runPath: string, now: number): boolean {
  if (now - statSync(runPath).mtimeMs > MAX_AGE_MS) return true
  try {
    const pid = Number(readFileSync(join(runPath, OWNER_FILE), 'utf8'))
    return Number.isInteger(pid) && pid > 0 && !isAlive(pid)
  } catch {
    // No owner file yet: another process may be between creating the directory and writing it.
    return false
  }
}

/** Removes what a killed run left behind: runs whose owner is dead, or that are older than a day. */
export function removeStaleRuns(rootDir: string, now: number = Date.now()): void {
  const runs = join(rootDir, MONOCF_DIR, RUNS_DIR)
  let names: string[]
  try {
    names = readdirSync(runs)
  } catch {
    return
  }

  for (const name of names) {
    const runPath = join(runs, name)
    try {
      if (isStale(runPath, now)) removeDir(runPath)
    } catch {
      // Removed by another process at the same moment.
    }
  }
}

/** One private directory per process, with nothing outside it written to. It goes away on every exit path. */
export function createRunDir(rootDir: string): RunDir {
  removeStaleRuns(rootDir)

  const monocf = join(rootDir, MONOCF_DIR)
  const runs = join(monocf, RUNS_DIR)
  const path = join(runs, randomBytes(6).toString('hex'))
  makePrivateDir(path)
  writeFileSync(join(path, OWNER_FILE), String(process.pid))

  const outputs = new Map<string, number>()
  const workerDir = (worker: string): string => {
    const dir = join(path, worker)
    makePrivateDir(dir)
    return dir
  }

  let removed = false
  const remove = (): void => {
    if (removed) return
    removed = true
    process.off('exit', remove)
    removeDir(path)
    // Empty parents go too, so a finished run leaves the tree as it found it. Another run's directory keeps them.
    removeIfEmpty(runs)
    removeIfEmpty(monocf)
  }

  process.once('exit', remove)

  return {
    outputFile(worker) {
      const next = (outputs.get(worker) ?? 0) + 1
      outputs.set(worker, next)
      return join(workerDir(worker), `output-${next}.ndjson`)
    },
    path,
    remove,
    workerDir,
  }
}
