import {join} from 'node:path'
import {existsSync} from 'node:fs'

import {CreateWorkerArgs, DeploySecretsFlags} from '../../../flags/index.js'
import {WranglerService, EnvironmentService, ConfigurationService} from '../../../services/index.js'
import {Commander} from '../../../types/command-types.js'
import {MonocfCommand} from '../command.js'
import {WRANGLER_FILE} from '../../../types/wrangler-types.js'

export class DeploySecretsCommand extends MonocfCommand<CreateWorkerArgs, DeploySecretsFlags> {
  private wranglerService: WranglerService
  private environmentService: EnvironmentService
  private configService: ConfigurationService

  constructor(command: Commander) {
    super(command)
    this.configService = new ConfigurationService(this.errorService)
    this.environmentService = new EnvironmentService(this.errorService, this.fileService)
    this.wranglerService = new WranglerService(this.errorService, this.fileService, command.cmdEvents())
  }

  public async execute(args: CreateWorkerArgs, flags: DeploySecretsFlags) {
    this.logService.log('MonoCF starting to deploy secrets...')

    // Load configuration
    const config = this.configService.loadConfiguration(flags, args)

    // Validate directories
    this.fileService.validateWorkersDirectory(config.rootDir, config.workersDirName)

    // Load ignore file
    this.fileService.loadIgnoreFile(config.rootDir, config.workersDirName)

    this.environmentService.setRootDir(config.rootDir)

    if (!config.all && !args.workerName) {
      this.errorService.throwConfigurationError('Worker name is required if --all flag is not set')
    }

    const workers = config.all
      ? this.fileService.getWorkers(config.rootDir, config.workersDirName)
      : [String(args.workerName)]

    if (workers.length === 0) {
      this.errorService.throwConfigurationError(`No workers found`)
    }

    for (const workerName of workers) {
      const workerPath = join(config.rootDir, config.workersDirName, workerName)
      const wranglerConfigPath = join(workerPath, WRANGLER_FILE)
      const baseConfigPath = config.baseConfig ? join(config.rootDir, config.baseConfig) : undefined

      const tempWranglerConfigPath = this.fileService.createTempWranglerConfig({
        workerName,
        configPath: wranglerConfigPath,
        workerPath,
        baseConfigPath,
        replaceValues: config.variables,
        env: config.env,
      })

      await this.deploySecrets({
        workerName,
        workerPath,
        env: config.env,
        configPath: tempWranglerConfigPath,
      })
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

  /**
   * Cleanup after command execution
   */
  public async finally(): Promise<void> {
    return new Promise((resolve) => {
      this.fileService.cleanupTempFiles()
      resolve()
    })
  }
}
