import { WranglerService } from "../../../services/index.js";
import { Commander } from "../../../types/command-types.js";
import { AbstractCommand } from "../abstract-command.js";

/**
 * Command executor for the whoami command
 */
export class WhoamiCommand extends AbstractCommand {
  private wranglerService: WranglerService;

  constructor(command: Commander) {
    super(command);
    this.wranglerService = new WranglerService(
      this.errorService,
      this.fileService,
      command.cmdEvents()
    );
  }

  protected async execute(): Promise<void> {
    await this.wranglerService.execWhoami();
  }
}