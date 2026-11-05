import {Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {projectFlags} from '../../app/flags.js'
import {runGraph} from '../../app/graph.js'

export default class Graph extends BaseCommand {
  static description = 'Print the dependency graph of the workers, callees first. Needs no credentials'
  static examples = [
    '<%= config.bin %> graph -e dev',
    '<%= config.bin %> graph -e dev --json',
    '<%= config.bin %> graph -e dev --mermaid',
    '<%= config.bin %> graph -e dev --callers orders',
  ]
  static flags = {
    ...projectFlags,
    callers: Flags.string({description: 'Print every worker that reaches this one, directly or not', exclusive: ['mermaid']}),
    env: Flags.string({char: 'e', description: 'Environment to use (dev, production etc.)'}),
    json: Flags.boolean({description: 'Print the graph as JSON', exclusive: ['mermaid']}),
    mermaid: Flags.boolean({description: 'Print the graph as a Mermaid flowchart'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Graph)
    runGraph({
      baseConfig: flags['base-config'],
      callers: flags.callers,
      env: flags.env,
      json: flags.json,
      mermaid: flags.mermaid,
      rootDir: flags['root-dir'],
      workersDirName: flags['workers-dir-name'],
    })
  }
}
