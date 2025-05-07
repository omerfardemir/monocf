import {Args, Flags} from '@oclif/core'

import {VerifiedFields, CreateWorkerArgs, CreateWorkerFlags} from '../../flags/index.js'
import {CommandBase} from '../../types/oclif-types.js'
import {CommandRegistry} from '../../core/commands/registry.js'

/**
 * Worker create command args & flags
 */
const args = {
  workerName: Args.string({
    description: 'Worker name',
    required: true,
  }),
}

const flags = {
  rootDir: Flags.string({
    char: 'r',
    description: 'Root directory of the project',
    required: false,
  }),
  workersDirName: Flags.string({
    char: 'w',
    description: 'Workers directory name in monorepo',
    required: false,
  }),
}

/**
 * Command to create a new worker
 */
export default class WorkerCreate extends CommandBase {
  static description = 'Create a new worker in the workers directory'
  static examples = ['<%= config.bin %> worker create my-worker']
  static args: VerifiedFields<CreateWorkerArgs, typeof args> = args
  static flags: VerifiedFields<CreateWorkerFlags, typeof flags> = flags

  /**
   * Run the worker create command
   */
  async run(): Promise<void> {
    // Parse command line arguments
    const {args, flags} = await this.parse(WorkerCreate)

    // Execute command
    await CommandRegistry.executeCommand<CreateWorkerArgs, CreateWorkerFlags>('worker:create', this, args, flags)
  }
}
