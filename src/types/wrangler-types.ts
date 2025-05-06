/**
 * Event listener interface for wrangler command execution
 */
export interface execEventListener {
  /** Called when the command exits */
  onExitListener?: (code: number) => void;
  /** Called when the command outputs to stderr */
  onStderrListener?: (data: string) => void;
  /** Called when the command outputs to stdout */
  onStdoutListener?: (data: string) => void;
}

/**
 * Constants for wrangler files
 */
export const WRANGLER_FILE = 'wrangler.jsonc';
export const TEMP_WRANGLER_FILE = '.temp.wrangler.jsonc';
export const TEMP_BASE_WRANGLER_FILE = '.temp.base.wrangler.jsonc';
