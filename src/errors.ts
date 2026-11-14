import {ERROR_CODES, type ErrorCode} from './explain/registry.js'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2
export const EXIT_ENVIRONMENT = 3

export interface ErrorDetails {
  /** Stable, unlike the message, so a script or an agent can act on it. `monocf explain <code>` says what it means. */
  code: ErrorCode
  /** Only where one code has more than one exit code, as a signal does. Otherwise the code's own. */
  exitCode?: number
  /** What to do next, when this case knows better than the code's own advice. */
  hint?: string
}

/** Everything monocf reports on purpose: one message, a code, and the exit code it stands for. */
export class MonocfError extends Error {
  readonly code: ErrorCode
  readonly exitCode: number
  readonly hint?: string

  constructor(message: string, {code, exitCode, hint}: ErrorDetails) {
    super(message)
    this.name = 'MonocfError'
    this.code = code
    this.hint = hint
    const own = ERROR_CODES[code].exitCode
    this.exitCode = exitCode ?? (typeof own === 'number' ? own : EXIT_FAILED)
  }
}
