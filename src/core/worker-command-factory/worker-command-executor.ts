import {WorkerCommandParams} from '../../types/command-types.js'

/**
 * Interface for worker command executors
 */
export interface WorkerCommandExecutor {
  /**
   * Executes the worker command
   * @param workers Worker names
   * @param params Command parameters
   * @returns Promise that resolves when the command completes successfully
   */
  execute(workers: string[], params: WorkerCommandParams): Promise<void>
}
