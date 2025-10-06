import {execEventListener} from './wrangler-types.js'

/**
 * Interface for command handler
 */
export interface Commander {
  /** Gets the command events */
  cmdEvents(): execEventListener
  /** Logs an error */
  error(
    input: Error | string,
    options: {
      code?: string
      exit: false
    },
  ): void
  error(
    input: Error | string,
    options?: {
      code?: string
      exit?: number
    },
  ): never
  /** Logs a warning */
  warn(input: Error | string): Error | string
  /** Logs a message */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(message?: string, ...args: any[]): void
}

/**
 * Available worker commands
 */
export type WorkerCommand = 'deploy' | 'dev' | 'build' | 'preview'

export type Command = WorkerCommand | 'docker' | 'create'

/**
 * Base interface for all worker command parameters
 */
export interface BaseCommandParams {
  /** Root directory of the project */
  rootDir: string
  /** Workers directory name in monorepo */
  workersDirName: string
  /** Environment to use (dev, production etc.) */
  env?: string
  /** Base wrangler config file */
  baseConfig?: string
  /** Variables to replace in the config file */
  variables?: Record<string, string>
}

export interface DockerParams extends BaseCommandParams {
  /** Port to use for the docker container */
  port?: number
}

/**
 * Parameters specific to the dev command
 */
export interface DevCommandParams extends BaseCommandParams {
  /** Worker name */
  workerName: string
  /** Command type */
  command: 'dev'
  /** Whether to run dev for multiple workers */
  multiWorker?: boolean
  /** Port to use for the proxy worker */
  port?: number
}

/**
 * Parameters specific to the deploy command
 */
export interface DeployCommandParams extends BaseCommandParams {
  /** Worker name */
  workerName: string
  /** Command type */
  command: 'deploy'
  /** Whether to deploy secrets for the worker */
  deploySecrets?: boolean
  /** Whether to deploy service bindings for the worker */
  deployBindings?: boolean
  /** Whether to minify the output */
  minify?: boolean
  /** Message for the deploy version */
  message?: string
  /** Whether to deploy from an existing version */
  fromVersion?: boolean
  /** If specified, deploys from an existing version ID instead of creating a new version */
  deployFromVersionId?: string
}

/**
 * Parameters specific to the preview command
 */
export interface PreviewCommandParams extends BaseCommandParams {
  /** Worker name */
  workerName: string
  /** Command type */
  command: 'preview'
  /** Whether to deploy secrets for the worker */
  deploySecrets?: boolean
  /** Whether to deploy service bindings for the worker */
  deployBindings?: boolean
  /** Whether to minify the output */
  minify?: boolean
  /** Message for the preview version */
  message?: string
}

export interface BuildCommandParams extends BaseCommandParams {
  /** Worker name */
  workerName: string
  /** Command type */
  command: 'build'
  /** Whether to run dev for multiple workers */
  multiWorker?: boolean
  /** Whether to minify the output */
  minify?: boolean
}

/**
 * Union type of all command parameters
 */
export type WorkerCommandParams = DevCommandParams | DeployCommandParams | BuildCommandParams | PreviewCommandParams

/**
 * Type guard to check if parameters are for dev command
 * @param params Worker command parameters
 * @returns True if parameters are for dev command
 */
export function isDevCommandParams(params: WorkerCommandParams): params is DevCommandParams {
  return params.command === 'dev'
}

/**
 * Type guard to check if parameters are for deploy command
 * @param params Worker command parameters
 * @returns True if parameters are for deploy command
 */
export function isDeployCommandParams(params: WorkerCommandParams): params is DeployCommandParams {
  return params.command === 'deploy'
}

/**
 * Type guard to check if parameters are for build command
 * @param params Worker command parameters
 * @returns True if parameters are for build command
 */
export function isBuildCommandParams(params: WorkerCommandParams): params is BuildCommandParams {
  return params.command === 'build'
}

/**
 * Type guard to check if parameters are for deploy command
 * @param params Worker command parameters
 * @returns True if parameters are for deploy command
 */
export function isPreviewCommandParams(params: WorkerCommandParams): params is PreviewCommandParams {
  return params.command === 'preview'
}
