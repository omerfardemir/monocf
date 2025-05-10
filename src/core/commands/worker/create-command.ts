import {join} from 'node:path'
import {existsSync, readFileSync} from 'node:fs'

import {CreateWorkerArgs, CreateWorkerFlags} from '../../../flags/index.js'
import {WranglerService} from '../../../services/index.js'
import {Commander} from '../../../types/command-types.js'
import {CreateWorkerConfig, WORKER_CLI_CONFIG_FILE} from '../../../types/config-types.js'
import {AbstractCommand} from '../abstract-command.js'

export class WorkerCreateCommand extends AbstractCommand<CreateWorkerArgs, CreateWorkerFlags> {
  private wranglerService: WranglerService

  constructor(command: Commander) {
    super(command)
    this.wranglerService = new WranglerService(this.errorService, this.fileService, command.cmdEvents())
  }

  protected async execute(args: CreateWorkerArgs, flags: CreateWorkerFlags) {
    this.logService.log('MonoCF starting to create worker...')

    // Get configuration from flags or config file
    const config = this.loadConfiguration(flags)
    const {workerName} = args

    if (!workerName) {
      this.errorService.throwConfigurationError('Worker name is required for create command')
    }

    // Validate workers directory
    const workersPath = join(config.rootDir, config.workersDirName)
    if (!existsSync(workersPath)) {
      this.errorService.throwConfigurationError(
        `Workers directory not found at ${workersPath}. Please check the workers directory.`,
      )
    }

    // Create the worker
    await this.wranglerService.createWorker({
      workerName,
      rootDir: config.rootDir,
      workersDirName: config.workersDirName,
    })

    this.logService.log('New worker created successfully')
  }

  /**
   * Loads configuration from file and command line arguments
   * @param flags Command line flags
   * @returns Loaded configuration
   */
  private loadConfiguration(flags: CreateWorkerFlags): CreateWorkerConfig {
    // Default configuration
    const config: CreateWorkerConfig = {
      rootDir: process.cwd(),
      workersDirName: '',
    }

    // Load configuration from file if it exists
    const cliConfigPath = join(process.cwd(), WORKER_CLI_CONFIG_FILE)
    if (existsSync(cliConfigPath)) {
      try {
        const parsed = JSON.parse(readFileSync(cliConfigPath, 'utf8'))
        config.rootDir = parsed.rootDir || config.rootDir
        config.workersDirName = parsed.workersDirName || config.workersDirName
      } catch (error) {
        this.errorService.throwConfigurationError(
          `Failed to parse configuration file: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    // Override with command line arguments
    if (flags.rootDir) config.rootDir = flags.rootDir
    if (flags.workersDirName) config.workersDirName = flags.workersDirName

    return config
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
