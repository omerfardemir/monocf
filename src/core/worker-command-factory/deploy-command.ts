import {join} from 'node:path'
import {existsSync} from 'node:fs'
import {
  EnvironmentService,
  ErrorService,
  FileService,
  LogService,
  ServiceBindingService,
  WranglerService,
} from '../../services/index.js'
import {DeployCommandParams, isDeployCommandParams} from '../../types/command-types.js'
import {WRANGLER_FILE} from '../../types/wrangler-types.js'
import {WorkerCommandExecutor} from './worker-command-executor.js'
import {experimental_patchConfig} from 'wrangler'

/**
 * Command executor for the deploy command
 */
export class DeployCommand implements WorkerCommandExecutor {
  private errorService: ErrorService
  private fileService: FileService
  private wranglerService: WranglerService
  private serviceBindingService: ServiceBindingService
  private environmentService: EnvironmentService
  private logService: LogService

  /**
   * Creates a new DeployCommand
   * @param errorService Error service
   * @param fileService File service
   * @param wranglerService Wrangler service
   * @param serviceBindingService Service binding service
   * @param environmentService Environment service
   * @param logService Log service
   */
  // eslint-disable-next-line max-params
  constructor(
    errorService: ErrorService,
    fileService: FileService,
    wranglerService: WranglerService,
    serviceBindingService: ServiceBindingService,
    environmentService: EnvironmentService,
    logService: LogService,
  ) {
    this.errorService = errorService
    this.fileService = fileService
    this.wranglerService = wranglerService
    this.serviceBindingService = serviceBindingService
    this.environmentService = environmentService
    this.logService = logService
  }

  /**
   * Executes the deploy command
   * @param workerName Worker name
   * @param params Command parameters
   * @returns Promise that resolves when the command completes successfully
   */
  async execute(workerName: string, params: DeployCommandParams): Promise<void> {
    this.logService.log('MonoCF deploy command starting')

    if (!isDeployCommandParams(params)) {
      this.errorService.throwConfigurationError('Invalid command parameters for deploy command')
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
        env: params.env,
      })

      // Handle service bindings
      const services = this.serviceBindingService.handleServiceBinding({
        configPath: tempWranglerConfigPath,
        rootDir: params.rootDir,
        workersDirName: params.workersDirName,
        baseConfigPath,
        variables: params.variables,
        env: params.env,
      })

      const patch = params.env
        ? {
            env: {
              [params.env]: {
                services,
              },
            },
          }
        : {
            services,
          }

      experimental_patchConfig(tempWranglerConfigPath, patch, false)

      // Deploy secrets if needed
      if (params.deploySecrets) {
        this.logService.log(`Deploying worker ${workerName}`)
        await this.wranglerService.execWorkerCommand('deploy', [tempWranglerConfigPath], params.env)

        this.logService.log(`Deploying secrets for ${workerName}`)
        await this.deploySecrets({
          workerName,
          workerPath,
          env: params.env,
          configPath: tempWranglerConfigPath,
        })
        return
      }

      // Run wrangler command
      return this.wranglerService.execWorkerCommand('deploy', [tempWranglerConfigPath], params.env)
    } catch (error) {
      this.errorService.handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Deploys secrets for a worker
   * @param {object} params Parameters for deploying secrets
   * @param {string} params.workerName Worker name
   * @param {string} params.workerPath Path to the worker directory
   * @param {string} params.env Environment to use
   * @param {string} params.configPath Path to the wrangler config file
   * @returns Promise that resolves when the secrets are deployed successfully
   */
  private async deploySecrets(params: {
    workerName: string
    workerPath: string
    env?: string
    configPath: string
  }): Promise<void> {
    const envPath = this.environmentService.createTempEnvFile(params.workerPath, params.env)
    if (existsSync(envPath)) {
      try {
        return await this.wranglerService.execSecretBulkUpload(envPath, params.configPath, params.env)
      } catch (error) {
        this.errorService.throwWorkerCommandError(
          `Failed to deploy secrets for ${params.workerName}: ${(error as Error).message}`,
        )
      }
    }
  }
}
