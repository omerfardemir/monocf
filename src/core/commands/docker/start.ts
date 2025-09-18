import {Commander, DockerParams} from '../../../types/command-types.js'
import {MonocfCommand} from '../command.js'
import {StartDockerFlags, WorkerArgs} from '../../../flags/index.js'
import {
  ConfigurationService,
  EnvironmentService,
  ServiceBindingService,
  DockerService,
  WorkerService,
  GenerateConfigService,
} from '../../../services/index.js'

/**
 * Command executor for the docker start command
 */
export class DockerStartCommand extends MonocfCommand<WorkerArgs, StartDockerFlags> {
  private configService: ConfigurationService
  private environmentService: EnvironmentService
  private dockerService: DockerService
  private generateConfigService: GenerateConfigService
  private workerService: WorkerService
  private serviceBindingService: ServiceBindingService

  constructor(command: Commander) {
    super(command)
    this.configService = new ConfigurationService(this.errorService)
    this.environmentService = new EnvironmentService(this.errorService, this.fileService)
    this.dockerService = new DockerService()
    this.generateConfigService = new GenerateConfigService(this.errorService, this.fileService, this.logService)
    this.serviceBindingService = new ServiceBindingService(this.errorService, this.fileService, this.environmentService)
    this.workerService = new WorkerService(
      this.fileService,
      this.logService,
      this.environmentService,
      this.serviceBindingService,
    )
  }

  public async execute(args: WorkerArgs, flags: StartDockerFlags): Promise<void> {
    // Load configuration
    const config = this.configService.loadConfiguration(flags, args)

    // Validate directories
    this.fileService.validateWorkersDirectory(config.rootDir, config.workersDirName)

    this.environmentService.setRootDir(config.rootDir)

    // Create command parameters
    const params: DockerParams = {
      rootDir: config.rootDir,
      workersDirName: config.workersDirName,
      env: config.env,
      baseConfig: config.baseConfig,
      variables: config.variables,
      port: flags.port ?? 8787,
    }

    // initialize workers
    const workers = this.fileService.getWorkers(params.rootDir, params.workersDirName)

    const workersConfigPaths = workers
      .map((workerName) => this.workerService.initializeWorker(workerName, params))
      .filter((worker) => worker !== undefined)

    for (const worker of workersConfigPaths) {
      // create .temp.dev.vars
      const envPath = this.environmentService.createTempEnvFile(worker.workerPath, params.env)
      worker.envPath = envPath
    }

    // generate docker config files
    await this.generateConfigService.generateDockerConfig(
      workersConfigPaths.map((worker) => ({
        name: worker.workerName,
        path: worker.workerPath,
        config: worker.tempWranglerConfigPath,
        envPath: worker.envPath,
      })),
      params,
    )

    // Start docker container
    return this.dockerService.start()
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
