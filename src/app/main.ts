import {Config, Errors, flush, handle, run} from '@oclif/core'
import {normalizeArgv} from '@oclif/core/help'

import {MonocfError} from '../errors.js'
import {isReported, wantsJson, writeErrorEvent} from '../report/error-event.js'
import {reportOnStderr} from './base-command.js'

/**
 * oclif answers a topic with no command, such as `monocf secrets`, with the topic's help on stdout and exit 0. Under `--json` that
 * would be neither JSON nor a failure, so it fails before oclif sees it.
 */
function assertNamesCommand(config: Config, argv: string[]): void {
  const [id] = normalizeArgv(config, argv)
  if (id === undefined || config.findCommand(id) || !config.findTopic(id)) return
  const topic = id.replaceAll(':', ' ')
  const commands = config.commands.filter((command) => command.id.startsWith(`${id}:`) && !command.hidden).map((command) => command.id.replaceAll(':', ' '))
  throw new MonocfError(`${topic} is a topic, not a command. Name one of its commands: ${commands.join(', ')}.`, {
    code: 'command-needed',
    hint: `Run one of: ${commands.map((command) => `monocf ${command}`).join(', ')}.`,
  })
}

/**
 * A command reports its own errors, flag errors included, so this catches what fails before any command runs, such as an unknown
 * command, and gives it its event under `--json` too. oclif then prints it on stderr and exits.
 */
export async function main(dir: string, argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const config = await Config.load(dir)
    if (wantsJson(argv)) assertNamesCommand(config, argv)
    await run(argv, config)
    await flush()
  } catch (error) {
    if (wantsJson(argv) && !isReported(error) && !(error instanceof Errors.ExitError)) await writeErrorEvent(error)
    if (error instanceof MonocfError) {
      reportOnStderr(error)
      return
    }

    await handle(error as Error)
  }
}
