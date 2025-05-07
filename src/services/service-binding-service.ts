import { join } from "node:path";
import { existsSync } from "node:fs";
import { experimental_patchConfig, experimental_readRawConfig } from "wrangler";
import { ErrorService } from "./error-service.js";
import { ServiceBindingError } from "../types/error-types.js";
import { FileService } from "./file-service.js";
import { ServiceBindingOptions, WRANGLER_FILE } from "../types/wrangler-types.js";
import { sanitizeWorkerName } from "../utils/string.js";

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
   * Creates service bindings for a worker
   * @param {object} options Options for creating service bindings
   * @param {string} options.configPath Path to the wrangler config file
   * @param {string} options.rootDir Root directory of the project
   * @param {string} options.workersDirName Workers directory name
   * @param {string} options.baseConfigPath Path to the base wrangler config file
   * @param {Record<string, string>} options.variables Variables to replace in the config file
   * @param {string} options.env Environment to use
   * @returns Paths to the service binding config files
   */
  createServiceBindings(options: {
    configPath: string,
    rootDir: string,
    workersDirName: string,
    baseConfigPath?: string,
    variables?: Record<string, string>,
    env?: string
  }, recursive?: boolean): Array<ServiceBindingOptions & { path: string }> {
    try {
      // Get service bindings from the config file
      const serviceBindings = this.getServiceBindings(options.configPath, options.env);
      if (serviceBindings.length === 0) {
        return [];
      }

      const serviceBindingPaths: Array<ServiceBindingOptions & {
        path: string
      }> = [];

      // Process each service binding
      for (const serviceBinding of serviceBindings) {
        const { binding, service } = serviceBinding;
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

        const patchData = options.env ? {
          env: {
            [options.env]: {
              services: [
                {
                  binding,
                  service: rawConfig.name!,
                },
              ],
            },
          },
        } : {
          services: [
            {
              binding,
              service: rawConfig.name!,
            },
          ],
        }

        experimental_patchConfig(
          options.configPath,
          patchData,
          false
        );

        // Handle service bindings
        if (recursive) {
          const recursiveServiceBindingPaths = this.createServiceBindings({
            configPath: tempWranglerConfigPath,
            rootDir: options.rootDir,
            workersDirName: options.workersDirName,
            baseConfigPath: options.baseConfigPath,
            variables: options.variables,
            env: options.env
          }, true);

          serviceBindingPaths.push(...recursiveServiceBindingPaths);
        }

        const serviceBindingWithPath: ServiceBindingOptions & { path: string } = {
          ...serviceBinding,
          service: rawConfig.name!,
          path: tempWranglerConfigPath
        };

        serviceBindingPaths.push(serviceBindingWithPath);
      }

      return serviceBindingPaths;
    } catch (error) {
      this.errorService.throwWorkerCommandError(
        `Failed to create service bindings: ${(error instanceof Error) ? error.message : String(error)}`
      );
    }
  }

  handleServiceBinding(options: {
    configPath: string,
    rootDir: string,
    workersDirName: string,
    baseConfigPath?: string,
    variables?: Record<string, string>,
    env?: string
  }): Array<ServiceBindingOptions> {
    try {
      const serviceBindings = this.getServiceBindings(options.configPath, options.env);
      if (serviceBindings.length === 0) {
        return [];
      }

      const serviceBindingsWithPaths = this.createServiceBindings(options, false);

      if (serviceBindingsWithPaths.length === 0) {
        return [];
      }

      const services: Array<ServiceBindingOptions> = [];

      // Process each service binding
      for (const serviceBindingPath of serviceBindingsWithPaths) {
        let serviceName = serviceBindingPath.service;

        if (options.env) {
          serviceName += `-${options.env}`;
        }

        services.push({ 
          binding: serviceBindingPath.binding, 
          service: sanitizeWorkerName(serviceName) 
        });
      }

      return services;
    } catch (error) {
      this.errorService.throwWorkerCommandError(
        `Failed to handle service binding: ${(error instanceof Error) ? error.message : String(error)}`
      );
    }
  }

  /**
   * Gets service bindings from a wrangler config file
   * @param configPath Path to the wrangler config file
   * @returns Array of service bindings
   */
  public getServiceBindings(configPath: string, env?: string): Array<ServiceBindingOptions> {
    try {
      const { rawConfig } = experimental_readRawConfig({
        config: configPath,
      });

      if (env) {
        return rawConfig.env?.[env]?.services || [];
      }
      
      return rawConfig.services || [];
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
