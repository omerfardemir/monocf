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
    rootDir: Flags.string({char: 'r', description: 'Root directory of the project'}),
    workersDirName: Flags.string({char: 'w', description: 'Workers directory name in monorepo'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(WorkerCreate)
    createWorker(args.workerName, {rootDir: flags.rootDir, workersDirName: flags.workersDirName})
  }
}
