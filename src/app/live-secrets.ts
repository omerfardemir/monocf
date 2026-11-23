import {isPlainObject, type ResolvedWorker} from '../config/types.js'
import {MonocfError} from '../errors.js'
import {isSuccessful, readActiveVersion, readFailure, type ActiveInfo} from '../wrangler/read.js'
import {pause} from '../wrangler/retry.js'
import {STALE_READ_DELAYS_MS, workerCall} from './deployment.js'
import {accountOf, type RunContext} from './run.js'

export interface LiveSecrets {
  names: string[]
  versionId: string
}

/** During a gradual deployment, the version that takes most of the traffic is the one to judge. */
function liveVersionOf(active: ActiveInfo): string | undefined {
  if (active.state === 'missing') return undefined
  if (active.state === 'active') return active.versionId
  return [...active.shares].sort((a, b) => b.percentage - a.percentage)[0].versionId
}

/**
 * The secret names on the version that's live, or undefined for a worker that doesn't exist. `secret list` follows the latest
 * upload, so the live version has to be asked.
 */
export async function readLiveSecrets(context: RunContext, worker: ResolvedWorker, env: string | undefined): Promise<LiveSecrets | undefined> {
  const {deployedName, dir} = worker
  const accountId = accountOf(context, worker, env)
  const call = workerCall(context, dir)
  const versionId = liveVersionOf(await readActiveVersion(call, deployedName, accountId))
  if (versionId === undefined) return undefined
  const result = await call({action: 'version-view', name: deployedName, versionId}, accountId)
  if (!isSuccessful(result)) throw readFailure(deployedName, result)
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw readFailure(deployedName, {...result, code: 1, stderr: 'wrangler versions view printed something that is not JSON.'})
  }

  const resources = isPlainObject(parsed) ? parsed.resources : undefined
  const bindings = isPlainObject(resources) && Array.isArray(resources.bindings) ? resources.bindings : []
  const names = bindings
    .filter((binding): binding is {name: string; type: string} => isPlainObject(binding) && binding.type === 'secret_text' && typeof binding.name === 'string')
    .map(({name}) => name)
    .sort()
  return {names, versionId}
}

/**
 * `wrangler secret bulk` exits 0 on input it can't read, having uploaded nothing, so exit 0 isn't proof. Every upload makes a new
 * live version, even with the same values, so an upload counts once Cloudflare serves a version other than `before` that holds
 * every name. A read can be stale for a while after a write, as after a deploy. Returns the new version's ID.
 */
export async function confirmSecretsUpload(
  read: () => Promise<LiveSecrets | undefined>,
  {before, dir, names}: {before?: string; dir: string; names: string[]},
  {delaysMs = STALE_READ_DELAYS_MS, signal}: {delaysMs?: readonly number[]; signal?: AbortSignal} = {},
): Promise<string> {
  const confirmed = (live: LiveSecrets | undefined): boolean =>
    live !== undefined && live.versionId !== before && names.every((name) => live.names.includes(name))
  let live = await read()
  for (const delay of delaysMs) {
    if (confirmed(live) || signal?.aborted) break
    await pause(delay, signal)
    live = await read()
  }

  if (confirmed(live)) return live!.versionId
  const serves = live === undefined ? 'no version' : live.versionId === before ? `the version from before, ${before}` : `${live.versionId}, which lacks some of them`
  throw new MonocfError(`${dir}: wrangler secret bulk exited 0, but Cloudflare serves ${serves}, so the upload is unconfirmed.`, {
    code: 'upload-unconfirmed',
  })
}
