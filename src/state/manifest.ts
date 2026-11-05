import {createHash} from 'node:crypto'

import {isPlainObject} from '../config/types.js'
import {EXIT_ENVIRONMENT, MonocfError} from '../errors.js'
import type {Triggers} from '../fingerprint/fingerprint.js'

export const STATE_SCHEMA_VERSION = 1

/** What was last deployed for a worker, by a run that saw it through. */
export interface StateWorker {
  /** A hash of the account that last deployed it, which keeps the ID itself out of state. */
  accountHash?: string
  bundleHash: string
  commit: string
  configHash: string
  deployedAt: string
  deployedName: string
  doHash: string
  externalHash: string
  fingerprint: string
  triggers: Triggers
  triggersHash: string
  version?: string
  versionId: string
}

export interface StateManifest {
  env: string
  /** Callers of a recreated provider. They stay broken until they get a new version, whatever else is true of them. */
  needsNewVersion?: string[]
  schemaVersion: number
  updatedAt: string
  workers: Record<string, StateWorker>
}

export function accountHash(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex')
}

export function manifestKey(env: string): string {
  return `${env}/manifest.json`
}

export function runKey(env: string, runId: string): string {
  return `${env}/runs/${runId}.json`
}

const REQUIRED_TEXT = [
  'bundleHash',
  'commit',
  'configHash',
  'deployedAt',
  'deployedName',
  'doHash',
  'externalHash',
  'fingerprint',
  'triggersHash',
  'versionId',
] as const

function unusable(message: string): MonocfError {
  return new MonocfError(`The state manifest ${message}`, EXIT_ENVIRONMENT)
}

function assertWorker(name: string, entry: unknown): void {
  if (!isPlainObject(entry)) throw unusable(`has an entry for ${name} that isn't an object.`)
  const missing = REQUIRED_TEXT.find((field) => typeof entry[field] !== 'string')
  if (missing !== undefined) throw unusable(`has no ${missing} for ${name}.`)
  if (!isPlainObject(entry.triggers)) throw unusable(`has no triggers for ${name}.`)
  if (entry.versionId === '') throw unusable(`has an empty versionId for ${name}.`)
}

/**
 * Reads a stored manifest. Anything that can't be trusted stops the run instead of counting as empty, because empty state
 * plans a redeploy of everything.
 */
export function parseStateManifest(body: string, env: string): StateManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw unusable(`is not valid JSON: ${(error as Error).message}`)
  }

  if (!isPlainObject(parsed)) throw unusable('is not an object.')
  const {schemaVersion, workers} = parsed
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) throw unusable('has no valid schemaVersion.')
  if (schemaVersion > STATE_SCHEMA_VERSION) {
    throw unusable(`has schemaVersion ${schemaVersion}, and this monocf reads up to ${STATE_SCHEMA_VERSION}. Upgrade monocf.`)
  }

  if (parsed.env !== env) throw unusable(`is for env ${String(parsed.env)}, not ${env}.`)
  if (!isPlainObject(workers)) throw unusable('has no workers.')
  const {needsNewVersion} = parsed
  if (needsNewVersion !== undefined && !(Array.isArray(needsNewVersion) && needsNewVersion.every((name) => typeof name === 'string'))) {
    throw unusable('has a needsNewVersion that is not a list of names.')
  }

  for (const [name, entry] of Object.entries(workers)) assertWorker(name, entry)
  return parsed as unknown as StateManifest
}
