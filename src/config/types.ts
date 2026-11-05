export type RawConfig = Record<string, unknown>

export type BindingSource = 'durable_objects' | 'services' | 'tail_consumers' | 'workflows'

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
  | {binding: string; message: string; name: string; source: BindingSource; type: 'external-binding'; worker: string}
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

export class ConfigError extends Error {
  readonly file?: string

  constructor(message: string, file?: string) {
    super(file ? `${file}: ${message}` : message)
    this.name = 'ConfigError'
    this.file = file
  }
}

export function isPlainObject(value: unknown): value is RawConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
