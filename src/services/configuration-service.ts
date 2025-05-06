import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { 
  CliConfig, 
  CliFlags, 
  DEFAULT_BASE_CONFIG, 
  WORKER_CLI_CONFIG_FILE 
} from "../types/config-types.js";
import { WorkerCommand } from "../types/command-types.js";
import { ErrorService } from "./error-service.js";
import { WorkerArgs, WorkerFlags } from "../flags/index.js";
import { ConfigurationError } from "../types/error-types.js";

/**
 * Service for handling configuration operations
 */
export class ConfigurationService {
  private errorService: ErrorService;
  private cliConfig: CliConfig & CliFlags = {
    rootDir: '',
    workersDirName: '',
    baseConfig: undefined,
    deploySecrets: undefined,
    variables: undefined,
    env: undefined,
    command: undefined,
    all: false
  };

  /**
   * Creates a new ConfigurationService
   * @param errorService Error service for handling errors
   */
  constructor(errorService: ErrorService) {
    this.errorService = errorService;
  }

  /**
   * Loads configuration from file and command line arguments
   * @param flags Command line flags
   * @param args Command line arguments
   * @returns Loaded configuration
   */
  loadConfiguration(
    flags: WorkerFlags,
    args: WorkerArgs
  ): CliConfig & CliFlags {
    // Load configuration from file
    const cliConfigPath = join(process.cwd(), WORKER_CLI_CONFIG_FILE);
    if (existsSync(cliConfigPath)) {
      try {
        const parsed: CliConfig = JSON.parse(readFileSync(cliConfigPath, 'utf8'));
        this.cliConfig = {
          rootDir: parsed.rootDir || process.cwd(),
          workersDirName: parsed.workersDirName || '',
          baseConfig: parsed.baseConfig,
          deploySecrets: parsed.deploySecrets,
          variables: parsed.variables,
          all: flags.all ?? false,
          env: flags.env,
          command: flags.command
        };
      } catch (error) {
        this.errorService.throwConfigurationError(
          `Failed to parse configuration file: ${(error as Error).message}`
        );
      }
    }

    // Override with command line arguments
    if (flags.rootDir) this.cliConfig.rootDir = flags.rootDir;
    if (flags.workersDirName) this.cliConfig.workersDirName = flags.workersDirName;
    if (flags.baseConfig) this.cliConfig.baseConfig = flags.baseConfig;
    if (flags.deploySecrets) this.cliConfig.deploySecrets = flags.deploySecrets;
    if (this.cliConfig.rootDir === '') this.cliConfig.rootDir = process.cwd();
    
    // Set default base config if not specified
    if (!this.cliConfig.baseConfig) {
      const defaultPath = join(this.cliConfig.rootDir, DEFAULT_BASE_CONFIG);
      if (existsSync(defaultPath)) {
        this.cliConfig.baseConfig = DEFAULT_BASE_CONFIG;
      }
    }

    // Validate configuration
    this.validateConfiguration(args.workerName);

    return this.cliConfig;
  }

  /**
   * Validates the configuration
   * @param workerName Worker name from command line arguments
   * @throws {ConfigurationError} If the configuration is invalid
   */
  private validateConfiguration(workerName?: string): void {
    // Worker name is required for dev command
    if (!workerName && this.cliConfig.command === 'dev' && !this.cliConfig.all) {
      this.errorService.throwConfigurationError(
        'Worker name is required for dev command'
      );
    }

    // Worker name is not allowed when using --all flag
    if (this.cliConfig.all && workerName) {
      this.errorService.throwConfigurationError(
        'Worker name is not allowed when using --all flag'
      );
    }

    // Validate command
    if (!this.cliConfig.command) {
      this.errorService.throwConfigurationError(
        'Command is required'
      );
    }
  }

  /**
   * Gets the current configuration
   * @returns Current configuration
   */
  getConfig(): CliConfig & CliFlags {
    return this.cliConfig;
  }

  /**
   * Gets the root directory
   * @returns Root directory
   */
  getRootDir(): string {
    return this.cliConfig.rootDir;
  }

  /**
   * Gets the workers directory name
   * @returns Workers directory name
   */
  getWorkersDirName(): string {
    return this.cliConfig.workersDirName;
  }

  /**
   * Gets the base config path
   * @returns Base config path or undefined if not set
   */
  getBaseConfig(): string | undefined {
    return this.cliConfig.baseConfig;
  }

  /**
   * Gets the deploy secrets flag
   * @returns Deploy secrets flag or undefined if not set
   */
  getDeploySecrets(): boolean | undefined {
    return this.cliConfig.deploySecrets;
  }

  /**
   * Gets the variables
   * @returns Variables or undefined if not set
   */
  getVariables(): Record<string, string> | undefined {
    return this.cliConfig.variables;
  }

  /**
   * Gets the environment
   * @returns Environment or undefined if not set
   */
  getEnv(): string | undefined {
    return this.cliConfig.env;
  }

  /**
   * Gets the command
   * @returns Command or undefined if not set
   */
  getCommand(): WorkerCommand | undefined {
    return this.cliConfig.command;
  }

  /**
   * Gets the all flag
   * @returns All flag
   */
  getAll(): boolean {
    return this.cliConfig.all ?? false;
  }
}
