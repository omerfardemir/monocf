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

  /**
   * Checks what a run needs before any wrangler call, so a bad selection fails with nothing attempted
   * @param workers Selected worker names
   * @param params Command parameters
   * @param options What the run will do with the workers
   * @param options.followBindings Whether the run also deploys the bindings of each worker
   * @param options.requireSecrets Whether the run uploads secrets
   * @param visited Workers already checked
   */
  public validateWorkers(
    workers: string[],
    params: BaseCommandParams,
    options: {followBindings?: boolean; requireSecrets?: boolean},
    visited: Set<string> = new Set(),
  ): void {
    const baseConfigPath = params.baseConfig ? join(params.rootDir, params.baseConfig) : undefined

    for (const workerName of workers) {
      if (visited.has(workerName)) continue
      visited.add(workerName)

      this.fileService.validateWorker(params.rootDir, params.workersDirName, workerName)

      const workerPath = join(params.rootDir, params.workersDirName, workerName)
      const configPath = join(workerPath, WRANGLER_FILE)
      this.fileService.validateEnvironment(workerName, [configPath, baseConfigPath], params.env)

      if (options.requireSecrets) {
        this.environmentService.validateSecretsFile(workerPath, params.env)
      }

      if (options.followBindings) {
        const tempConfigPath = this.fileService.createTempWranglerConfig({
          workerName,
          configPath,
          workerPath,
          baseConfigPath,
          replaceValues: params.variables,
          env: params.env,
        })
        const dependencies = this.serviceBindingService
          .getServiceBindings(tempConfigPath, params.env)
          .map((binding) => binding.service)
          .filter((service) => !this.fileService.isIgnoredWorker(service))

        this.validateWorkers(dependencies, params, options, visited)
      }
    }
  }

  public initializeWorker(workerName: string, params: BaseCommandParams) {
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

    return {
      workerName,
      workerPath,
      baseConfigPath,
      tempWranglerConfigPath,
      serviceBindingPaths,
    }
  }
}
