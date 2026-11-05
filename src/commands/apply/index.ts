import {Args, Flags} from '@oclif/core'

import {runApply} from '../../app/apply.js'
import {BaseCommand} from '../../app/base-command.js'
import {DEFAULT_CONCURRENCY} from '../../app/deployment.js'
import {projectFlags} from '../../app/flags.js'

export default class Apply extends BaseCommand {
  static args = {
    plan: Args.string({description: 'The plan file that monocf plan wrote', required: true}),
  }
  static description =
    'Run a plan: new workers first, then uploads, then promotes, callees first, with state written as it goes. Exits 2 when the plan is stale, and 1 when a worker failed'
  static examples = [
    '<%= config.bin %> apply plan.json',
    '<%= config.bin %> apply plan.json --expect-branch-tip origin/main --summary-file "$GITHUB_STEP_SUMMARY" --json',
  ]
  static flags = {
    ...projectFlags,
    concurrency: Flags.integer({description: `How many steps run at once. default: ${DEFAULT_CONCURRENCY}`, min: 1}),
    'expect-branch-tip': Flags.string({description: 'Refuse the plan unless this ref is at its commit, which stops a re-run deploying over something newer'}),
    json: Flags.boolean({description: 'Print results as NDJSON on stdout'}),
    'summary-file': Flags.string({description: 'Also add a summary in markdown to this file, such as $GITHUB_STEP_SUMMARY'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Apply)
    await runApply(args.plan, {
      baseConfig: flags['base-config'],
      concurrency: flags.concurrency,
      expectBranchTip: flags['expect-branch-tip'],
      json: flags.json,
      rootDir: flags['root-dir'],
      summaryFile: flags['summary-file'],
      workersDirName: flags['workers-dir-name'],
    })
  }
}
