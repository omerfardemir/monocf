import {BaseCommand, EXIT_MEANINGS} from '../../app/base-command.js'
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
  static exitCodes = {0: EXIT_MEANINGS.ok, 1: EXIT_MEANINGS.workerFailed, 2: EXIT_MEANINGS.usage, 3: EXIT_MEANINGS.environment, '128+n': EXIT_MEANINGS.signal}
  static safety = 'writes-cloudflare' as const

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Deploy)
    await runWorkerCommand('deploy', args.workerName, flags)
  }
}
