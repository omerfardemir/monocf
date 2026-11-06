import {Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {runCheck} from '../../app/check.js'
import {projectFlags} from '../../app/flags.js'

export default class Check extends BaseCommand {
  static description = 'Check worker configs without running anything. Exits 2 on errors. Needs no credentials'
  static examples = [
    '<%= config.bin %> check -e dev',
    '<%= config.bin %> check --all-envs --json',
    '<%= config.bin %> check -e dev --strict',
  ]
  static flags = {
    ...projectFlags,
    'all-envs': Flags.boolean({description: 'Check every env that any config defines', exclusive: ['env']}),
    env: Flags.string({char: 'e', description: 'Environment to use (dev, production etc.)'}),
    json: Flags.boolean({description: 'Print findings as JSON'}),
    strict: Flags.boolean({description: 'Warnings fail the check too'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Check)
    runCheck({
      allEnvs: flags['all-envs'],
      baseConfig: flags['base-config'],
      env: flags.env,
      json: flags.json,
      rootDir: flags['root-dir'],
      strict: flags.strict,
      workersDirName: flags['workers-dir-name'],
    })
  }
}
