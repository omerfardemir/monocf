import {Command} from '@oclif/core'

import {MonocfError} from '../errors.js'
import {SIGNAL_EXIT} from '../explain/registry.js'
import {markReported, wantsJson, writeErrorEvent} from '../report/error-event.js'

/** What a command can do to Cloudflare, so an agent knows before it runs one. */
export type Safety = 'offline' | 'reads-cloudflare' | 'writes-cloudflare'

/** Declared per command, as an exit code can mean more to one command than to another, such as 1 to `plan`. */
export type ExitCodes = Partial<Record<'0' | '1' | '2' | '3' | typeof SIGNAL_EXIT, string>>

export const EXIT_MEANINGS = {
  environment: 'Environment error: wrangler missing or too old, no credentials, or a state store that can not be used',
  ok: 'Everything requested succeeded',
  signal: 'Interrupted by SIGHUP, SIGINT or SIGTERM, or a wrangler process was killed by signal n',
  usage: 'Usage or config error. Nothing was attempted',
  workerFailed: 'One or more workers failed',
} as const

/** Every command that runs wrangler can end in each of these. A command whose 1 or 3 means more says so over this. */
export const WRANGLER_EXIT_CODES = {
  0: EXIT_MEANINGS.ok,
  1: EXIT_MEANINGS.workerFailed,
  2: EXIT_MEANINGS.usage,
  3: EXIT_MEANINGS.environment,
  [SIGNAL_EXIT]: EXIT_MEANINGS.signal,
} as const satisfies ExitCodes

export abstract class BaseCommand extends Command {
  /** Each command declares its own, as `monocf commands` reads them from the manifest, which holds a command's own statics only. */
  declare static exitCodes: ExitCodes
  declare static safety: Safety

  /**
   * One line per error, and a stack only with DEBUG. Under `--json`, every error is also an event on stdout, a parser error too.
   * oclif still prints a parser error on stderr, and exits 2 for it.
   */
  async catch(error: Error & {exitCode?: number}): Promise<void> {
    if (wantsJson(this.argv)) await writeErrorEvent(error, this.id?.replaceAll(':', ' '))

    if (!(error instanceof MonocfError)) {
      markReported(error)
      return super.catch(error)
    }

    reportOnStderr(error)
  }
}

export function reportOnStderr(error: MonocfError): void {
  process.stderr.write(`Error: ${error.message}\n`)
  if (process.env.DEBUG) process.stderr.write(`${error.stack}\n`)
  process.exitCode = error.exitCode
}
