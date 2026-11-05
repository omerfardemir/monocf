import {stripVTControlCharacters} from 'node:util'

import {isPlainObject} from '../config/types.js'
import {EXIT_ENVIRONMENT, EXIT_FAILED, MonocfError} from '../errors.js'
import {signalExitCode} from '../runtime/signals.js'
import type {Step} from './argv.js'
import type {WranglerResult} from './process.js'

/** One wrangler process that answers something. The account is set per call, for a worker with its own `account_id`. */
export type WranglerCall = (step: Step, accountId?: string) => Promise<WranglerResult>

export interface ActiveShare {
  percentage: number
  versionId: string
}

/** What Cloudflare serves for a worker. `tag` is only there when it was worth a request. */
export type ActiveInfo =
  | {state: 'active'; tag?: string; triggeredBy?: string; versionId: string}
  | {state: 'missing'}
  | {shares: ActiveShare[]; state: 'split'}

export function isSuccessful({code, signal}: WranglerResult): boolean {
  return code === 0 && signal === null
}

const NO_CREDENTIALS = /CLOUDFLARE_API_TOKEN|not authenticated|authentication error|invalid access token|more than one account|code: (?:6003|6111|9106|9109|10000)\b/i
const TOO_MANY_FAILURES = /code: 10502\b|too many authentication failures/i
const ACCOUNT_ID = /\b[0-9a-f]{32}\b/gi

export function scrubAccountIds(text: string): string {
  return text.replaceAll(ACCOUNT_ID, '<account>')
}

/** The lines worth quoting from wrangler's stderr. API errors quote a URL holding the account ID, which stays out of logs. */
function errorDetail(stderr: string): string {
  const lines = stripVTControlCharacters(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const errors = lines.filter((line) => line.includes('[ERROR]') || /code: \d+/.test(line))
  return scrubAccountIds((errors.length > 0 ? errors : lines.slice(-1)).join(' '))
}

/** A read that failed. No credentials is an environment error, so CI can tell it from a Cloudflare problem. */
export function readFailure(label: string, result: WranglerResult): MonocfError {
  if (result.signal) return new MonocfError(`${label}: wrangler was killed by ${result.signal}.`, signalExitCode(result.signal))
  if (TOO_MANY_FAILURES.test(result.stderr)) {
    const wait = `${label}: Cloudflare reports too many authentication failures (10502). Check the token, and wait for this to clear before trying again.`
    return new MonocfError(wait, EXIT_ENVIRONMENT)
  }

  const detail = errorDetail(result.stderr)
  const message = `${label}: wrangler failed with exit code ${result.code}${detail ? `: ${detail}` : '.'}`
  return new MonocfError(message, NO_CREDENTIALS.test(result.stderr) ? EXIT_ENVIRONMENT : EXIT_FAILED)
}

function parseJson(label: string, stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new MonocfError(`${label}: wrangler printed something that isn't JSON.`, EXIT_FAILED)
  }
}

function compareShares(a: ActiveShare, b: ActiveShare): number {
  return b.percentage - a.percentage || (a.versionId < b.versionId ? -1 : Number(a.versionId > b.versionId))
}

/** Reads `deployments status --json`. More than one version with traffic is a split rollout. */
export function parseDeploymentStatus(label: string, stdout: string): ActiveInfo {
  const parsed = parseJson(label, stdout)
  const versions = isPlainObject(parsed) && Array.isArray(parsed.versions) ? parsed.versions : []
  const shares = versions
    .filter((entry): entry is {percentage?: unknown; version_id: string} => isPlainObject(entry) && typeof entry.version_id === 'string')
    .map(({percentage, version_id: versionId}) => ({percentage: typeof percentage === 'number' ? percentage : 100, versionId}))
    .filter(({percentage}) => percentage > 0)
    .sort(compareShares)
  if (shares.length === 0) throw new MonocfError(`${label}: Cloudflare reports no active version.`, EXIT_FAILED)
  return shares.length === 1 ? {state: 'active', versionId: shares[0].versionId} : {shares, state: 'split'}
}

/** Reads `versions view --json`. A version uploaded with no tag has none. */
export function parseVersionTag(label: string, stdout: string): string | undefined {
  const parsed = parseJson(label, stdout)
  const annotations = isPlainObject(parsed) ? parsed.annotations : undefined
  const tag = isPlainObject(annotations) ? annotations['workers/tag'] : undefined
  return typeof tag === 'string' ? tag : undefined
}

/** Reads who made a version. `secret` for what `secret put` and `secret bulk` make, as seen on real Cloudflare. */
export function parseTriggeredBy(label: string, stdout: string): string | undefined {
  const parsed = parseJson(label, stdout)
  const annotations = isPlainObject(parsed) ? parsed.annotations : undefined
  const triggeredBy = isPlainObject(annotations) ? annotations['workers/triggered_by'] : undefined
  return typeof triggeredBy === 'string' ? triggeredBy : undefined
}

const WORKER_NOT_FOUND = /code: 10007\b/

/**
 * Reads the active version of a worker by its deployed name. Only an explicit "doesn't exist" counts as missing: every other
 * failure is an error, or a passing outage would plan a redeploy.
 */
export async function readActiveVersion(call: WranglerCall, name: string, accountId?: string): Promise<ActiveInfo> {
  const result = await call({action: 'active-version', name}, accountId)
  if (isSuccessful(result)) return parseDeploymentStatus(name, result.stdout)
  if (!result.signal && WORKER_NOT_FOUND.test(result.stderr)) return {state: 'missing'}
  throw readFailure(name, result)
}

export async function readVersionOrigin(
  call: WranglerCall,
  name: string,
  versionId: string,
  accountId?: string,
): Promise<{tag?: string; triggeredBy?: string}> {
  const result = await call({action: 'version-view', name, versionId}, accountId)
  if (!isSuccessful(result)) throw readFailure(name, result)
  const tag = parseVersionTag(name, result.stdout)
  const triggeredBy = parseTriggeredBy(name, result.stdout)
  return {...(tag !== undefined && {tag}), ...(triggeredBy !== undefined && {triggeredBy})}
}

export async function readVersionTag(
  call: WranglerCall,
  name: string,
  versionId: string,
  accountId?: string,
): Promise<string | undefined> {
  return (await readVersionOrigin(call, name, versionId, accountId)).tag
}
