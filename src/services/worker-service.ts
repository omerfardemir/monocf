import {join} from 'node:path'
import {EnvironmentService} from './environment-service.js'
import {FileService} from './file-service.js'
import {LogService} from './log-service.js'
import {ServiceBindingService} from './service-binding-service.js'
import {WRANGLER_FILE} from '../types/wrangler-types.js'
import {BaseCommandParams} from '../types/command-types.js'

export class WorkerService {
  private fileService: FileService
  private logService: LogService
  private environmentService: EnvironmentService
  private serviceBindingService: ServiceBindingService

  constructor(
    fileService: FileService,
    logService: LogService,
    environmentService: EnvironmentService,
    serviceBindingService: ServiceBindingService,
  ) {
    this.fileService = fileService
    this.logService = logService
    this.environmentService = environmentService
    this.serviceBindingService = serviceBindingService
  }

  public initializeWorker(workerName: string, params: BaseCommandParams) {
    try {
      this.fileService.validateWorker(params.rootDir, params.workersDirName, workerName)
    } catch {
      this.logService.warn(`Worker ${workerName} not found. Skipping.`)
      return
    }

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
      env: params.env,
    })

    // Handle environment variables
    this.environmentService.patchEnvironmentFile(workerPath, params.env)

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

    const envPath = this.fileService.getEnvironmentFile(workerPath, params.env)

    return {
      workerName,
      workerPath,
      baseConfigPath,
      tempWranglerConfigPath,
      serviceBindingPaths,
      envPath,
    }
  }
}
