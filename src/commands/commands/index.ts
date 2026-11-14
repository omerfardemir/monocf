import {Flags} from '@oclif/core'

import {BaseCommand, EXIT_MEANINGS} from '../../app/base-command.js'
import {describeCommands, formatCommands} from '../../app/discovery.js'

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
    const described = describeCommands(this.config.commands, this.config.bin)
    process.stdout.write(flags.json ? `${JSON.stringify(described, null, 2)}\n` : formatCommands(described))
  }
}
