import {EXIT_USAGE, MonocfError} from '../errors.js'

export type RawConfig = Record<string, unknown>

export type BindingSource =
  | 'dispatch_namespaces'
  | 'durable_objects'
  | 'services'
  | 'streaming_tail_consumers'
  | 'tail_consumers'
  | 'workflows'

export type BindingTarget = {dir: string; kind: 'local'} | {kind: 'external'; name: string}

export interface ResolvedBinding {
  binding: string
  entrypoint?: string
  source: BindingSource
  target: BindingTarget
}

export interface ResolvedWorker {
  /** Directory name, the graph identity. */
  dir: string
  /** Absolute worker directory. */
  path: string
  env?: string
  /** The final merged config, in memory. */
  config: RawConfig
  /** The name wrangler deploys under for this env. */
  deployedName: string
  bindings: ResolvedBinding[]
}

export type Notice =
  | {
      binding: string
      message: string
      name: string
      source: BindingSource
      type: 'directory-name' | 'external-binding'
      worker: string
    }
  | {
      binding: string
      message: string
      name: string
      source: BindingSource
      targetDir: string
      /** The env the name belongs to. Undefined for the name without an env suffix. */
      targetEnv?: string
      type: 'hardcoded-name'
      worker: string
    }
  | {file: string; message: string; type: 'missing-package-json' | 'missing-version'; worker: string}

/** A usage or config error: nothing was attempted. */
export class ConfigError extends MonocfError {
  readonly file?: string

  constructor(message: string, file?: string) {
    super(file ? `${file}: ${message}` : message, EXIT_USAGE)
    this.name = 'ConfigError'
    this.file = file
  }
}

export class UnknownPlaceholderError extends ConfigError {}

export function isPlainObject(value: unknown): value is RawConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
