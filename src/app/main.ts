import {Errors, flush, handle, run} from '@oclif/core'

import {isReported, toErrorEvent, wantsJson} from '../report/error-event.js'
import {formatNdjson} from '../report/ndjson.js'

/**
 * What bin/run.js runs. A command reports its own errors, flag errors included, so this catches what fails before any command
 * runs, such as an unknown command, and gives it its event under `--json` too. oclif then prints it on stderr and exits.
 */
export async function main(dir: string, argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await run(argv, dir)
    await flush()
  } catch (error) {
    if (wantsJson(argv) && !isReported(error) && !(error instanceof Errors.ExitError)) {
      const line = formatNdjson(toErrorEvent(error))
      await new Promise<void>((resolve) => {
        process.stdout.write(line, () => resolve())
      })
    }

    await handle(error as Error)
  }
}
