import {
  EnvironmentService,
  ErrorService,
  FileService,
  LogService,
  ServiceBindingService,
  WranglerService,
} from '../../services/index.js'
import {BuildCommandParams, isBuildCommandParams} from '../../types/command-types.js'
import {WorkerCommandExecutor} from './worker-command-executor.js'
import {WorkerService} from '../../services/worker-service.js'

/**
 * Command executor for the build command
 */
export class BuildCommand implements WorkerCommandExecutor {
  private errorService: ErrorService
  private fileService: FileService
  private wranglerService: WranglerService
  private logService: LogService
  private workerService: WorkerService
  private readonly BASE_PORT = 9001

  /**
   * Creates a new BuildCommand
   * @param serviceBindingService Service binding service
   * @param errorService Error service
   * @param fileService File service
   * @param wranglerService Wrangler service
   * @param environmentService Environment service
   * @param logService Log service
   */
  // eslint-disable-next-line max-params
  constructor(
    serviceBindingService: ServiceBindingService,
    errorService: ErrorService,
    fileService: FileService,
    wranglerService: WranglerService,
    environmentService: EnvironmentService,
    logService: LogService,
  ) {
    this.errorService = errorService
    this.fileService = fileService
    this.wranglerService = wranglerService
    this.logService = logService
    this.workerService = new WorkerService(fileService, logService, environmentService, serviceBindingService)
  }

  /**
   * Executes the build command
   * @param workerName Worker name
   * @param params Command parameters
   * @returns Promise that resolves when the command completes successfully
   */
  async execute(workerName: string, params: BuildCommandParams): Promise<void> {
    this.logService.log('MonoCF build command starting...')

    if (!isBuildCommandParams(params)) {
      this.errorService.throwConfigurationError('Invalid command parameters for build command')
    }

    if (this.fileService.isIgnoredWorker(workerName)) {
      this.logService.log(`Worker ${workerName} is ignored, skipping`)
      return
    }

    if (params.multiWorker) {
      return this.executeMultiWorker(params)
    }

    const workerConfigPath = this.workerService.initializeWorker(workerName, params)

    if (!workerConfigPath) {
      return
    }

    // Run wrangler command
    await this.wranglerService.buildWorker(
      workerConfigPath.tempWranglerConfigPath,
      undefined,
      params.env,
      params.minify,
    )
  }

  async executeMultiWorker(params: BuildCommandParams): Promise<void> {
    const workers = this.fileService.getWorkers(params.rootDir, params.workersDirName)
    const workersConfigPaths = workers
      .filter((workerName) => !this.fileService.isIgnoredWorker(workerName))
      .map((workerName) => this.workerService.initializeWorker(workerName, params))
      .filter((s) => s !== undefined)

    for (const workerConfigPath of workersConfigPaths) {
      await this.wranglerService.buildWorker(
        workerConfigPath.tempWranglerConfigPath,
        undefined,
        params.env,
        params.minify,
      )
    }
  }
}
