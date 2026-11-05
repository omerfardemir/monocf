import {BaseCommand} from '../../app/base-command.js'
import {previewFlags, runWorkerCommand, workerArgs} from '../../app/worker-command.js'

export default class Preview extends BaseCommand {
  static args = workerArgs
  static description = 'Upload a new version of workers with wrangler versions upload, without sending it traffic'
  static examples = ['<%= config.bin %> preview orders -e dev', '<%= config.bin %> preview orders -e dev -M "try the new route"']
  static flags = previewFlags

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Preview)
    await runWorkerCommand('preview', args.workerName, flags)
  }
}
