import { join } from "node:path";
import { existsSync } from "node:fs";
import { 
  ErrorService,
  FileService,
  WranglerService
} from "../../services/index.js";
import { DeployCommandParams, isDeployCommandParams } from "../../types/command-types.js";
import { WRANGLER_FILE } from "../../types/wrangler-types.js";
import { WorkerCommandExecutor } from "./worker-command-executor.js";

/**
 * Command executor for the deploy command
 */
export class DeployCommand implements WorkerCommandExecutor {
  private errorService: ErrorService;
  private fileService: FileService;
  private wranglerService: WranglerService;

  /**
   * Creates a new DeployCommand
   * @param errorService Error service
   * @param fileService File service
   * @param wranglerService Wrangler service
   */
  constructor(
    errorService: ErrorService,
    fileService: FileService,
    wranglerService: WranglerService
  ) {
    this.errorService = errorService;
    this.fileService = fileService;
    this.wranglerService = wranglerService;
  }

  /**
   * Executes the deploy command
   * @param workerName Worker name
   * @param params Command parameters
   * @returns Promise that resolves when the command completes successfully
   */
  async execute(workerName: string, params: DeployCommandParams): Promise<void> {
    if (!isDeployCommandParams(params)) {
      this.errorService.throwConfigurationError("Invalid command parameters for deploy command");
    }

    try {
      // Validate worker
      this.fileService.validateWorker(params.rootDir, params.workersDirName, workerName);

      // Create temp config
      const workerPath = join(params.rootDir, params.workersDirName, workerName);
      const wranglerConfigPath = join(workerPath, WRANGLER_FILE);
      const baseConfigPath = params.baseConfig 
        ? join(params.rootDir, params.baseConfig) 
        : undefined;

      const tempWranglerConfigPath = this.fileService.createTempWranglerConfig({
        workerName,
        configPath: wranglerConfigPath,
        workerPath,
        baseConfigPath,
        replaceValues: params.variables
      });

      // Deploy secrets if needed
      if (params.deploySecrets && params.env) {
        await this.wranglerService.execWorkerCommand(
          "deploy",
          workerName,
          [tempWranglerConfigPath],
          params.env
        );
        
        await this.deploySecrets(workerName, workerPath, params.env, tempWranglerConfigPath);
        return;
      }

      // Run wrangler command
      return this.wranglerService.execWorkerCommand(
        "deploy",
        workerName,
        [tempWranglerConfigPath],
        params.env
      );
    } catch (error) {
      this.errorService.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Deploys secrets for a worker
   * @param workerName Worker name
   * @param workerPath Path to the worker directory
   * @param env Environment to use
   * @param configPath Path to the wrangler config file
   * @returns Promise that resolves when the secrets are deployed successfully
   */
  private async deploySecrets(
    workerName: string,
    workerPath: string,
    env: string,
    configPath: string
  ): Promise<void> {
    const varsPath = this.fileService.getEnvironmentFile(workerPath, env);
    if (existsSync(varsPath)) {
      try {
        return await this.wranglerService.execSecretBulkUpload(
          varsPath,
          configPath,
          env
        );
      } catch (error) {
        this.errorService.throwWorkerCommandError(
          `Failed to deploy secrets for ${workerName}: ${(error as Error).message}`
        );
      }
    }
  }
}
