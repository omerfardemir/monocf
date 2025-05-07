import {Command} from '@oclif/core'
import {execEventListener} from './wrangler-types.js'
import {Commander} from './command-types.js'

/**
 * Base class for all commands
 */
export abstract class CommandBase extends Command implements Commander {
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
}
