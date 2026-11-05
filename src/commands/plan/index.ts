import {Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {projectFlags} from '../../app/flags.js'
import {runPlan} from '../../app/plan.js'

export default class Plan extends BaseCommand {
  static description =
    'Compare this commit with what is live on Cloudflare, and write what needs deploying to a plan file. Deploys nothing. Exits 1 when drift blocks a worker'
  static examples = [
    '<%= config.bin %> plan -e staging --state r2://my-state-bucket/monocf',
    '<%= config.bin %> plan -e staging --state file:state --out plan.json --markdown plan.md',
    '<%= config.bin %> plan -e production --state r2://my-state-bucket/monocf --on-drift fail --json',
  ]
  static flags = {
    ...projectFlags,
    'bundle-dir': Flags.string({
      description: 'Use the manifest of an earlier monocf bundle, if it matches this env and commit. default: bundle now',
    }),
    env: Flags.string({char: 'e', description: 'Environment to use (dev, production etc.)', required: true}),
    'first-run': Flags.boolean({description: 'Accept that no state exists and no worker is live: the first run for this env'}),
    json: Flags.boolean({description: 'Print results as NDJSON on stdout, ending in a plan event'}),
    markdown: Flags.string({description: 'Also write a summary for a pull request comment to this file'}),
    'on-drift': Flags.string({
      default: 'warn',
      description: 'warn deploys over what else is live; fail blocks that worker and exits 1',
      options: ['warn', 'fail'],
    }),
    out: Flags.string({description: 'Where to write the plan. default: .monocf/plan/<env>.json'}),
    state: Flags.string({description: 'Where deployed state lives: file:<dir> or r2://<bucket>/<prefix>', required: true}),
    workers: Flags.string({description: 'Plan only these workers, as a comma-separated list. default: all'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Plan)
    await runPlan({
      baseConfig: flags['base-config'],
      bundleDir: flags['bundle-dir'],
      env: flags.env,
      json: flags.json,
      markdown: flags.markdown,
      onDrift: flags['on-drift'] as 'fail' | 'warn',
      out: flags.out,
      rootDir: flags['root-dir'],
      state: flags.state,
      workers: flags.workers,
      workersDirName: flags['workers-dir-name'],
    })
  }
}
