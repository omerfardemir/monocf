import {spawn, type ChildProcess, type StdioOptions} from 'node:child_process'

import {EXIT_ENVIRONMENT, MonocfError} from '../errors.js'
import {linePrefixer} from '../report/prefix.js'
import type {Wrangler} from './locate.js'
import {readOutputFile, type WranglerOutput} from './output.js'

/**
 * Where a process's output goes:
 * - `inherit`: straight to the terminal, for an interactive `dev` or a result such as `whoami`.
 * - `stderr`: stdout joins stderr, so stdout carries only monocf's results.
 * - `capture`: stdout comes back in the result, and stderr passes through as well as coming back.
 * - `quiet`: both come back and nothing passes through, for a read whose expected failures aren't news.
 * - `{prefix}`: both streams to stderr with a label on each line, for several processes at once.
 */
export type OutputMode = 'capture' | 'inherit' | 'quiet' | 'stderr' | {prefix: string}

export interface RunOptions {
  /** A worker's own account_id. A read by name has no config for wrangler to find it in. */
  accountId?: string
  cwd: string
  /** Added to the real environment: the worker's `.env` files, which wrangler can't see from the run directory. */
  environment?: Record<string, string>
  mode: OutputMode
  /** Per spawn, so that parallel processes can't mix their results. */
  outputFile?: string
}

export interface WranglerResult {
  code: null | number
  output: WranglerOutput
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}

export interface RunningWrangler {
  child: ChildProcess
  /** Settles once the process has ended and its streams have closed. */
  done: Promise<WranglerResult>
}

function stdioFor(mode: OutputMode): StdioOptions {
  if (mode === 'inherit') return 'inherit'
  if (mode === 'stderr') return ['inherit', 2, 2]
  return ['ignore', 'pipe', 'pipe']
}

function collect(child: ChildProcess, mode: OutputMode): () => {stderr: string; stdout: string} {
  let stdout = ''
  let stderr = ''
  if (typeof mode === 'object') {
    const out = linePrefixer(mode.prefix, (text) => process.stderr.write(text))
    const err = linePrefixer(mode.prefix, (text) => process.stderr.write(text))
    child.stdout?.on('data', (chunk) => out.write(String(chunk)))
    child.stderr?.on('data', (chunk) => err.write(String(chunk)))
    child.once('close', () => {
      out.end()
      err.end()
    })
  } else {
    // A chunk can end inside a multi-byte character, so the decoding has to span chunks.
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (mode !== 'quiet') process.stderr.write(chunk)
    })
  }

  return () => ({stderr, stdout})
}

function environmentFor({accountId, environment: added, outputFile}: Pick<RunOptions, 'accountId' | 'environment' | 'outputFile'>): NodeJS.ProcessEnv {
  const environment = {...process.env, ...added}
  // As in wrangler, a worker's own account_id beats whatever the environment says.
  if (accountId !== undefined) environment.CLOUDFLARE_ACCOUNT_ID = accountId
  delete environment.WRANGLER_OUTPUT_FILE_DIRECTORY
  if (outputFile === undefined) delete environment.WRANGLER_OUTPUT_FILE_PATH
  else environment.WRANGLER_OUTPUT_FILE_PATH = outputFile
  return environment
}

/** Spawns wrangler's entry with no shell, so a signal reaches the process doing the work and arguments stay intact. */
export function spawnWrangler(
  wrangler: Wrangler,
  argv: string[],
  {accountId, cwd, environment, mode, outputFile}: RunOptions,
): RunningWrangler {
  // The same flag bin/wrangler.js adds.
  const child = spawn(process.execPath, ['--no-warnings', wrangler.cli, ...argv], {
    cwd,
    env: environmentFor({accountId, environment, outputFile}),
    shell: false,
    stdio: stdioFor(mode),
  })
  const collected = collect(child, mode)

  const done = new Promise<WranglerResult>((resolve, reject) => {
    child.once('error', (error) => {
      reject(new MonocfError(`Could not start wrangler: ${error.message}`, EXIT_ENVIRONMENT))
    })
    // 'close', not 'exit': it fires once the streams have flushed, so captured output is complete.
    child.once('close', (code, signal) => {
      resolve({
        code,
        output: outputFile ? readOutputFile(outputFile) : {entries: []},
        signal,
        ...collected(),
      })
    })
  })

  return {child, done}
}
