import {DockerStopCommand} from '../../core/commands/docker/stop.js'
import {CommandBase} from '../../types/oclif-types.js'

/**
 * Command to stop a docker container for a worker project
 */
export default class DockerStop extends CommandBase {
  static description = 'Stop docker container for a worker project'
  static examples = ['<%= config.bin %> docker stop']

  /**
   * Run the docker stop command
   */
  async run(): Promise<void> {
    const {args, flags} = await this.parse(DockerStop)
    return new DockerStopCommand(this).executeWithErrorHandling(args, flags)
  }
}
