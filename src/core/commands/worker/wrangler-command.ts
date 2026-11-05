import {Commander, WorkerCommand, WorkerCommandParams} from '../../../types/command-types.js'
import {
  WranglerService,
  ConfigurationService,
  ServiceBindingService,
  EnvironmentService,
  WorkerService,
} from '../../../services/index.js'
import {WorkerArgs, WorkerFlags} from '../../../flags/index.js'
import {MonocfCommand} from '../command.js'
import {WorkerCommandFactory} from '../../worker-command-factory/index.js'
import {CliConfig, CliFlags} from '../../../types/config-types.js'

/**
 * The optional flags each command acts on. Anything else is rejected instead of being dropped.
 */
const FLAGS_BY_COMMAND: Record<WorkerCommand, Array<keyof WorkerFlags>> = {
  build: ['minify'],
  deploy: ['deployFromVersionId', 'deployBindings', 'deploySecrets', 'fromVersion', 'message', 'minify'],
  dev: ['port'],
  preview: ['deployBindings', 'deploySecrets', 'message', 'minify'],
}

const CHECKED_FLAGS: Array<keyof WorkerFlags> = [
  'deployBindings',
  'deployFromVersionId',
  'deploySecrets',
  'fromVersion',
  'message',
  'minify',
  'port',
]

export class WranglerCommand extends MonocfCommand<WorkerArgs, WorkerFlags> {
  private serviceBindingService: ServiceBindingService
  private wranglerService: WranglerService
  private configService: ConfigurationService
  private environmentService: EnvironmentService
  private workerService: WorkerService

  constructor(command: Commander) {
    super(command)
    this.configService = new ConfigurationService(this.errorService)
    this.environmentService = new EnvironmentService(this.errorService, this.fileService)
    this.serviceBindingService = new ServiceBindingService(this.errorService, this.fileService, this.environmentService)
    this.wranglerService = new WranglerService(this.errorService, this.fileService, command.cmdEvents())
    this.workerService = new WorkerService(
      this.fileService,
      this.logService,
      this.environmentService,
      this.serviceBindingService,
    )
  }

  public async execute(args: WorkerArgs, flags: WorkerFlags): Promise<void> {
    this.validateFlags(flags)

    // Load configuration
    const config = this.configService.loadConfiguration(flags, args)

    // Validate directories
    this.fileService.validateWorkersDirectory(config.rootDir, config.workersDirName)

    // Load ignore file
    this.fileService.loadIgnoreFile(config.rootDir, config.workersDirName)

    this.environmentService.setRootDir(config.rootDir)
    this.wranglerService.setRootDir(config.rootDir)

    // A version ID belongs to one worker, and -f can't run for several
    if ((flags.fromVersion || flags.deployFromVersionId) && (config.all || config.deployBindings)) {
      this.errorService.throwConfigurationError(
        'Deploying from a version works for one named worker. It cannot be combined with --all or with --deploy-bindings, also when deployBindings is set in monocf.config.json.',
      )
    }

    // Create command parameters
    const params: WorkerCommandParams = this.buildParams(
      {
        ...config,
        ...args,
        workerName: config.workerName,
      },
      flags,
    )

    // Create command executor
    const commandExecutor = WorkerCommandFactory.createCommand(params.command, {
      errorService: this.errorService,
      fileService: this.fileService,
      serviceBindingService: this.serviceBindingService,
      wranglerService: this.wranglerService,
      environmentService: this.environmentService,
      logService: this.logService,
    })

    if (!config.all && !config.workerName) {
      this.errorService.throwConfigurationError('Worker name is required if --all flag is not set')
    }

    const workers = this.fileService.selectWorkers(
      config.rootDir,
      config.workersDirName,
      config.all ? undefined : config.workerName,
    )

    if (workers.length === 0) {
      this.errorService.throwConfigurationError(`No workers found`)
    }

    this.workerService.validateWorkers(workers, params, {
      followBindings: 'deployBindings' in params && params.deployBindings,
      requireSecrets: 'deploySecrets' in params && params.deploySecrets,
    })

    await commandExecutor.execute(workers, {
      ...params,
      ...((params.command === 'dev' || params.command === 'build') && {
        multiWorker: config.all,
      }),
    })
  }

  /**
   * Rejects flags that would otherwise be silently ignored
   * @param flags Command line flags
   */
  private validateFlags(flags: WorkerFlags): void {
    if (flags.deployFromVersionId && !flags.fromVersion) {
      this.errorService.throwConfigurationError('--deploy-from-version-id requires --from-version')
    }

    // wrangler deploy has no --message; versions deploy does
    if (flags.command === 'deploy' && flags.message && !flags.fromVersion) {
      this.errorService.throwConfigurationError('--message on deploy requires --from-version')
    }

    if (flags.fromVersion && flags.minify) {
      this.errorService.throwConfigurationError('--minify has no effect with --from-version, which uploads nothing')
    }

    const command = this.validateCommand(flags.command!)
    for (const flag of CHECKED_FLAGS) {
      if (flags[flag] !== undefined && !FLAGS_BY_COMMAND[command].includes(flag)) {
        const name = flag.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
        this.errorService.throwConfigurationError(`--${name} is not supported by the ${command} command`)
      }
    }
  }

  private buildParams(params: CliConfig & CliFlags & WorkerArgs, flags: WorkerFlags): WorkerCommandParams {
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
      // Only the flag: preview has never read deployBindings from monocf.config.json
      ...(params.command === 'preview' && {
        deploySecrets: params.deploySecrets,
        deployBindings: flags.deployBindings,
        message: params.message,
      }),
      ...(params.command === 'dev' && {explicitPort: flags.port}),
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
