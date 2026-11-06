import {Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {runBundle} from '../../app/bundle.js'
import {projectFlags} from '../../app/flags.js'

export default class Bundle extends BaseCommand {
  static description =
    'Build workers without uploading, and write a manifest of fingerprints. Needs no credentials. Pass worker names, or none for all'
  static examples = [
    '<%= config.bin %> bundle -e dev',
    '<%= config.bin %> bundle orders billing -e dev --out build',
    '<%= config.bin %> bundle -e dev --concurrency 4 --json',
  ]
  static flags = {
    ...projectFlags,
    concurrency: Flags.integer({description: 'How many workers build at once. default: the CPU count up to 8', min: 1}),
    env: Flags.string({char: 'e', description: 'Environment to use (dev, production etc.)', required: true}),
    json: Flags.boolean({description: 'Print results as NDJSON on stdout'}),
    out: Flags.string({description: 'Output directory. default: .monocf/bundle/<env>'}),
  }
  static strict = false

  async run(): Promise<void> {
    const {argv, flags} = await this.parse(Bundle)
    await runBundle(argv as string[], {
      baseConfig: flags['base-config'],
      concurrency: flags.concurrency,
      env: flags.env,
      json: flags.json,
      out: flags.out,
      rootDir: flags['root-dir'],
      workersDirName: flags['workers-dir-name'],
    })
  }
}
