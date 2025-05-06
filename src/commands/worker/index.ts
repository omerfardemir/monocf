import { Args, Flags } from '@oclif/core';

import { CommandBase, WorkerCommand } from '../../types/index.js';
import { VerifiedFields, WorkerFlags, WorkerArgs } from '../../flags/index.js';
import { CommandRegistry } from '../../core/commands/registry.js';

/**
 * Worker command flags & args
 */

const workerCommand = Flags.custom<WorkerCommand>({
  char: 'c',
  description: 'Command to execute (dev or deploy)',
  required: true,
});

const workerFlags = {
  all: Flags.boolean({
    char: 'a',
    default: false,
    description: 'Run command for all workers',
    required: false
  }),
  baseConfig: Flags.string({
    char: 'b',
    description: 'Base wrangler config file',
    required: false
  }),
  command: workerCommand({
    char: 'c',
    description: 'Command to execute (dev or deploy)',
    required: true,
  }),
  deploySecrets: Flags.boolean({
    char: 's',
    description: 'Deploy secrets for the worker',
    required: false
  }),
  env: Flags.string({
    char: 'e',
    description: 'Environment to use (dev, production etc.)',
    required: false
  }),
  rootDir: Flags.string({
    char: 'r',
    description: 'Root directory of the project',
    required: false
  }),
  workersDirName: Flags.string({
    char: 'w',
    description: 'Workers directory name in monorepo',
    required: false
  })
};

const workerArgs = {
  workerName: Args.string({
    description: 'Worker name',
    required: false,
  })
}

/**
 * Workers command for running dev or deploy for a worker or all workers
 */
export default class Worker extends CommandBase {
  static description = 'Workers command for running dev or deploy for a worker or all workers'
  static examples = [
    '<%= config.bin %> worker my-worker -c dev',
    '<%= config.bin %> worker my-worker -c deploy -e dev',
    '<%= config.bin %> worker -c deploy -a -e production',
  ]
  static args: VerifiedFields<WorkerArgs, typeof workerArgs> = workerArgs;
  static flags: VerifiedFields<WorkerFlags, typeof workerFlags> = workerFlags;
  
  /**
   * Run the worker command
   */
  async run(): Promise<void> {
    // Parse command line arguments
    const { args, flags } = await this.parse(Worker);
    
    // Run command
    await CommandRegistry
      .executeCommand<WorkerArgs, WorkerFlags>('worker', this, args, flags);
  }
}
