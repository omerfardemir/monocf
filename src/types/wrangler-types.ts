/**
 * Constants for wrangler files
 */
export const WRANGLER_FILE = 'wrangler.jsonc'
export const TEMP_WRANGLER_FILE = '.temp.wrangler.jsonc'
export const TEMP_BASE_WRANGLER_FILE = '.temp.base.wrangler.jsonc'
export const TEMP_ENV_FILE = '.temp.dev.vars'

/**
 * Event listener interface for wrangler command execution
 */
export interface execEventListener {
  /** Called when the command exits */
  onExitListener?: (code: number) => void
  /** Called when the command outputs to stderr */
  onStderrListener?: (data: string) => void
  /** Called when the command outputs to stdout */
  onStdoutListener?: (data: string) => void
}

export interface ServiceBindingOptions {
  binding: string
  service: string
  environment?: string
  entrypoint?: string
  props?: Record<string, unknown>
}

/**
 * Worker version interface
 * It is output from `wrangler versions list --json`
 */
export interface WorkerVersion {
  id: string
  number: number
  metadata: {
    created_on: string
    source: string
    author_id: string
    author_email: string
    has_preview: boolean
  }
  annotations: Array<{key: string; value: string}>
}
