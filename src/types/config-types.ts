import {Command} from './command-types.js'

/**
 * Constants for configuration files
 */
export const DEFAULT_BASE_CONFIG = 'base.wrangler.jsonc'
export const MONOCF_CONFIG_FILE = 'monocf.config.json'
export const MONOCF_IGNORE_FILE = '.monocfignore'
export const MONOCF_FOLDER = './.monocf'
export const VERSIONS_FOLDER = `${MONOCF_FOLDER}/versions`

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
  /** Whether to deploy service bindings for the worker */
  deployBindings?: boolean
  /** Port to use for the dev command */
  port?: number
  /** Whether to minify the worker code (only for build command) */
  minify?: boolean
  /** Whether to deploy from an existing version */
  fromVersion?: boolean
  /** Specific version ID to deploy from (only if fromVersion is true) */
  deployFromVersionId?: string
  /** Message for the deploy version */
  message?: string
}

/**
 * CLI flags interface
 */
export interface CliFlags {
  /** Whether to run command for all workers */
  all?: boolean
  /** Environment to use (dev, production etc.) */
  env?: string
  /** Command to execute */
  command?: Command
  /** Port to use for the dev command */
  port?: number
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
