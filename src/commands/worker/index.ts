import {Flags} from '@oclif/core'

import {BaseCommand} from '../../app/base-command.js'
import {runWorkerCommand, workerArgs, workerFlags} from '../../app/worker-command.js'
import type {WorkerAction} from '../../app/worker.js'

const workerCommand = Flags.custom<WorkerAction>({
  char: 'c',
  description: 'Command to execute',
  options: ['build', 'deploy', 'dev', 'preview'],
  required: true,
})

export default class Worker extends BaseCommand {
  static args = workerArgs
  static description = 'Deprecated: use monocf build, deploy, preview or dev, which take the same flags'
  static examples = ['<%= config.bin %> worker my-worker -c deploy -e dev']
  static flags = {...workerFlags, command: workerCommand()}

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Worker)
    process.stderr.write(`"monocf worker -c ${flags.command}" is deprecated. Use "monocf ${flags.command}".\n`)
    await runWorkerCommand(flags.command, args.workerName, flags)
  }
}
