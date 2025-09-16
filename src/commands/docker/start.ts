import {CommandBase} from '../../types/oclif-types.js'
import {CommandRegistry} from '../../core/commands/registry.js'
import {Flags} from '@oclif/core'

/**
 * Command to create a new worker
 */
export default class DockerStart extends CommandBase {
  static description = 'Start docker container for a worker project'
  static examples = ['<%= config.bin %> docker start']
  static flags = {
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
    port: Flags.integer({
      char: 'p',
      description: 'Port to use for the docker container',
      required: false,
    }),
  }

  /**
   * Run the docker start command
   */
  async run(): Promise<void> {
    const {args, flags} = await this.parse(DockerStart)

    // Execute command
    await CommandRegistry.executeCommand('docker:start', this, args, flags)
  }
}
