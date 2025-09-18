import { Command } from '@oclif/core'
import { execEventListener } from './wrangler-types.js'
import { Commander } from './command-types.js'
import { MonocfCommand } from '../core/commands/command.js'
import { error } from '@oclif/core/ux'
import { MonocfError } from './error-types.js'

/**
 * Base class for all commands
 */
export abstract class CommandBase extends Command implements Commander {
  protected command: MonocfCommand | undefined
  /**
   * Returns event listeners for command execution
   * @returns Event listeners for command execution
   */
  cmdEvents(): execEventListener {
    return {
      onExitListener: (code: number) => {
        if (code && code !== 0) {
          this.error(`Command failed with code ${code}`, {
            code: code.toString(),
            exit: code,
          })
        }
      },
      onStderrListener: (data: string) => {
        this.error(`${data}`, {
          exit: false,
        })
      },
      onStdoutListener: (data: string) => {
        this.log(`${data}`)
      },
    }
  }

  async catch(err: MonocfError): Promise<void | never> {
    if (err.exit === false) {
      return error(err.message, { exit: false });
    } else {
      const exitCode = typeof err.exit === 'number' ? err.exit : 2;
      return error(err.message, { exit: exitCode });
    }
  }

  async finally(err?: Error): Promise<void> {
    await this.command?.finally()
    return super.finally(err)
  }
}
