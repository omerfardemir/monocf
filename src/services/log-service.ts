import {Commander} from '../types/command-types.js'

export class LogService {
  private commander: Commander

  constructor(commander: Commander) {
    this.commander = commander
  }

  /** Logs a message */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(message: string, ...args: any[]): void {
    this.commander.log(message, ...args)
  }

  /** Logs a warning */
  warn(input: Error | string): Error | string {
    return this.commander.warn(input)
  }

  /** Logs an error */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(input: Error | string, options?: any): void | never {
    this.commander.error(input, options)
  }
}
