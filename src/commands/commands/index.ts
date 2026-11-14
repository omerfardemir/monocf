import {Flags} from '@oclif/core'

import {BaseCommand, EXIT_MEANINGS} from '../../app/base-command.js'
import {runCommands} from '../../app/discovery.js'

export default class Commands extends BaseCommand {
  static description =
    'List every command, with whether it is offline, reads Cloudflare or writes to it. With --json, also its flags, required flags and exit codes'
  static examples = ['<%= config.bin %> commands', '<%= config.bin %> commands --json']
  static exitCodes = {0: EXIT_MEANINGS.ok, 2: EXIT_MEANINGS.usage}
  static flags = {
    json: Flags.boolean({description: 'Print the commands as one JSON document'}),
  }
  static safety = 'offline' as const

  async run(): Promise<void> {
    const {flags} = await this.parse(Commands)
    runCommands(this.config.commands, this.config.bin, {json: flags.json})
  }
}
