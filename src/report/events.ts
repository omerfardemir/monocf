export const SCHEMA_VERSION = 1

export type ReportEvent =
  | {action: string; env?: string; type: 'run-started'; workers: string[]}
  | {action: string; type: 'step-started'; worker: string}
  | {
      action: string
      /** Why it failed, when it failed. */
      message?: string
      /** The worker whose failure skipped this one. */
      reason?: string
      status: 'cancelled' | 'failed' | 'ok' | 'skipped'
      type: 'step-finished'
      /** Set for a `deploy` or `versions upload`. */
      versionId?: string
      worker: string
    }
  | {message: string; type: 'notice'; worker?: string}
  | {env?: string; level: 'error' | 'warning'; message: string; rule: string; type: 'finding'; worker?: string}
  | {manifest: object; path: string; type: 'bundle-written'}
  | {path: string; plan: object; type: 'plan'}
  | {extra?: string[]; missing?: string[]; note?: string; present?: string[]; type: 'secrets-check'; worker: string}
  | {exitCode: number; status: 'failed' | 'interrupted' | 'ok'; type: 'run-finished'}

export type EventSink = (event: ReportEvent) => void
