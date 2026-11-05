import {writeFileSync} from 'node:fs'
import {join} from 'node:path'

import type {ResolvedWorker} from '../config/types.js'
import {rebaseConfig} from './path-fields.js'
import type {RunDir} from './run-dir.js'
import {serializeDevVars, type EnvValues} from './secrets.js'

const CONFIG_NAME = 'wrangler.json'
const SECRET_MODE = 0o600

function writeSecretFile(path: string, content: string): void {
  writeFileSync(path, content, {mode: SECRET_MODE})
}

/** Writes a worker's resolved config with its paths rebased, and returns its path. The only config wrangler reads. */
export function materialiseConfig(worker: ResolvedWorker, runDir: RunDir): string {
  const dir = runDir.workerDir(worker.dir)
  const path = join(dir, CONFIG_NAME)
  writeFileSync(path, `${JSON.stringify(rebaseConfig(worker.config, {from: worker.path, to: dir}), null, 2)}\n`)
  return path
}

/** Wrangler looks for `.dev.vars` next to the config, so `dev` needs nothing in the source tree. */
export function writeDevVars(worker: string, values: EnvValues, runDir: RunDir): void {
  writeSecretFile(join(runDir.workerDir(worker), '.dev.vars'), serializeDevVars(values))
}

/** JSON rather than dotenv, so no value depends on how it's quoted. */
export function writeSecretsFile(worker: string, values: EnvValues, runDir: RunDir): string {
  const path = join(runDir.workerDir(worker), 'secrets.json')
  writeSecretFile(path, JSON.stringify(values))
  return path
}
