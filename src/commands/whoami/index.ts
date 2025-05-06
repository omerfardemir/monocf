import { CommandRegistry } from "../../core/commands/registry.js";
import { CommandBase } from '../../types/oclif-types.js';

export default class Whoami extends CommandBase {
  static description = 'Show whoami from wrangler'
  static examples = [
    '<%= config.bin %> whoami'
  ]

  async run() {
    await CommandRegistry.executeCommand('whoami', this);
  }
}