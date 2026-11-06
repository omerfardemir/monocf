import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {projectFlags} from '../../app/flags.js'
import {runRollback} from '../../app/rollback.js'

export default class Rollback extends BaseCommand {
  static args = {
    workerName: Args.string({description: 'The one worker to roll back, with --to', required: false}),
  }
  static description =
    'Put back the versions a run replaced, callers first, or one worker to a given version. Refuses to cross a Durable Object change unless forced'
  static examples = [
    '<%= config.bin %> rollback -e production --state r2://my-state-bucket/monocf --to-run 20260101T000000Z-abc123 --dry-run',
    '<%= config.bin %> rollback orders -e production --state r2://my-state-bucket/monocf --to 1a2b3c4d --force',
  ]
  static flags = {
    ...projectFlags,
    'dry-run': Flags.boolean({description: 'Say what would happen, and change nothing'}),
    env: Flags.string({char: 'e', description: 'Environment to use (dev, production etc.)', required: true}),
    force: Flags.boolean({description: "Accept a Durable Object change, or one that can't be checked"}),
    json: Flags.boolean({description: 'Print results as NDJSON on stdout'}),
    state: Flags.string({description: 'Where deployed state lives: file:<dir> or r2://<bucket>/<prefix>', required: true}),
    to: Flags.string({description: 'The version to put back, for one named worker'}),
    'to-run': Flags.string({description: 'The run whose changes to undo'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Rollback)
    await runRollback(args.workerName, {
      baseConfig: flags['base-config'],
      dryRun: flags['dry-run'],
      env: flags.env,
      force: flags.force,
      json: flags.json,
      rootDir: flags['root-dir'],
      state: flags.state,
      to: flags.to,
      toRun: flags['to-run'],
      workersDirName: flags['workers-dir-name'],
    })
  }
}
