import {Errors} from '@oclif/core'
import {stripVTControlCharacters} from 'node:util'

import {MonocfError} from '../errors.js'
import {ERROR_CODES, type ErrorCode, type Explanation} from '../explain/registry.js'
import type {ErrorEvent} from './events.js'

/** oclif doesn't export its parser's error classes, so they're told apart by name. */
const PARSER_CODES: Record<string, ErrorCode> = {
  ArgInvalidOptionError: 'invalid-flag-value',
  FlagInvalidOptionError: 'invalid-flag-value',
  NonExistentFlagsError: 'unknown-flag',
  RequiredArgsError: 'missing-argument',
  UnexpectedArgsError: 'unexpected-argument',
}

const SEE_HELP = /\n?See more help with --help\s*$/

/** The parser's own lines, without its colours or its pointer to --help, which the hint gives instead. */
function cleanMessage(message: string): string {
  return stripVTControlCharacters(message).replace(SEE_HELP, '').trim()
}

/** A failed validation's reasons, one a line under a heading that says nothing. */
function validationReasons(message: string): string[] {
  return cleanMessage(message).split('\n').slice(1).map((line) => line.trim()).filter(Boolean)
}

/** One failed validation can hold several reasons, and only "missing" is fixed by adding a flag. */
function validationCode(reasons: string[]): ErrorCode {
  return reasons.length > 0 && reasons.every((reason) => reason.startsWith('Missing required flag')) ? 'missing-flag' : 'flag-conflict'
}

function cliCode(error: Errors.CLIError): ErrorCode {
  const {name} = error.constructor
  if (name === 'FailedFlagValidationError') return validationCode(validationReasons(error.message))
  if (/^command .+ not found$/.test(error.message)) return 'unknown-command'
  // Any other error of the framework's comes from reading the command line, such as an integer flag given a word.
  return PARSER_CODES[name] ?? 'invalid-flag-value'
}

function hintFor(code: ErrorCode, command: string | undefined): string | undefined {
  const {next}: Explanation = ERROR_CODES[code]
  return command === undefined ? next : next?.replace('<command>', command)
}

/** What `--json` prints for a failure, whatever it came from. `command` names the command in the hint, when it's known. */
export function toErrorEvent(error: unknown, command?: string): ErrorEvent {
  const event = (code: ErrorCode, exitCode: number, message: string, hint?: string): ErrorEvent => {
    const advice = hint ?? hintFor(code, command)
    return {code, exitCode, ...(advice !== undefined && {hint: advice}), message, type: 'error'}
  }

  if (error instanceof MonocfError) return event(error.code, error.exitCode, error.message, error.hint)
  if (error instanceof Errors.CLIError) {
    const message = error.constructor.name === 'FailedFlagValidationError' ? validationReasons(error.message).join('\n') : cleanMessage(error.message)
    return event(cliCode(error), error.oclif.exit ?? 2, message)
  }

  return event('internal-error', 1, error instanceof Error ? error.message : String(error))
}

const reported = new WeakSet<object>()

/** A command printed this one's event, so the top-level handler that oclif rethrows it to mustn't print another. */
export function markReported(error: unknown): void {
  if (typeof error === 'object' && error !== null) reported.add(error)
}

export function isReported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reported.has(error)
}

/** `--json` anywhere before `--`, whether or not the command takes it, as an agent may add it to anything. */
export function wantsJson(argv: string[]): boolean {
  const end = argv.indexOf('--')
  return (end === -1 ? argv : argv.slice(0, end)).includes('--json')
}
