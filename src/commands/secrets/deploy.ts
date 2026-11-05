import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {runSecretsDeploy} from '../../app/secrets.js'

export default class SecretsDeploy extends BaseCommand {
  static args = {
    workerName: Args.string({description: 'Worker name', required: false}),
  }
  static description = 'Upload secrets from the exact .dev.vars files for the env, to a worker that already exists'
  static examples = ['<%= config.bin %> secrets deploy orders -e production', '<%= config.bin %> secrets deploy -a -e production']
  static flags = {
    all: Flags.boolean({char: 'a', default: false, description: 'Run command for all workers'}),
    'base-config': Flags.string({char: 'b', description: 'Base wrangler config file'}),
    create: Flags.boolean({description: 'Create the worker if it does not exist yet'}),
    env: Flags.string({char: 'e', description: 'Environment to use (dev, production etc.)'}),
    json: Flags.boolean({description: 'Print results as NDJSON on stdout'}),
    'root-dir': Flags.string({char: 'r', description: 'Root directory of the project'}),
    'workers-dir-name': Flags.string({char: 'w', description: 'Workers directory name in monorepo'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(SecretsDeploy)
    await runSecretsDeploy(args.workerName, {
      all: flags.all,
      baseConfig: flags['base-config'],
      create: flags.create,
      env: flags.env,
      json: flags.json,
      rootDir: flags['root-dir'],
      workersDirName: flags['workers-dir-name'],
    })
  }
}
