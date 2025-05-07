import {WorkerCommand} from './command-types.js'

/**
 * Constants for configuration files
 */
export const DEFAULT_BASE_CONFIG = 'base.wrangler.jsonc'
export const WORKER_CLI_CONFIG_FILE = 'worker.config.json'

/**
 * CLI configuration interface
 */
export interface CliConfig {
  /** Root directory of the project */
  rootDir: string
  /** Workers directory name in monorepo */
  workersDirName: string
  /** Base wrangler config file */
  baseConfig?: string
  /** Whether to deploy secrets for the worker */
  deploySecrets?: boolean
  /** Variables to replace in the config file */
  variables?: Record<string, string>
}

/**
 * CLI flags interface
 */
export interface CliFlags {
  /** Whether to run command for all workers */
  all?: boolean
  /** Environment to use (dev, production etc.) */
  env?: string
  /** Command to execute (dev or deploy) */
  command?: WorkerCommand
}

/**
 * Create worker configuration interface
 */
export interface CreateWorkerConfig {
  /** Root directory of the project */
  rootDir: string
  /** Workers directory name in monorepo */
  workersDirName: string
}
