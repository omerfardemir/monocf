import {BaseCommand, WRANGLER_EXIT_CODES} from '../../app/base-command.js'
import {buildFlags, runWorkerCommand, workerArgs} from '../../app/worker-command.js'

export default class Build extends BaseCommand {
  static args = workerArgs
  static description = "Build workers into each worker's dist directory, without uploading"
  static examples = ['<%= config.bin %> build orders -e dev', '<%= config.bin %> build -a -e dev --concurrency 4']
  static flags = buildFlags
  static exitCodes = WRANGLER_EXIT_CODES
  static safety = 'offline' as const

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Build)
    await runWorkerCommand('build', args.workerName, flags)
  }
}
