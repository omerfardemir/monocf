import { join } from "node:path";
import { existsSync } from "node:fs";
import { experimental_patchConfig, experimental_readRawConfig } from "wrangler";
import { ErrorService } from "./error-service.js";
import { ServiceBindingError } from "../types/error-types.js";
import { FileService } from "./file-service.js";
import { WRANGLER_FILE } from "../types/wrangler-types.js";

/**
 * Service for handling service bindings
 */
export class ServiceBindingService {
  private errorService: ErrorService;
  private fileService: FileService;

  /**
   * Creates a new ServiceBindingService
   * @param errorService Error service for handling errors
   * @param fileService File service for handling files
   */
  constructor(errorService: ErrorService, fileService: FileService) {
    this.errorService = errorService;
    this.fileService = fileService;
  }

  /**
   * Handles service bindings for a worker
   * @param {object} options Options for handling service bindings
   * @param {string} options.configPath Path to the wrangler config file
   * @param {string} options.rootDir Root directory of the project
   * @param {string} options.workersDirName Workers directory name
   * @param {string} options.baseConfigPath Path to the base wrangler config file
   * @param {Record<string, string>} options.variables Variables to replace in the config file
   * @returns Paths to the service binding config files
   */
  handleServiceBindings(options: {
    configPath: string,
    rootDir: string,
    workersDirName: string,
    baseConfigPath?: string,
    variables?: Record<string, string>
  }): string[] {
    try {
      // Get service bindings from the config file
      const serviceBindings = this.getServiceBindings(options.configPath);
      if (serviceBindings.length === 0) {
        return [];
      }

      const serviceBindingPaths: string[] = [];

      // Process each service binding
      for (const { binding, service } of serviceBindings) {
        // Validate service
        const servicePath = join(options.rootDir, options.workersDirName, service);
        this.validateService(service, servicePath);

        // Create temp config for the service
        const serviceConfigPath = join(servicePath, WRANGLER_FILE);
        const tempWranglerConfigPath = this.fileService.createTempWranglerConfig({
          workerName: service,
          configPath: serviceConfigPath,
          workerPath: servicePath,
          baseConfigPath: options.baseConfigPath,
          replaceValues: options.variables,
        });

        // Update the main config with the service binding
        const { rawConfig } = experimental_readRawConfig({
          config: tempWranglerConfigPath,
        });

        experimental_patchConfig(
          options.configPath,
          {
            services: [
              {
                binding,
                service: rawConfig.name!,
              },
            ],
          },
          false
        );

        serviceBindingPaths.push(tempWranglerConfigPath);
      }

      return serviceBindingPaths;
    } catch (error) {
      this.errorService.throwWorkerCommandError(
        `Failed to handle service bindings: ${(error instanceof Error) ? error.message : String(error)}`
      );
    }
  }

  /**
   * Gets service bindings from a wrangler config file
   * @param configPath Path to the wrangler config file
   * @returns Array of service bindings
   */
  private getServiceBindings(configPath: string): Array<{ binding: string; service: string }> {
    try {
      const { rawConfig } = experimental_readRawConfig({
        config: configPath,
      });
      const services = rawConfig.services || [];
      
      return services.map((service: { binding: string; service: string }) => ({
        binding: service.binding,
        service: service.service,
      }));
    } catch (error) {
      this.errorService.throwWorkerCommandError(
        `Failed to get service bindings: ${(error instanceof Error) ? error.message : String(error)}`
      );
    }
  }

  /**
   * Validates if a service exists
   * @param serviceName Service name
   * @param servicePath Path to the service directory
   * @throws {ServiceBindingError} If the service does not exist
   */
  private validateService(serviceName: string, servicePath: string): void {
    if (!existsSync(servicePath)) {
      this.errorService.throwServiceBindingError(
        `Service ${serviceName} not found at ${servicePath}`
      );
    }

    const serviceConfigPath = join(servicePath, WRANGLER_FILE);
    if (!existsSync(serviceConfigPath)) {
      this.errorService.throwServiceBindingError(
        `Service ${serviceName} config not found at ${serviceConfigPath}`
      );
    }
  }
}
