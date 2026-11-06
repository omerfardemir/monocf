import {BaseCommand} from '../../app/base-command.js'
import {runWhoami} from '../../app/whoami.js'

export default class Whoami extends BaseCommand {
  static description = 'Show which account wrangler is logged in to'
  static examples = ['<%= config.bin %> whoami']

  async run(): Promise<void> {
    await this.parse(Whoami)
    await runWhoami()
  }
}
