import { execEventListener } from "./wrangler-types.js";

/**
 * Interface for command handler 
 */
export interface Commander {
  cmdEvents(): execEventListener;
  error(error: Error | string, ...args: unknown[]): never;
  warn(input: Error | string): Error | string;
}

/**
 * Available worker commands
 */
export type WorkerCommand = 'deploy' | 'dev';

/**
 * Base interface for all worker command parameters
 */
export interface BaseCommandParams {
  /** Worker name */
  workerName: string;
  /** Root directory of the project */
  rootDir: string;
  /** Workers directory name in monorepo */
  workersDirName: string;
  /** Environment to use (dev, production etc.) */
  env?: string;
  /** Base wrangler config file */
  baseConfig?: string;
  /** Variables to replace in the config file */
  variables?: Record<string, string>;
}

/**
 * Parameters specific to the dev command
 */
export interface DevCommandParams extends BaseCommandParams {
  /** Command type */
  command: 'dev';
}

/**
 * Parameters specific to the deploy command
 */
export interface DeployCommandParams extends BaseCommandParams {
  /** Command type */
  command: 'deploy';
  /** Whether to deploy secrets for the worker */
  deploySecrets?: boolean;
}

/**
 * Union type of all command parameters
 */
export type WorkerCommandParams = DevCommandParams | DeployCommandParams;

/**
 * Type guard to check if parameters are for dev command
 * @param params Worker command parameters
 * @returns True if parameters are for dev command
 */
export function isDevCommandParams(params: WorkerCommandParams): params is DevCommandParams {
  return params.command === 'dev';
}

/**
 * Type guard to check if parameters are for deploy command
 * @param params Worker command parameters
 * @returns True if parameters are for deploy command
 */
export function isDeployCommandParams(params: WorkerCommandParams): params is DeployCommandParams {
  return params.command === 'deploy';
}