import {existsSync, readFileSync} from 'node:fs'

export type OutputEntry = Record<string, unknown> & {type?: unknown}

export interface WranglerOutput {
  entries: OutputEntry[]
  /** From a `command-failed` entry. */
  failure?: {code?: number; message?: string}
  /** From a `deploy` or `version-upload` entry. */
  versionId?: string
}

/** Parses what wrangler wrote to WRANGLER_OUTPUT_FILE_PATH: one JSON object per line. */
export function parseOutput(text: string): WranglerOutput {
  const entries = text.split('\n').flatMap((line): OutputEntry[] => {
    if (line.trim() === '') return []
    try {
      const entry: unknown = JSON.parse(line)
      return typeof entry === 'object' && entry !== null ? [entry as OutputEntry] : []
    } catch {
      return []
    }
  })

  const output: WranglerOutput = {entries}
  for (const entry of entries) {
    if ((entry.type === 'deploy' || entry.type === 'version-upload') && typeof entry.version_id === 'string') {
      output.versionId = entry.version_id
    }

    if (entry.type === 'command-failed') {
      output.failure = {
        ...(typeof entry.code === 'number' && {code: entry.code}),
        ...(typeof entry.message === 'string' && {message: entry.message}),
      }
    }
  }

  return output
}

export function readOutputFile(path: string): WranglerOutput {
  return existsSync(path) ? parseOutput(readFileSync(path, 'utf8')) : {entries: []}
}
