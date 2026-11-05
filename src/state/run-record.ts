import {isPlainObject} from '../config/types.js'
import {EXIT_ENVIRONMENT, MonocfError} from '../errors.js'
import type {StateWorker} from './manifest.js'

export const RUN_RECORD_SCHEMA_VERSION = 1

/** A run ID goes into a key of the state store, so it can't hold a path. */
export const VALID_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type RecordResult = 'cancelled' | 'failed' | 'ok' | 'refused' | 'skipped' | 'unchanged'

export interface RunRecordWorker {
  action: string
  /** Something on Cloudflare differs because of this run, whatever its result says. Rollback looks at this. */
  changed: boolean
  deployedName: string
  message?: string
  /** The version this run left live. Absent when it left none of its own. */
  newVersionId?: string
  /** The state entry before this run: its triggers, doHash and fingerprint, among others. Null when it had none. */
  previous: null | StateWorker
  /** What was live before this run. Absent for a worker this run created. */
  previousVersionId?: string
  /** The worker whose failure skipped this one. */
  reason?: string
  result: RecordResult
  /** A version this run uploaded and didn't promote. */
  uploadedVersionId?: string
}

export interface RunRecord {
  commit: string
  env: string
  finishedAt: string
  kind: 'apply' | 'rollback'
  runId: string
  schemaVersion: number
  startedAt: string
  workers: Record<string, RunRecordWorker>
}

function unusable(runId: string, message: string): MonocfError {
  return new MonocfError(`The record of run ${runId} ${message}`, EXIT_ENVIRONMENT)
}

/** Anything in it that can't be trusted stops a rollback, which would otherwise act on it. */
export function parseRunRecord(body: string, env: string, runId: string): RunRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw unusable(runId, `is not valid JSON: ${(error as Error).message}`)
  }

  if (!isPlainObject(parsed)) throw unusable(runId, 'is not an object.')
  if (typeof parsed.schemaVersion !== 'number' || parsed.schemaVersion < 1) throw unusable(runId, 'has no valid schemaVersion.')
  if (parsed.schemaVersion > RUN_RECORD_SCHEMA_VERSION) {
    throw unusable(runId, `has schemaVersion ${parsed.schemaVersion}, and this monocf reads up to ${RUN_RECORD_SCHEMA_VERSION}. Upgrade monocf.`)
  }

  if (parsed.env !== env) throw unusable(runId, `is for env ${String(parsed.env)}, not ${env}.`)
  if (!isPlainObject(parsed.workers)) throw unusable(runId, 'has no workers.')
  return parsed as unknown as RunRecord
}
