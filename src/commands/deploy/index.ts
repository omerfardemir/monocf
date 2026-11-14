import {BaseCommand, WRANGLER_EXIT_CODES} from '../../app/base-command.js'
import {deployFlags, runWorkerCommand, workerArgs} from '../../app/worker-command.js'

export default class Deploy extends BaseCommand {
  static args = workerArgs
  static description = 'Deploy workers straight away with wrangler deploy, with no plan and no state. For pipelines, use plan and apply'
  static examples = [
    '<%= config.bin %> deploy orders -e dev',
    '<%= config.bin %> deploy orders -e dev --deploy-bindings',
    '<%= config.bin %> deploy -a -e production',
  ]
  static flags = deployFlags
  static exitCodes = WRANGLER_EXIT_CODES
  static safety = 'writes-cloudflare' as const

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Deploy)
    await runWorkerCommand('deploy', args.workerName, flags)
  }
}
