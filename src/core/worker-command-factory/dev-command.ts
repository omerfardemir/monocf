import {join} from 'node:path'
import {ErrorService, FileService, ServiceBindingService, WranglerService} from '../../services/index.js'
import {DevCommandParams, isDevCommandParams} from '../../types/command-types.js'
import {WRANGLER_FILE} from '../../types/wrangler-types.js'
import {WorkerCommandExecutor} from './worker-command-executor.js'

/**
 * Command executor for the dev command
 */
export class DevCommand implements WorkerCommandExecutor {
  private serviceBindingService: ServiceBindingService
  private errorService: ErrorService
  private fileService: FileService
  private wranglerService: WranglerService

  /**
   * Creates a new DevCommand
   * @param serviceBindingService Service binding service
   * @param errorService Error service
   * @param fileService File service
   * @param wranglerService Wrangler service
   */
  constructor(
    serviceBindingService: ServiceBindingService,
    errorService: ErrorService,
    fileService: FileService,
    wranglerService: WranglerService,
  ) {
    this.serviceBindingService = serviceBindingService
    this.errorService = errorService
    this.fileService = fileService
    this.wranglerService = wranglerService
  }

  /**
   * Executes the dev command
   * @param workerName Worker name
   * @param params Command parameters
   * @returns Promise that resolves when the command completes successfully
   */
  async execute(workerName: string, params: DevCommandParams): Promise<void> {
    if (!isDevCommandParams(params)) {
      this.errorService.throwConfigurationError('Invalid command parameters for dev command')
    }

    try {
      // Validate worker
      this.fileService.validateWorker(params.rootDir, params.workersDirName, workerName)

      // Create temp config
      const workerPath = join(params.rootDir, params.workersDirName, workerName)
      const wranglerConfigPath = join(workerPath, WRANGLER_FILE)
      const baseConfigPath = params.baseConfig ? join(params.rootDir, params.baseConfig) : undefined

      const tempWranglerConfigPath = this.fileService.createTempWranglerConfig({
        workerName,
        configPath: wranglerConfigPath,
        workerPath,
        baseConfigPath,
        replaceValues: params.variables,
      })

      // Handle service bindings
      const serviceBindingPaths = this.serviceBindingService.createServiceBindings(
        {
          configPath: tempWranglerConfigPath,
          rootDir: params.rootDir,
          workersDirName: params.workersDirName,
          baseConfigPath,
          variables: params.variables,
          env: params.env,
        },
        true,
      )

      // Run wrangler command
      return this.wranglerService.execWorkerCommand(
        'dev',
        [tempWranglerConfigPath, ...serviceBindingPaths.flatMap((serviceBindingPath) => serviceBindingPath.path)],
        params.env,
      )
    } catch (error) {
      this.errorService.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
