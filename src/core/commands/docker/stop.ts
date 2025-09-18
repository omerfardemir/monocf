import {MonocfCommand} from '../command.js'
import {DockerService} from '../../../services/docker-service.js'
import {Commander} from '../../../types/command-types.js'

export class DockerStopCommand extends MonocfCommand {
  private dockerService: DockerService

  constructor(commander: Commander) {
    super(commander)
    this.dockerService = new DockerService()
  }

  public async execute(): Promise<void> {
    return this.dockerService.stop()
  }
}
