import {EnvironmentService, ErrorService, FileService, ServiceBindingService, WranglerService} from '../../services/index.js'
import {WorkerCommand} from '../../types/command-types.js'
import {DeployCommand} from './deploy-command.js'
import {DevCommand} from './dev-command.js'
import {WorkerCommandExecutor} from './worker-command-executor.js'

/**
 * Factory for creating command executors
 */
// eslint-disable-next-line unicorn/no-static-only-class
export class WorkerCommandFactory {
  /**
   * Creates a command executor for the specified command
   * @param command Command to create executor for
   * @param {object} services Services to use
   * @param {ErrorService} services.errorService Error service
   * @param {FileService} services.fileService File service
   * @param {ServiceBindingService} services.serviceBindingService Service binding service
   * @param {WranglerService} services.wranglerService Wrangler service
   * @param {EnvironmentService} services.environmentService Environment service
   * @returns Command executor
   */
  static createCommand(
    command: WorkerCommand,
    services: {
      errorService: ErrorService
      fileService: FileService
      serviceBindingService: ServiceBindingService
      wranglerService: WranglerService
      environmentService: EnvironmentService
    },
  ): WorkerCommandExecutor {
    // Create command executor
    switch (command) {
      case 'dev': {
        return new DevCommand(
          services.serviceBindingService,
          services.errorService,
          services.fileService,
          services.wranglerService,
          services.environmentService,
        )
      }

      case 'deploy': {
        return new DeployCommand(
          services.errorService,
          services.fileService,
          services.wranglerService,
          services.serviceBindingService,
          services.environmentService,
        )
      }

      default: {
        throw new Error(`Unknown command: ${command}`)
      }
    }
  }
}
