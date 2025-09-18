import {Commander} from '../../types/command-types.js'
import {ErrorService, FileService, LogService} from '../../services/index.js'

/**
 * Abstract base class for all CLI commands
 */
export abstract class MonocfCommand<TArgs = unknown, TFlags = unknown> {
  protected errorService: ErrorService
  protected fileService: FileService
  protected logService: LogService
  protected command: Commander

  /**
   * Creates a new instance of the command
   * @param command The oclif command instance
   */
  constructor(command: Commander) {
    this.command = command
    this.logService = new LogService(command)
    this.errorService = new ErrorService()
    this.fileService = new FileService(this.errorService)
  }

  /**
   * Executes the command with the provided arguments and flags
   * @param args Command arguments
   * @param flags Command flags
   */
  public abstract execute(args: TArgs, flags: TFlags): Promise<void>

  /**
   * Cleanup method that will be called after command execution
   * regardless of success or failure
   * Commands can override this method to implement their own cleanup logic
   */
  public async finally(): Promise<void> {}
}
