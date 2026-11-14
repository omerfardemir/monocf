import {Flags} from '@oclif/core'

import {BaseCommand, EXIT_MEANINGS} from '../../app/base-command.js'
import {runWhoami} from '../../app/whoami.js'

export default class Whoami extends BaseCommand {
  static description = 'Show which account wrangler is logged in to'
  static examples = ['<%= config.bin %> whoami', '<%= config.bin %> whoami --json']
  static exitCodes = {0: EXIT_MEANINGS.ok, 1: 'wrangler whoami failed', 2: EXIT_MEANINGS.usage, 3: `${EXIT_MEANINGS.environment}. With --json, also not logged in`}
  static flags = {
    json: Flags.boolean({description: 'Print the account as NDJSON on stdout, with account IDs masked'}),
  }
  static safety = 'reads-cloudflare' as const

  async run(): Promise<void> {
    const {flags} = await this.parse(Whoami)
    await runWhoami({json: flags.json})
  }
}
