import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {projectFlags} from '../../app/flags.js'
import {runWorker, type WorkerAction} from '../../app/worker.js'

const workerCommand = Flags.custom<WorkerAction>({
  char: 'c',
  description: 'Command to execute',
  options: ['build', 'deploy', 'dev', 'preview'],
  required: true,
})

export default class Worker extends BaseCommand {
  static args = {
    workerName: Args.string({description: 'Worker name', required: false}),
  }
  static description = 'Workers command for running dev or deploy for a worker or all workers'
  static examples = [
    '<%= config.bin %> worker my-worker -c dev',
    '<%= config.bin %> worker my-worker -c deploy -e dev',
    '<%= config.bin %> worker -c deploy -a -e production',
  ]
  static flags = {
    ...projectFlags,
    all: Flags.boolean({char: 'a', default: false, description: 'Run command for all workers'}),
    command: workerCommand(),
    concurrency: Flags.integer({
      description: 'How many workers run at once. default: the CPU count up to 8 for build, 1 for deploy and preview',
      min: 1,
    }),
    'deploy-bindings': Flags.boolean({
      allowNo: true,
      char: 'd',
      description: 'Deploy service bindings for the worker before deploy main worker',
    }),
    'deploy-from-version-id': Flags.string({
      char: 'F',
      description: 'Version ID to deploy instead of the latest uploaded version. Requires --from-version',
    }),
    'deploy-secrets': Flags.boolean({allowNo: true, char: 's', description: 'Deploy secrets for the worker'}),
    env: Flags.string({char: 'e', description: 'Environment to use (dev, production etc.)'}),
    'from-version': Flags.boolean({char: 'f', description: 'Deploy from an existing version or latest uploaded version'}),
    json: Flags.boolean({description: 'Print results as NDJSON on stdout'}),
    message: Flags.string({char: 'M', description: 'Message for the version: on deploy, preview or --from-version'}),
    minify: Flags.boolean({allowNo: true, char: 'm', description: 'Minify the worker script during build/deploy'}),
    port: Flags.integer({
      char: 'p',
      description: 'Port for dev: of the worker, or of the proxy with --all. default for the proxy: 8787',
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Worker)
    await runWorker(args.workerName, {
      all: flags.all,
      baseConfig: flags['base-config'],
      command: flags.command,
      concurrency: flags.concurrency,
      deployBindings: flags['deploy-bindings'],
      deployFromVersionId: flags['deploy-from-version-id'],
      deploySecrets: flags['deploy-secrets'],
      env: flags.env,
      fromVersion: flags['from-version'],
      json: flags.json,
      message: flags.message,
      minify: flags.minify,
      port: flags.port,
      rootDir: flags['root-dir'],
      workersDirName: flags['workers-dir-name'],
    })
  }
}
