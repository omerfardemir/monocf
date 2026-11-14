import {Command} from '@oclif/core'

import {MonocfError} from '../errors.js'
import {markReported, toErrorEvent, wantsJson} from '../report/error-event.js'
import {formatNdjson} from '../report/ndjson.js'

/** What a command can do to Cloudflare, so an agent knows before it runs one. */
export type Safety = 'offline' | 'reads-cloudflare' | 'writes-cloudflare'

/** Exit codes and what they mean for one command. `128+n` is a signal. */
export type ExitCodes = Partial<Record<'0' | '1' | '2' | '3' | '128+n', string>>

export const EXIT_MEANINGS = {
  environment: 'Environment error: wrangler missing or too old, no credentials, or a state store that can not be used',
  ok: 'Everything requested succeeded',
  signal: 'Interrupted by SIGHUP, SIGINT or SIGTERM, or a wrangler process was killed by signal n',
  usage: 'Usage or config error. Nothing was attempted',
  workerFailed: 'One or more workers failed',
} as const

export abstract class BaseCommand extends Command {
  /** Each command declares its own, as `monocf commands` reads them from the manifest, which holds a command's own statics only. */
  declare static exitCodes: ExitCodes
  declare static safety: Safety

  /**
   * One line per error, and a stack only with DEBUG. Under `--json`, every error is also an event on stdout, a parser error too.
   * oclif still prints a parser error on stderr, and exits 2 for it.
   */
  async catch(error: Error & {exitCode?: number}): Promise<void> {
    if (wantsJson(this.argv)) {
      const line = formatNdjson(toErrorEvent(error, this.id?.replaceAll(':', ' ')))
      // oclif exits as soon as it has printed a parser error, which can cut off a write to a pipe.
      await new Promise<void>((resolve) => {
        process.stdout.write(line, () => resolve())
      })
    }

    if (!(error instanceof MonocfError)) {
      markReported(error)
      return super.catch(error)
    }

    process.stderr.write(`Error: ${error.message}\n`)
    if (process.env.DEBUG) process.stderr.write(`${error.stack}\n`)
    process.exitCode = error.exitCode
  }
}
