import {BaseCommand} from '../../app/base-command.js'
import {runWhoami} from '../../app/whoami.js'

export default class Whoami extends BaseCommand {
  static description = 'Show whoami from wrangler'
  static examples = ['<%= config.bin %> whoami']

  async run(): Promise<void> {
    await runWhoami()
  }
}
