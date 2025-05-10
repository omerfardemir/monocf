import {existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {ErrorService} from './error-service.js'
import {TEMP_BASE_WRANGLER_FILE, TEMP_WRANGLER_FILE, TEMP_ENV_FILE} from '../types/wrangler-types.js'
import {appendLine, sanitizeWorkerName} from '../utils/index.js'
import {FileOperationError} from '../types/error-types.js'

import {experimental_patchConfig, experimental_readRawConfig} from 'wrangler'
import {getPackageVersion} from '../utils/version.js'

/**
 * Service for handling file operations
 */
export class FileService {
  private errorService: ErrorService
  private tempFiles: string[] = []

  /**
   * Creates a new FileService
   * @param errorService Error service for handling errors
   */
  constructor(errorService: ErrorService) {
    this.errorService = errorService
  }

  /**
   * Creates a temporary wrangler configuration file
   * @param {object} options Options for creating a temporary wrangler configuration file
   * @param {string} options.workerName Worker name
   * @param {string} options.configPath Path to the wrangler config file
   * @param {string} options.workerPath Path to the worker directory
   * @param {string} options.baseConfigPath Path to the base wrangler config file
   * @param {Record<string, string>} options.replaceValues Variables to replace in the config file
   * @param {string} options.env Environment to use
   * @returns Path to the temporary wrangler config file
   */
  createTempWranglerConfig(options: {
    workerName: string
    configPath: string
    workerPath: string
    baseConfigPath?: string
    replaceValues?: Record<string, string>
    env?: string
  }): string {
    try {
      const packagePath = join(options.workerPath, 'package.json')
      const tempWranglerPath = join(options.workerPath, TEMP_WRANGLER_FILE)
      const tempBaseWranglerConfigPath = join(options.workerPath, TEMP_BASE_WRANGLER_FILE)
      const tempDevVarsPath = join(options.workerPath, TEMP_ENV_FILE)

      if (existsSync(tempWranglerPath)) {
        unlinkSync(tempWranglerPath)
      }

      const jsonContent = readFileSync(options.configPath, 'utf8')
      writeFileSync(tempWranglerPath, jsonContent)

      if (options.baseConfigPath) {
        if (existsSync(tempBaseWranglerConfigPath)) {
          unlinkSync(tempBaseWranglerConfigPath)
        }

        const baseContent = readFileSync(options.baseConfigPath, 'utf8')
        writeFileSync(tempBaseWranglerConfigPath, baseContent)
      }

      if (options.baseConfigPath) {
        this.mergeConfigFiles({
          workerName: options.workerName,
          workerPath: options.workerPath,
        })
      }

      let config = readFileSync(tempWranglerPath, 'utf8')
      if (options.replaceValues) {
        for (const [key, value] of Object.entries(options.replaceValues)) {
          config = config.replaceAll(`{${key}}`, value)
        }
      }

      writeFileSync(tempWranglerPath, config, {
        encoding: 'utf8',
        flag: 'w',
      })

      // Sanitize worker name
      const {rawConfig} = experimental_readRawConfig({
        config: tempWranglerPath,
      })
      const sanitizedWorkerName = sanitizeWorkerName(rawConfig.name!)

      experimental_patchConfig(
        tempWranglerPath,
        {
          name: sanitizedWorkerName,
        },
        true,
      )

      // Add default variables
      const version = getPackageVersion(packagePath)
      const envPatch = options.env
        ? {
            env: {
              [options.env]: {
                vars: {
                  NAME: sanitizedWorkerName,
                  ENVIRONMENT: options.env ?? 'dev',
                  VERSION: version.version,
                  RELEASE: version.release,
                },
              },
            },
          }
        : {
            vars: {
              NAME: sanitizedWorkerName,
              ENVIRONMENT: options.env ?? 'dev',
              VERSION: version.version,
              RELEASE: version.release,
            },
          }

      experimental_patchConfig(tempWranglerPath, envPatch, true)

      this.tempFiles.push(tempWranglerPath, tempBaseWranglerConfigPath, tempDevVarsPath)

      return tempWranglerPath
    } catch (error) {
      this.errorService.throwFileOperationError(
        `Failed to create temporary wrangler config for ${options.workerName}: ${(error as Error).message}`,
      )
    }
  }

  /**
   * Merges config files
   * @param {object} options Options for merging config files
   * @param options.workerName Worker name
   * @param options.workerPath Path to the worker directory
   * @returns Merged config content
   */
  mergeConfigFiles({workerName, workerPath}: {workerName: string; workerPath: string}): string {
    try {
      const configPath = join(workerPath, TEMP_WRANGLER_FILE)
      const baseConfigPath = join(workerPath, TEMP_BASE_WRANGLER_FILE)

      const {rawConfig: baseRawConfig} = experimental_readRawConfig({
        config: baseConfigPath,
      })

      let config = experimental_patchConfig(configPath, baseRawConfig, true)
      config = config.replaceAll('{workerName}', workerName)

      writeFileSync(configPath, config, {
        encoding: 'utf8',
        flag: 'w',
      })

      return config
    } catch (error) {
      this.errorService.throwWorkerCommandError(`Failed to merge config files: ${(error as Error).message}`)
    }
  }

  /**
   * Cleans up temporary files
   */
  cleanupTempFiles(): void {
    for (const file of this.tempFiles) {
      try {
        if (existsSync(file)) {
          unlinkSync(file)
        }
      } catch {
        this.errorService.handleError(new Error(`Failed to delete temporary file: ${file}`), false)
      }
    }

    this.tempFiles = []
  }

  /**
   * Gets all workers in the workers directory
   * @param rootDir Root directory of the project
   * @param workersDirName Workers directory name
   * @returns Array of worker names
   */
  getWorkers(rootDir: string, workersDirName: string): string[] {
    try {
      const workersDirPath = join(rootDir, workersDirName)
      return readdirSync(workersDirPath)
    } catch (error) {
      this.errorService.throwFileOperationError(`Failed to get workers: ${(error as Error).message}`)
    }
  }

  /**
   * Validates if a worker exists
   * @param rootDir Root directory of the project
   * @param workersDirName Workers directory name
   * @param workerName Worker name
   * @throws {FileOperationError} If the worker does not exist
   */
  validateWorker(rootDir: string, workersDirName: string, workerName: string): void {
    if (!workerName) {
      this.errorService.throwConfigurationError('Worker name is required')
    }

    const workerPath = join(rootDir, workersDirName, workerName)
    if (!existsSync(workerPath)) {
      this.errorService.throwFileOperationError(`Worker not found at ${workerPath}. Please check the worker name.`)
    }
  }

  /**
   * Validates if the workers directory exists
   * @param rootDir Root directory of the project
   * @param workersDirName Workers directory name
   * @throws {FileOperationError} If the workers directory does not exist
   */
  validateWorkersDirectory(rootDir: string, workersDirName: string): void {
    const workersPath = join(rootDir, workersDirName)
    if (!existsSync(workersPath)) {
      this.errorService.throwFileOperationError(
        `Workers directory not found at ${workersPath}. Please check the workers directory.`,
      )
    }
  }

  /**
   * Gets the environment file path based on the environment
   * @param dir Path to the directory
   * @param env Environment to use
   * @returns Path to the environment file
   */
  getEnvironmentFile(dir: string, env?: string): string {
    if (!env || env === 'dev') {
      return join(dir, '.dev.vars')
    }

    const envFile = join(dir, `.dev.vars.${env}`)
    if (existsSync(envFile)) {
      return envFile
    }

    return join(dir, '.dev.vars')
  }

  /**
   * Adds lines to a gitignore file
   * @param gitignorePath Path to the gitignore file
   * @param lines Lines to add
   */
  addGitignore(gitignorePath: string, lines: string[]): void {
    try {
      for (const line of lines) {
        appendLine(gitignorePath, line, true)
      }
    } catch (error) {
      this.errorService.handleError(new Error(`Failed to update gitignore: ${(error as Error).message}`), false)
    }
  }
}
