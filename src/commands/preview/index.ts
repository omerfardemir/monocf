import {BaseCommand, EXIT_MEANINGS} from '../../app/base-command.js'
import {previewFlags, runWorkerCommand, workerArgs} from '../../app/worker-command.js'

export default class Preview extends BaseCommand {
  static args = workerArgs
  static description = 'Upload a new version of workers with wrangler versions upload, without sending it traffic'
  static examples = ['<%= config.bin %> preview orders -e dev', '<%= config.bin %> preview orders -e dev -M "try the new route"']
  static flags = previewFlags
  static exitCodes = {0: EXIT_MEANINGS.ok, 1: EXIT_MEANINGS.workerFailed, 2: EXIT_MEANINGS.usage, 3: EXIT_MEANINGS.environment, '128+n': EXIT_MEANINGS.signal}
  static safety = 'writes-cloudflare' as const

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Preview)
    await runWorkerCommand('preview', args.workerName, flags)
  }
}
