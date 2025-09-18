import {
  ConfigurationError,
  FileOperationError,
  ServiceBindingError,
  WorkerCommandError,
  MonocfError,
  WranglerError,
} from '../types/error-types.js'

/**
 * Service for handling errors in the application
 */
export class ErrorService {
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
