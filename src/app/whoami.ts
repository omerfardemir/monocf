import {dirname} from 'node:path'

import {findConfigFile} from '../project/load.js'
import {Interrupts} from '../runtime/signals.js'
import {buildArgv} from '../wrangler/argv.js'
import {locateWrangler} from '../wrangler/locate.js'
import {spawnWrangler} from '../wrangler/process.js'
import {failureOf, isSuccess} from './run.js'

/** Needs no project: wrangler is found from the project root when there is one, else from here. */
export async function runWhoami(cwd: string = process.cwd()): Promise<void> {
  const configPath = findConfigFile(cwd)
  const wrangler = locateWrangler(configPath ? dirname(configPath) : cwd)
  const interrupts = new Interrupts()
  try {
    const running = spawnWrangler(wrangler, buildArgv({action: 'whoami'}), {cwd, mode: 'inherit'})
    interrupts.track(running.child)
    const result = await running.done
    interrupts.throwIfInterrupted()
    if (!isSuccess(result)) throw failureOf('', 'whoami', result)
  } finally {
    interrupts.dispose()
  }
}
