// Initialize the command registry
import {CommandRegistry} from './core/commands/registry.js'

// Initialize the registry at application startup
CommandRegistry.getInstance().initialize()

export {run} from '@oclif/core'
