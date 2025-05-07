import {Commander} from '../../types/command-types.js'
import {AbstractCommand} from './abstract-command.js'

/**
 * Factory for creating and executing commands
 */
export class CommandFactory {
  // Registry of command classes keyed by command name
  private static commandRegistry: Record<string, new (command: Commander) => AbstractCommand> = {}

  /**
   * Registers a command class with the factory
   * @param commandName The name of the command
   * @param commandClass The command class constructor
   */
  public static registerCommand(commandName: string, commandClass: new (command: Commander) => AbstractCommand): void {
    this.commandRegistry[commandName] = commandClass
  }

  /**
   * Creates a command instance
   * @param commandName The name of the command to create
   * @param command The oclif command instance
   * @returns An instance of the command
   * @throws Error if the command is not registered
   */
  public static createCommand(commandName: string, command: Commander): AbstractCommand {
    const CommandClass = this.commandRegistry[commandName]

    if (!CommandClass) {
      throw new Error(`Command '${commandName}' is not registered`)
    }

    return new CommandClass(command)
  }

  /**
   * Executes a command with the given arguments and flags
   * @param commandName The name of the command to execute
   * @param command The oclif command instance
   * @param args Command arguments
   * @param flags Command flags
   * @throws Error if the command is not registered
   */
  public static async executeCommand<TArgs = unknown, TFlags = unknown>(
    commandName: string,
    command: Commander,
    args?: TArgs,
    flags?: TFlags,
  ): Promise<void> {
    const commandInstance = this.createCommand(commandName, command)
    return commandInstance.executeWithErrorHandling(args || {}, flags || {})
  }
}
