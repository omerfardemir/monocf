import {WorkerCommandParams} from '../../types/command-types.js'

/**
 * Interface for worker command executors
 */
export interface WorkerCommandExecutor {
  /**
   * Executes the worker command
   * @param workerName Worker name
   * @param params Command parameters
   * @returns Promise that resolves when the command completes successfully
   */
  execute(workerName: string, params: WorkerCommandParams): Promise<void>
}
