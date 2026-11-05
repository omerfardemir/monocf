import {Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {projectFlags} from '../../app/flags.js'
import {runSecretsCheck} from '../../app/secrets-check.js'

export default class SecretsCheck extends BaseCommand {
  static description =
    'Say which secret names the active version of each worker is missing, from secrets.required and .dev.vars.example. Names only, never values. Exits 1 when one is missing'
  static examples = ['<%= config.bin %> secrets check -e production']
  static flags = {
    ...projectFlags,
    env: Flags.string({char: 'e', description: 'Environment to use (dev, production etc.)', required: true}),
    json: Flags.boolean({description: 'Print results as NDJSON on stdout'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SecretsCheck)
    await runSecretsCheck({
      baseConfig: flags['base-config'],
      env: flags.env,
      json: flags.json,
      rootDir: flags['root-dir'],
      workersDirName: flags['workers-dir-name'],
    })
  }
}
