import dotenv from 'dotenv'

import {existsSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {ErrorService} from './error-service.js'
import {FileService} from './file-service.js'

import {TEMP_ENV_FILE} from '../types/wrangler-types.js'

/**
 * Service for handling environment operations
 */
export class EnvironmentService {
  private errorService: ErrorService
  private fileService: FileService
  private backupList: {
    envFile: string
    env: Record<string, string>
  }[] = []
  private rootDir: string = ''
  private tempEnvPath: string | undefined

  /**
   * Creates a new EnvironmentService
   * @param errorService Error service for handling errors
   * @param fileService File service for handling file operations
   */
  constructor(errorService: ErrorService, fileService: FileService) {
    this.errorService = errorService
    this.fileService = fileService
  }

  setRootDir(rootDir: string): void {
    this.rootDir = rootDir
  }

  /**
   * Overrides the environment variables for the worker
   * @param workerPath Path to the worker directory
   * @param env Environment to override
   */
  patchEnvironmentFile(workerPath: string, env?: string): void {
    const workerEnvPath = this.getWorkerEnvFile(workerPath, env)
    const workerEnvVars = this.parseEnvironmentVariables(workerEnvPath)
    const rootEnvPath = this.getRootEnvFile(env)
    const rootEnvVars = this.parseEnvironmentVariables(rootEnvPath)

    if (!workerEnvPath || !rootEnvPath) {
      return
    }

    this.backupList.push({
      envFile: workerEnvPath,
      env: workerEnvVars,
    })

    this.writeEnvironmentVariables(workerEnvPath, {...rootEnvVars, ...workerEnvVars})
  }

  /**
   * Validates that a worker has the exact environment file for a secret upload
   * @param workerPath Path to the worker directory
   * @param env Environment to use
   * @throws If the file does not exist
   */
  validateSecretsFile(workerPath: string, env?: string): void {
    const envPath = this.fileService.getExactEnvironmentFile(workerPath, env)
    if (!existsSync(envPath)) {
      this.errorService.throwConfigurationError(
        `Secrets file not found at ${envPath}. Uploading secrets requires this exact file, with no fallback to another environment.`,
      )
    }
  }

  /**
   * Creates the file for a secret upload from the exact environment files of the worker and the root
   * @param workerPath Path to the worker directory
   * @param env Environment to use
   * @returns Path to the temporary environment file
   */
  createTempEnvFile(workerPath: string, env?: string): string {
    this.validateSecretsFile(workerPath, env)

    const workerEnvVars = this.readUnpatchedVariables(this.fileService.getExactEnvironmentFile(workerPath, env))
    const rootEnvVars = this.readUnpatchedVariables(this.fileService.getExactEnvironmentFile(this.rootDir, env))
    const tempEnvPath = join(workerPath, TEMP_ENV_FILE)

    try {
      if (existsSync(tempEnvPath)) {
        unlinkSync(tempEnvPath)
      }
    } catch (error) {
      this.errorService.throwFileOperationError(
        `Failed to delete temporary environment variables file: ${(error as Error).message}`,
      )
    }

    if (!workerEnvVars && !rootEnvVars) {
      return tempEnvPath
    }

    this.writeEnvironmentVariables(tempEnvPath, {...rootEnvVars, ...workerEnvVars})
    this.tempEnvPath = tempEnvPath
    return tempEnvPath
  }

  /**
   * Rolls back the environment variables for the worker
   */
  rollbackEnvironmentVariables(): void {
    const len = this.backupList.length

    if (len > 0) {
      for (let i = len - 1; i >= 0; i--) {
        const {envFile, env} = this.backupList[i]
        this.writeEnvironmentVariables(envFile, env)
        this.backupList.pop()
      }
    }

    if (this.tempEnvPath) {
      try {
        if (existsSync(this.tempEnvPath)) {
          unlinkSync(this.tempEnvPath)
        }
      } catch (error) {
        this.errorService.throwFileOperationError(
          `Failed to delete temporary environment variables file: ${(error as Error).message}`,
        )
      }

      this.tempEnvPath = undefined
    }
  }

  /**
   * Gets the environment file path based on the environment
   * @param workerPath Path to the worker directory
   * @param env Environment to get the environment file
   * @returns Path to the environment file
   */
  private getWorkerEnvFile(workerPath: string, env?: string): string {
    return this.fileService.getEnvironmentFile(workerPath, env)
  }

  /**
   * Gets the root environment file path based on the environment
   * @param env Environment to get the root environment file
   * @returns Path to the root environment file
   */
  private getRootEnvFile(env?: string): string {
    return this.fileService.getEnvironmentFile(this.rootDir, env)
  }

  /**
   * Reads a file as it was before this run patched it. Patching merges the root file, which
   * can come from another environment through the local fallback, so it can't feed a secret upload.
   * @param filePath Path to the environment file
   * @returns Environment variables
   */
  private readUnpatchedVariables(filePath: string): Record<string, string> {
    const backup = this.backupList.find(({envFile}) => envFile === filePath)
    return backup ? backup.env : this.parseEnvironmentVariables(filePath)
  }

  /**
   * Parses environment variables from the environment file
   * @param filePath Path to the environment file
   * @returns Parsed environment variables
   */
  private parseEnvironmentVariables(filePath: string): Record<string, string> {
    if (existsSync(filePath)) {
      try {
        const envContent = readFileSync(filePath, 'utf8')
        return dotenv.parse(envContent)
      } catch (error) {
        this.errorService.throwFileOperationError(
          `Failed to read environment variables from ${filePath}: ${(error as Error).message}`,
        )
      }
    }

    return {}
  }

  /**
   * Writes environment variables to the environment file
   * @param filePath Path to the environment file
   * @param vars Environment variables to write
   */
  private writeEnvironmentVariables(filePath: string, vars: Record<string, string>): void {
    if (!filePath) {
      return
    }

    try {
      writeFileSync(
        filePath,
        Object.entries(vars)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
      )
    } catch (error) {
      this.errorService.throwFileOperationError(
        `Failed to write environment variables to ${filePath}: ${(error as Error).message}`,
      )
    }
  }
}
