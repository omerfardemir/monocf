import {BaseCommand, EXIT_MEANINGS} from '../../app/base-command.js'
import {devFlags, runWorkerCommand, workerArgs} from '../../app/worker-command.js'

export default class Dev extends BaseCommand {
  static args = workerArgs
  static description = 'Run a worker locally with the workers it binds to, or every worker behind one proxy with --all'
  static examples = ['<%= config.bin %> dev orders', '<%= config.bin %> dev orders -e dev -p 9000', '<%= config.bin %> dev -a -p 8787']
  static flags = devFlags
  static exitCodes = {0: EXIT_MEANINGS.ok, 1: EXIT_MEANINGS.workerFailed, 2: EXIT_MEANINGS.usage, 3: EXIT_MEANINGS.environment, '128+n': EXIT_MEANINGS.signal}
  static safety = 'offline' as const

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Dev)
    await runWorkerCommand('dev', args.workerName, flags)
  }
}
