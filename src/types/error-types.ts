/**
 * Base error class for MonoCF
 */
export class WorkerManagerError extends Error {
  /**
   * Creates a new WorkerManagerError
   * @param message Error message
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkerManagerError'

    // This is needed to make instanceof work correctly in TypeScript
    Object.setPrototypeOf(this, WorkerManagerError.prototype)
  }
}

/**
 * Error thrown when a configuration is invalid
 */
export class ConfigurationError extends WorkerManagerError {
  /**
   * Creates a new ConfigurationError
   * @param message Error message
   */
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'

    // This is needed to make instanceof work correctly in TypeScript
    Object.setPrototypeOf(this, ConfigurationError.prototype)
  }
}

/**
 * Error thrown when a worker command fails
 */
export class WorkerCommandError extends WorkerManagerError {
  /**
   * Creates a new WorkerCommandError
   * @param message Error message
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkerCommandError'

    // This is needed to make instanceof work correctly in TypeScript
    Object.setPrototypeOf(this, WorkerCommandError.prototype)
  }
}

/**
 * Error thrown when a file operation fails
 */
export class FileOperationError extends WorkerManagerError {
  /**
   * Creates a new FileOperationError
   * @param message Error message
   */
  constructor(message: string) {
    super(message)
    this.name = 'FileOperationError'

    // This is needed to make instanceof work correctly in TypeScript
    Object.setPrototypeOf(this, FileOperationError.prototype)
  }
}

/**
 * Error thrown when a service binding operation fails
 */
export class ServiceBindingError extends WorkerManagerError {
  /**
   * Creates a new ServiceBindingError
   * @param message Error message
   */
  constructor(message: string) {
    super(message)
    this.name = 'ServiceBindingError'

    // This is needed to make instanceof work correctly in TypeScript
    Object.setPrototypeOf(this, ServiceBindingError.prototype)
  }
}

/**
 * Error thrown when a spawned wrangler command fails
 */
export class WranglerError extends Error {
  args: string[]
  code: number
  command: string

  /**
   * Creates a new WranglerError
   * @param message Error message
   * @param code Exit code from the process
   * @param command The wrangler command that was executed
   * @param args The arguments passed to the command
   */
  constructor(message: string, code: number, command: string, args: string[]) {
    super(message)
    this.name = 'WranglerError'
    this.code = code
    this.command = command
    this.args = args

    // This is needed to make instanceof work correctly in TypeScript
    Object.setPrototypeOf(this, WranglerError.prototype)
  }
}
