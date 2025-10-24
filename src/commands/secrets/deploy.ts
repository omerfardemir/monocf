import {Args, Flags} from '@oclif/core'

import {VerifiedFields, CreateWorkerArgs, DeploySecretsFlags} from '../../flags/index.js'
import {CommandBase} from '../../types/oclif-types.js'
import {CommandRegistry} from '../../core/commands/registry.js'
import {normalizeFlags} from '../../utils/flag.js'

/**
 * Secrets deploy command args & flags
 */
const args = {
  workerName: Args.string({
    description: 'Worker name',
    required: false,
  }),
}

const flags = {
  all: Flags.boolean({
    char: 'a',
    default: false,
    description: 'Run command for all workers',
    required: false,
  }),
  'base-config': Flags.string({
    char: 'b',
    description: 'Base wrangler config file',
    required: false,
  }),
  env: Flags.string({
    char: 'e',
    description: 'Environment to use (dev, production etc.)',
    required: false,
  }),
  'root-dir': Flags.string({
    char: 'r',
    description: 'Root directory of the project',
    required: false,
  }),
  'workers-dir-name': Flags.string({
    char: 'w',
    description: 'Workers directory name in monorepo',
    required: false,
  }),
}

/**
 * Command to deploy secrets for a worker
 */
export default class SecretsDeploy extends CommandBase {
  static description = 'Deploy secrets for the worker'
  static examples = ['<%= config.bin %> secrets deploy']
  static args: VerifiedFields<CreateWorkerArgs, typeof args> = args
  static flags = flags

  /**
   * Run the secrets deploy command
   */
  async run(): Promise<void> {
    // Parse command line arguments
    const {args, flags} = await this.parse(SecretsDeploy)
    const normalizedFlags: DeploySecretsFlags = normalizeFlags<DeploySecretsFlags>(flags)

    this.command = await CommandRegistry.createCommand('secrets:deploy', this)
    return this.command.execute(args, normalizedFlags)
  }
}
