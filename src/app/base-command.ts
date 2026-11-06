import {Command} from '@oclif/core'

import {MonocfError} from '../errors.js'
import {formatNdjson} from '../report/ndjson.js'

export abstract class BaseCommand extends Command {
  /** One line per error, and a stack only with DEBUG. Parser errors stay with oclif, which also exits 2 for them. */
  async catch(error: Error & {exitCode?: number}): Promise<void> {
    if (!(error instanceof MonocfError)) {
      return super.catch(error)
    }

    process.stderr.write(`Error: ${error.message}\n`)
    if (process.env.DEBUG) process.stderr.write(`${error.stack}\n`)
    if (this.argv.includes('--json')) {
      process.stdout.write(formatNdjson({exitCode: error.exitCode, message: error.message, type: 'error'}))
    }

    process.exitCode = error.exitCode
  }
}
