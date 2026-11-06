export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2
export const EXIT_ENVIRONMENT = 3

/** Everything monocf reports on purpose: one message and the exit code it stands for. */
export class MonocfError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode: number = EXIT_FAILED) {
    super(message)
    this.name = 'MonocfError'
    this.exitCode = exitCode
  }
}
