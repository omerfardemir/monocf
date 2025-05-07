import {Commander} from '../../types/command-types.js'
import {CommandFactory} from './command-factory.js'
import {AbstractCommand} from './abstract-command.js'

// Import command implementations
import {WhoamiCommand} from './whoami/index.js'
import {WorkerCreateCommand} from './worker/create-command.js'
import {WranglerCommand} from './worker/wrangler-command.js'

/**
 * Command registration interface
 */
interface CommandRegistration {
  name: string
  commandClass: new (command: Commander) => AbstractCommand
}

/**
 * Command registry that manages all available commands
 * This provides a central place to register and retrieve commands
 * independent of the CLI framework
 */
export class CommandRegistry {
  private static _instance: CommandRegistry
  private _initialized = false
  private _commandRegistrations: CommandRegistration[] = []

  /**
   * Get the singleton instance of the command registry
   */
  public static getInstance(): CommandRegistry {
    if (!CommandRegistry._instance) {
      CommandRegistry._instance = new CommandRegistry()
    }

    return CommandRegistry._instance
  }

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {
    // Register all known commands
    this.registerBuiltInCommands()
  }

  /**
   * Register a command with the registry
   * @param name The name of the command
   * @param commandClass The command class constructor
   */
  public registerCommand(name: string, commandClass: new (command: Commander) => AbstractCommand): void {
    this._commandRegistrations.push({name, commandClass})
  }

  /**
   * Register all built-in commands
   * This is where we register all the commands that are part of the core application
   * When adding a new command, just add it here
   */
  private registerBuiltInCommands(): void {
    // Register whoami command
    this.registerCommand('whoami', WhoamiCommand)

    // Register worker commands
    this.registerCommand('worker', WranglerCommand)
    this.registerCommand('worker:create', WorkerCreateCommand)

    // Add new commands here...
    // this.registerCommand('new-command', NewCommandClass);
  }

  /**
   * Initialize the command registry
   * This registers all commands with the command factory
   */
  public initialize(): void {
    if (this._initialized) {
      return
    }

    // Register all commands with the CommandFactory
    for (const registration of this._commandRegistrations) {
      CommandFactory.registerCommand(registration.name, registration.commandClass)
    }

    this._initialized = true
  }

  /**
   * Execute a command by name
   * @param commandName The name of the command to execute
   * @param command The oclif command instance
   * @param args Command arguments
   * @param flags Command flags
   */
  public static async executeCommand<TArgs = unknown, TFlags = unknown>(
    commandName: string,
    command: Commander,
    args?: TArgs,
    flags?: TFlags,
  ): Promise<void> {
    // Ensure registry is initialized
    this.getInstance().initialize()

    // Execute the command
    return CommandFactory.executeCommand(commandName, command, args, flags)
  }

  /**
   * Get all registered commands
   * @returns An array of command registrations
   */
  public getCommands(): CommandRegistration[] {
    return [...this._commandRegistrations]
  }
}
