import {Commander, DevCommandParams, WorkerCommand, WorkerCommandParams} from '../../../types/command-types.js'
import {
  WranglerService,
  ConfigurationService,
  ServiceBindingService,
  EnvironmentService,
} from '../../../services/index.js'
import {WorkerArgs, WorkerFlags} from '../../../flags/index.js'
import {MonocfCommand} from '../command.js'
import {WorkerCommandFactory} from '../../worker-command-factory/index.js'
import {CliConfig, CliFlags} from '../../../types/config-types.js'

export class WranglerCommand extends MonocfCommand<WorkerArgs, WorkerFlags> {
  private serviceBindingService: ServiceBindingService
  private wranglerService: WranglerService
  private configService: ConfigurationService
  private environmentService: EnvironmentService

  constructor(command: Commander) {
    super(command)
    this.configService = new ConfigurationService(this.errorService)
    this.environmentService = new EnvironmentService(this.errorService, this.fileService)
    this.serviceBindingService = new ServiceBindingService(this.errorService, this.fileService, this.environmentService)
    this.wranglerService = new WranglerService(this.errorService, this.fileService, command.cmdEvents())
  }

  public async execute(args: WorkerArgs, flags: WorkerFlags): Promise<void> {
    // Load configuration
    const config = this.configService.loadConfiguration(flags, args)

    // Validate directories
    this.fileService.validateWorkersDirectory(config.rootDir, config.workersDirName)

    // Load ignore file
    this.fileService.loadIgnoreFile(config.rootDir, config.workersDirName)

    this.environmentService.setRootDir(config.rootDir)

    // Create command parameters
    const params: WorkerCommandParams = this.buildParams({
      ...config,
      ...args,
    })

    // Create command executor
    const commandExecutor = WorkerCommandFactory.createCommand(params.command, {
      errorService: this.errorService,
      fileService: this.fileService,
      serviceBindingService: this.serviceBindingService,
      wranglerService: this.wranglerService,
      environmentService: this.environmentService,
      logService: this.logService,
    })

    if (!config.all && !args.workerName) {
      this.errorService.throwConfigurationError('Worker name is required if --all flag is not set')
    }

    const workers = config.all
      ? this.fileService.getWorkers(config.rootDir, config.workersDirName)
      : [String(args.workerName)]

    switch (params.command) {
      case 'preview':
      case 'deploy': {
        for (const worker of workers) {
          params.workerName = worker
          await commandExecutor.execute(worker, params)
        }

        break
      }

      case 'dev':
      case 'build': {
        // leave workerName empty to execute dev for all workers
        await commandExecutor.execute(workers[0], {
          ...params,
          multiWorker: config.all,
        } as DevCommandParams)

        break
      }
    }
  }

  private buildParams(params: CliConfig & CliFlags & WorkerArgs): WorkerCommandParams {
    return {
      command: this.validateCommand(params.command!),
      workerName: params.workerName || '',
      rootDir: params.rootDir,
      workersDirName: params.workersDirName,
      env: params.env,
      baseConfig: params.baseConfig,
      variables: params.variables,
      port: params.port,
      ...(params.command !== 'dev' && {minify: params.minify}),
      ...(params.command === 'deploy' && {
        deploySecrets: params.deploySecrets,
        deployBindings: params.deployBindings,
        fromVersion: params.fromVersion,
        deployFromVersionId: params.deployFromVersionId,
        message: params.message,
      }),
    }
  }

  private validateCommand(command: string): WorkerCommand | never {
    const validCommands = ['dev', 'build', 'preview', 'deploy']
    if (!validCommands.includes(command)) {
      this.errorService.throwConfigurationError(`Unsupported command: ${command}`)
    }

    return command as WorkerCommand
  }

  /**
   * Cleanup after command execution
   */
  public async finally(): Promise<void> {
    return new Promise((resolve) => {
      this.fileService.cleanupTempFiles()
      this.environmentService.rollbackEnvironmentVariables()
      resolve()
    })
  }
}
