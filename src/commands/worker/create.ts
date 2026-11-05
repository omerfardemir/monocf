import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {createWorker} from '../../app/create.js'

export default class WorkerCreate extends BaseCommand {
  static args = {
    workerName: Args.string({description: 'Worker name', required: true}),
  }
  static description = 'Create a new worker in the workers directory'
  static examples = ['<%= config.bin %> worker create my-worker']
  static flags = {
    // The camelCase spellings were the only ones before 0.3.0, so they still work.
    'root-dir': Flags.string({aliases: ['rootDir'], char: 'r', description: 'Root directory of the project'}),
    'workers-dir-name': Flags.string({aliases: ['workersDirName'], char: 'w', description: 'Workers directory name in monorepo'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(WorkerCreate)
    createWorker(args.workerName, {rootDir: flags['root-dir'], workersDirName: flags['workers-dir-name']})
  }
}
