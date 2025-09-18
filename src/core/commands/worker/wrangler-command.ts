import {Commander, DevCommandParams, WorkerCommandParams} from '../../../types/command-types.js'
import {
  WranglerService,
  ConfigurationService,
  ServiceBindingService,
  EnvironmentService,
} from '../../../services/index.js'
import {WorkerArgs, WorkerFlags} from '../../../flags/index.js'
import {MonocfCommand} from '../command.js'
import {WorkerCommandFactory} from '../../worker-command-factory/index.js'

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

    if (!config.command || !(config.command === 'deploy' || config.command === 'dev')) {
      this.errorService.throwConfigurationError('Command is required and must be either "deploy" or "dev"')
    }

    // Create command parameters
    const params: WorkerCommandParams = {
      command: config.command!,
      workerName: args.workerName || '',
      rootDir: config.rootDir,
      workersDirName: config.workersDirName,
      env: config.env,
      baseConfig: config.baseConfig,
      variables: config.variables,
      port: config.port,
      ...(config.command === 'deploy' && {deploySecrets: config.deploySecrets}),
      ...(config.command === 'deploy' && {deployBindings: config.deployBindings}),
    }

    // Create command executor
    const commandExecutor = WorkerCommandFactory.createCommand(config.command!, {
      errorService: this.errorService,
      fileService: this.fileService,
      serviceBindingService: this.serviceBindingService,
      wranglerService: this.wranglerService,
      environmentService: this.environmentService,
      logService: this.logService,
    })

    // Execute command
    if (config.all) {
      const workers = this.fileService.getWorkers(config.rootDir, config.workersDirName)

      if (config.command === 'deploy') {
        for (const worker of workers) {
          params.workerName = worker
          await commandExecutor.execute(worker, params)
        }
      } else if (config.command === 'dev') {
        // leave workerName empty to execute dev for all workers
        await commandExecutor.execute('', {
          ...params,
          multiWorker: true,
        } as DevCommandParams)
      }
    } else if (params.workerName) {
      await commandExecutor.execute(params.workerName, params)
    } else {
      this.errorService.throwConfigurationError('Worker name is required')
    }
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
