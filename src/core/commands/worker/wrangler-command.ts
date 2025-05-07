import {Commander, WorkerCommandParams} from '../../../types/command-types.js'
import {WranglerService, ConfigurationService, ServiceBindingService} from '../../../services/index.js'
import {WorkerArgs, WorkerFlags} from '../../../flags/index.js'
import {AbstractCommand} from '../abstract-command.js'
import {WorkerCommandFactory} from '../../worker-command-factory/index.js'

export class WranglerCommand extends AbstractCommand<WorkerArgs, WorkerFlags> {
  private serviceBindingService: ServiceBindingService
  private wranglerService: WranglerService
  private configService: ConfigurationService

  constructor(command: Commander) {
    super(command)
    this.configService = new ConfigurationService(this.errorService)
    this.serviceBindingService = new ServiceBindingService(this.errorService, this.fileService)
    this.wranglerService = new WranglerService(this.errorService, this.fileService, command.cmdEvents())
  }

  public async execute(args: WorkerArgs, flags: WorkerFlags): Promise<void> {
    // Load configuration
    const config = this.configService.loadConfiguration(flags, args)

    // Validate directories
    this.fileService.validateWorkersDirectory(config.rootDir, config.workersDirName)

    // Create command parameters
    const params: WorkerCommandParams = {
      command: config.command!,
      workerName: args.workerName || '',
      rootDir: config.rootDir,
      workersDirName: config.workersDirName,
      env: config.env,
      baseConfig: config.baseConfig,
      variables: config.variables,
      ...(config.command === 'deploy' && {deploySecrets: config.deploySecrets}),
    }

    // Create command executor
    const commandExecutor = WorkerCommandFactory.createCommand(config.command!, {
      errorService: this.errorService,
      fileService: this.fileService,
      serviceBindingService: this.serviceBindingService,
      wranglerService: this.wranglerService,
    })

    // Execute command
    if (config.all) {
      const workers = this.fileService.getWorkers(config.rootDir, config.workersDirName)
      for (const worker of workers) {
        params.workerName = worker
        await commandExecutor.execute(worker, params)
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
  protected async finally(): Promise<void> {
    return new Promise((resolve) => {
      this.fileService.cleanupTempFiles()
      resolve()
    })
  }
}
