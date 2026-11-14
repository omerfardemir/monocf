import {dirname} from 'node:path'

import {isPlainObject} from '../config/types.js'
import {MonocfError} from '../errors.js'
import type {ReportEvent} from '../report/events.js'
import {formatNdjson} from '../report/ndjson.js'
import {findConfigFile} from '../project/load.js'
import {Interrupts} from '../runtime/signals.js'
import {buildArgv} from '../wrangler/argv.js'
import {locateWrangler} from '../wrangler/locate.js'
import {spawnWrangler, type WranglerResult} from '../wrangler/process.js'
import {maskAccount} from '../wrangler/read.js'
import {failureOf, isSuccess} from './run.js'

function parseAnswer(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** wrangler's own answer, with account IDs masked as everywhere else in monocf's output, and without the token's permissions. */
function whoamiEvent(result: WranglerResult): ReportEvent {
  const answer = parseAnswer(result.stdout)
  if (answer?.loggedIn === false) {
    throw new MonocfError('wrangler is not logged in to Cloudflare.', {code: 'not-authenticated'})
  }

  if (!isSuccess(result)) throw failureOf('', 'whoami', result)
  if (answer === undefined) throw new MonocfError("wrangler whoami printed something that isn't JSON.", {code: 'wrangler-output-invalid'})
  const accounts = (Array.isArray(answer.accounts) ? answer.accounts : []).flatMap((account: unknown) =>
    isPlainObject(account) && typeof account.id === 'string' ? [{account: maskAccount(account.id), name: String(account.name ?? '')}] : [],
  )
  return {
    accounts,
    ...(typeof answer.authType === 'string' && {authType: answer.authType}),
    ...(typeof answer.email === 'string' && {email: answer.email}),
    type: 'whoami',
  }
}

/** Needs no project: wrangler is found from the project root when there is one, else from here. */
export async function runWhoami({json = false}: {json?: boolean} = {}, cwd: string = process.cwd()): Promise<void> {
  const configPath = findConfigFile(cwd)
  const wrangler = locateWrangler(configPath ? dirname(configPath) : cwd)
  const interrupts = new Interrupts()
  try {
    const running = spawnWrangler(wrangler, buildArgv({action: 'whoami', json}), {cwd, mode: json ? 'capture' : 'inherit'})
    interrupts.track(running.child)
    const result = await running.done
    interrupts.throwIfInterrupted()
    if (json) {
      process.stdout.write(formatNdjson(whoamiEvent(result)))
    } else if (!isSuccess(result)) {
      throw failureOf('', 'whoami', result)
    }
  } finally {
    interrupts.dispose()
  }
}
