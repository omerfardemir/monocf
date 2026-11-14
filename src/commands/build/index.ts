import {BaseCommand, EXIT_MEANINGS} from '../../app/base-command.js'
import {buildFlags, runWorkerCommand, workerArgs} from '../../app/worker-command.js'

export default class Build extends BaseCommand {
  static args = workerArgs
  static description = "Build workers into each worker's dist directory, without uploading"
  static examples = ['<%= config.bin %> build orders -e dev', '<%= config.bin %> build -a -e dev --concurrency 4']
  static flags = buildFlags
  static exitCodes = {0: EXIT_MEANINGS.ok, 1: EXIT_MEANINGS.workerFailed, 2: EXIT_MEANINGS.usage, 3: EXIT_MEANINGS.environment, '128+n': EXIT_MEANINGS.signal}
  static safety = 'offline' as const

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Build)
    await runWorkerCommand('build', args.workerName, flags)
  }
}
