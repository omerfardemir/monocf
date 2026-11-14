import {Args, Flags} from '@oclif/core'

import {BaseCommand, EXIT_MEANINGS} from '../../app/base-command.js'
import {runExplain} from '../../app/explain.js'

export default class Explain extends BaseCommand {
  static args = {
    code: Args.string({description: 'An error code, a check rule or a plan reason. default: list them all', required: false}),
  }
  static description = 'Say what an error code, a check rule or a plan reason means, and what to do next'
  static examples = [
    '<%= config.bin %> explain state-scheme-unsupported',
    '<%= config.bin %> explain provider-recreated --json',
    '<%= config.bin %> explain --json',
  ]
  static exitCodes = {0: EXIT_MEANINGS.ok, 2: 'The code is unknown, or a usage error'}
  static flags = {
    json: Flags.boolean({description: 'Print the explanation as one JSON document'}),
  }
  static safety = 'offline' as const

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Explain)
    runExplain(args.code, {json: flags.json})
  }
}
