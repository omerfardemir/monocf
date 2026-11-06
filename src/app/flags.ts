import {Flags} from '@oclif/core'

/** Where a command finds the project. Every command that reads worker configs takes these. */
export const projectFlags = {
  'base-config': Flags.string({char: 'b', description: 'Base wrangler config file'}),
  'root-dir': Flags.string({char: 'r', description: 'Root directory of the project'}),
  'workers-dir-name': Flags.string({char: 'w', description: 'Workers directory name in monorepo'}),
}
