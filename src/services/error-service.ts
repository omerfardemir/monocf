import {
  ConfigurationError,
  FileOperationError,
  ServiceBindingError,
  WorkerCommandError,
  WorkerManagerError,
  WranglerError,
} from '../types/error-types.js'
import {Commander} from '../types/command-types.js'

/**
 * Service for handling errors in the application
 */
export class ErrorService {
  private command: Commander

  /**
   * Creates a new ErrorService
   * @param command Command instance for error reporting
   */
  constructor(command: Commander) {
    this.command = command
  }

  /**
   * Handles an error and exits the process if necessary
   * @param error Error to handle
   * @param exit Whether to exit the process
   */
  handleError(error: Error, exit: boolean = true): void {
    let message: string
    let code = 1

    if (error instanceof WorkerManagerError) {
      message = `${error.name}: ${error.message}`

      if (error instanceof ConfigurationError) {
        message = `Configuration Error: ${error.message}`
      } else if (error instanceof WorkerCommandError) {
        message = `Worker Command Error: ${error.message}`
      } else if (error instanceof FileOperationError) {
        message = `File Operation Error: ${error.message}`
      } else if (error instanceof ServiceBindingError) {
        message = `Service Binding Error: ${error.message}`
      } else if (error instanceof WranglerError) {
        message = `Wrangler Error: ${error.message}`
        code = error.code
      }
    } else {
      message = error.message
    }

    if (exit) {
      this.command.error(message, {exit: code})
    } else {
      this.command.warn(message)
    }
  }

  /**
   * Throws a configuration error
   * @param message Error message
   */
  throwConfigurationError(message: string): never {
    throw new ConfigurationError(message)
  }

  /**
   * Throws a worker command error
   * @param message Error message
   */
  throwWorkerCommandError(message: string): never {
    throw new WorkerCommandError(message)
  }

  /**
   * Throws a file operation error
   * @param message Error message
   */
  throwFileOperationError(message: string): never {
    throw new FileOperationError(message)
  }

  /**
   * Throws a service binding error
   * @param message Error message
   */
  throwServiceBindingError(message: string): never {
    throw new ServiceBindingError(message)
  }

  /**
   * Throws a wrangler error
   * @param message Error message
   * @param code Error code
   * @param command Command that failed
   * @param args Command arguments
   */
  throwWranglerError(message: string, code: number, command: string, args: string[]): never {
    throw new WranglerError(message, code, command, args)
  }
}
