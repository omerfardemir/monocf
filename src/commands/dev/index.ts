import {BaseCommand} from '../../app/base-command.js'
import {runWorkerCommand, workerArgs, workerFlags} from '../../app/worker-command.js'

export default class Dev extends BaseCommand {
  static args = workerArgs
  static description = 'Run a worker locally with the workers it binds to, or every worker behind one proxy with --all'
  static examples = ['<%= config.bin %> dev orders', '<%= config.bin %> dev orders -e dev -p 9000', '<%= config.bin %> dev -a -p 8787']
  static flags = workerFlags

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Dev)
    await runWorkerCommand('dev', args.workerName, flags)
  }
}
