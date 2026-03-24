import {existsSync, readFileSync} from 'node:fs'
import {dirname, join, parse, relative, resolve, sep} from 'node:path'
import {CliConfig, CliFlags, DEFAULT_BASE_CONFIG, MONOCF_CONFIG_FILE} from '../types/config-types.js'
import {Command} from '../types/command-types.js'
import {ErrorService} from './error-service.js'
import {StartDockerFlags, WorkerArgs, WorkerFlags} from '../flags/index.js'
import {ConfigurationError} from '../types/error-types.js'

/**
 * Service for handling configuration operations
 */
export class ConfigurationService {
  private errorService: ErrorService
  private cliConfig: CliConfig & CliFlags = {
    rootDir: '',
    workersDirName: '',
    baseConfig: undefined,
    deploySecrets: undefined,
    variables: undefined,
    env: undefined,
    command: undefined,
    all: false,
  }

  /**
   * Creates a new ConfigurationService
   * @param errorService Error service for handling errors
   */
  constructor(errorService: ErrorService) {
    this.errorService = errorService
  }

  /**
   * Loads configuration from file and command line arguments
   * @param flags Command line flags
   * @param args Command line arguments
   * @returns Loaded configuration
   */
  loadConfiguration(
    flags: WorkerFlags | StartDockerFlags,
    args: WorkerArgs,
  ): CliConfig & CliFlags & {workerName?: string} {
    // Search for configuration file up the directory tree
    const configPath = this.findConfigPath()
    const cliConfigPath = configPath || join(process.cwd(), MONOCF_CONFIG_FILE)
    const detectedRootDir = configPath ? dirname(configPath) : process.cwd()

    // Load configuration from file
    if (existsSync(cliConfigPath)) {
      try {
        const parsed: CliConfig = JSON.parse(readFileSync(cliConfigPath, 'utf8'))
        this.cliConfig = {
          rootDir: parsed.rootDir ? resolve(detectedRootDir, parsed.rootDir) : detectedRootDir,
          workersDirName: parsed.workersDirName || '',
          baseConfig: parsed.baseConfig,
          deploySecrets: parsed.deploySecrets,
          deployBindings: parsed.deployBindings,
          variables: parsed.variables,
          all: flags.all ?? false,
          env: flags.env,
          command: flags.command,
          port: parsed.port ?? flags.port ?? 8787,
          minify: parsed.minify,
          fromVersion: flags.fromVersion,
          deployFromVersionId: flags.deployFromVersionId,
          message: flags.message,
        }
      } catch (error) {
        this.errorService.throwConfigurationError(`Failed to parse configuration file: ${(error as Error).message}`)
      }
    } else {
      // If no config file found, set default rootDir
      this.cliConfig.rootDir = detectedRootDir
    }

    // Override with command line arguments
    if (flags.rootDir) this.cliConfig.rootDir = flags.rootDir
    if (flags.workersDirName) this.cliConfig.workersDirName = flags.workersDirName
    if (flags.baseConfig) this.cliConfig.baseConfig = flags.baseConfig
    if (flags.deploySecrets) this.cliConfig.deploySecrets = flags.deploySecrets
    if (flags.deployBindings) this.cliConfig.deployBindings = flags.deployBindings
    if (flags.minify) this.cliConfig.minify = flags.minify
    if (this.cliConfig.rootDir === '') this.cliConfig.rootDir = detectedRootDir

    // Set default base config if not specified
    if (!this.cliConfig.baseConfig) {
      const defaultPath = join(this.cliConfig.rootDir, DEFAULT_BASE_CONFIG)
      if (existsSync(defaultPath)) {
        this.cliConfig.baseConfig = DEFAULT_BASE_CONFIG
      }
    }

    // Infer worker name if not provided
    const inferredWorkerName = this.inferWorkerName(this.cliConfig.rootDir, this.cliConfig.workersDirName)
    const effectiveWorkerName = args.workerName || inferredWorkerName

    // Validate configuration
    this.validateConfiguration(effectiveWorkerName)

    return {...this.cliConfig, workerName: effectiveWorkerName}
  }

  /**
   * Finds the configuration file path by searching up the directory tree
   * @returns Path to the configuration file or null if not found
   */
  private findConfigPath(): string | null {
    let currentDir = process.cwd()
    const {root} = parse(currentDir)

    console.log('currentDir', currentDir)
    console.log('root', root)

    while (true) {
      const configPath = join(currentDir, MONOCF_CONFIG_FILE)
      if (existsSync(configPath)) {
        console.log('configPath', configPath)
        return configPath
      }

      if (currentDir === root) {
        console.log('return null')
        return null
      }

      currentDir = dirname(currentDir)
    }
  }

  /**
   * Infers the worker name from the current directory
   * @param rootDir Project root directory
   * @param workersDirName Workers directory name
   * @returns Inferred worker name or undefined
   */
  private inferWorkerName(rootDir: string, workersDirName: string): string | undefined {
    const cwd = process.cwd()
    if (!workersDirName) return undefined

    const workersDir = join(rootDir, workersDirName)

    // Check if we are inside the workers directory
    if (!cwd.startsWith(workersDir)) {
      return undefined
    }

    // Get the relative path from workers directory
    const relativePath = relative(workersDir, cwd)
    if (!relativePath || relativePath.startsWith('..')) {
      return undefined
    }

    // The first segment of the relative path is the worker name
    const parts = relativePath.split(sep)
    return parts[0]
  }

  /**
   * Validates the configuration
   * @param workerName Worker name from command line arguments or inferred
   * @throws {ConfigurationError} If the configuration is invalid
   */
  private validateConfiguration(workerName?: string): void {
    // Worker name is required for dev command
    if (!workerName && this.cliConfig.command === 'dev' && !this.cliConfig.all) {
      this.errorService.throwConfigurationError('Worker name is required for dev command')
    }

    // Worker name is not allowed when using --all flag
    if (this.cliConfig.all && workerName) {
      this.errorService.throwConfigurationError('Worker name is not allowed when using --all flag')
    }
  }

  /**
   * Gets the current configuration
   * @returns Current configuration
   */
  getConfig(): CliConfig & CliFlags {
    return this.cliConfig
  }

  /**
   * Gets the root directory
   * @returns Root directory
   */
  getRootDir(): string {
    return this.cliConfig.rootDir
  }

  /**
   * Gets the workers directory name
   * @returns Workers directory name
   */
  getWorkersDirName(): string {
    return this.cliConfig.workersDirName
  }

  /**
   * Gets the base config path
   * @returns Base config path or undefined if not set
   */
  getBaseConfig(): string | undefined {
    return this.cliConfig.baseConfig
  }

  /**
   * Gets the deploy secrets flag
   * @returns Deploy secrets flag or undefined if not set
   */
  getDeploySecrets(): boolean | undefined {
    return this.cliConfig.deploySecrets
  }

  /**
   * Gets the variables
   * @returns Variables or undefined if not set
   */
  getVariables(): Record<string, string> | undefined {
    return this.cliConfig.variables
  }

  /**
   * Gets the environment
   * @returns Environment or undefined if not set
   */
  getEnv(): string | undefined {
    return this.cliConfig.env
  }

  /**
   * Gets the command
   * @returns Command or undefined if not set
   */
  getCommand(): Command | undefined {
    return this.cliConfig.command
  }

  /**
   * Gets the all flag
   * @returns All flag
   */
  getAll(): boolean {
    return this.cliConfig.all ?? false
  }
}
