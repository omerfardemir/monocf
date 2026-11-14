import {Args, Flags} from '@oclif/core'

import {BaseCommand, EXIT_MEANINGS} from '../../app/base-command.js'
import {createWorker} from '../../app/create.js'

export default class WorkerCreate extends BaseCommand {
  static args = {
    workerName: Args.string({description: 'Worker name', required: true}),
  }
  static description = 'Create a new worker in the workers directory. Needs no credentials'
  static examples = ['<%= config.bin %> worker create my-worker', '<%= config.bin %> worker create my-worker --json']
  static exitCodes = {0: EXIT_MEANINGS.ok, 2: EXIT_MEANINGS.usage}
  static flags = {
    json: Flags.boolean({description: 'Print the result as NDJSON on stdout'}),
    // The camelCase spellings were the only ones before 0.3.0, so they still work.
    'root-dir': Flags.string({aliases: ['rootDir'], char: 'r', description: 'Root directory of the project'}),
    'workers-dir-name': Flags.string({aliases: ['workersDirName'], char: 'w', description: 'Workers directory name in monorepo'}),
  }
  static safety = 'offline' as const

  async run(): Promise<void> {
    const {args, flags} = await this.parse(WorkerCreate)
    createWorker(args.workerName, {json: flags.json, rootDir: flags['root-dir'], workersDirName: flags['workers-dir-name']})
  }
}
