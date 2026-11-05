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
 *
 * Whatever passes through a pipe here has the account ID taken out, as a line at a time. `inherit` has no pipe, and neither has
 * `stderr` on a terminal, so that wrangler's colours and prompts stay: a person's own terminal isn't a log.
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
  if (mode === 'stderr') return process.stderr.isTTY ? ['inherit', 2, 2] : ['inherit', 'pipe', 'pipe']
  return ['ignore', 'pipe', 'pipe']
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/i
const ACCOUNT_IN_URL = /\/accounts\/[0-9a-f]{32}/gi

/**
 * API errors quote a URL holding the account, and in a public repository a CI log is public. Only the IDs monocf knows are taken
 * out as bare text, as other things are 32 hex characters too. A URL gives away what it is, whichever account it names.
 */
function accountScrubber({CF_ACCOUNT_ID: old, CLOUDFLARE_ACCOUNT_ID: current}: NodeJS.ProcessEnv): (text: string) => string {
  const known = [current, old].map((id) => id?.trim() ?? '').filter((id) => ACCOUNT_ID.test(id))
  return (text) => {
    let scrubbed = text
    for (const id of known) scrubbed = scrubbed.replaceAll(id, '<account>')
    return scrubbed.replaceAll(ACCOUNT_IN_URL, '/accounts/<account>')
  }
}

function collect(child: ChildProcess, mode: OutputMode, scrub: (text: string) => string): () => {stderr: string; stdout: string} {
  let stdout = ''
  let stderr = ''
  const forward = () => linePrefixer(typeof mode === 'object' ? mode.prefix : '', (text) => process.stderr.write(scrub(text)))
  const out = typeof mode === 'object' || mode === 'stderr' ? forward() : undefined
  const err = mode === 'quiet' ? undefined : forward()
  // A chunk can end inside a multi-byte character, so the decoding has to span chunks.
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    stdout += chunk
    out?.write(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
    err?.write(chunk)
  })
  child.once('close', () => {
    out?.end()
    err?.end()
  })

  return () => ({stderr, stdout})
}

function environmentFor({accountId, environment: added, mode, outputFile}: Pick<RunOptions, 'accountId' | 'environment' | 'mode' | 'outputFile'>): NodeJS.ProcessEnv {
  const environment = {...process.env, ...added}
  // As in wrangler, a worker's own account_id beats whatever the environment says.
  if (accountId !== undefined) environment.CLOUDFLARE_ACCOUNT_ID = accountId
  delete environment.WRANGLER_OUTPUT_FILE_DIRECTORY
  // Debug output reaches stdout, where a read expects JSON and nothing else.
  if (mode === 'quiet') delete environment.WRANGLER_LOG
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
  const env = environmentFor({accountId, environment, mode, outputFile})
  const child = spawn(process.execPath, ['--no-warnings', wrangler.cli, ...argv], {cwd, env, shell: false, stdio: stdioFor(mode)})
  const collected = collect(child, mode, accountScrubber(env))

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
