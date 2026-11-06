import {Args, Flags, type Interfaces} from '@oclif/core'

import {projectFlags} from './flags.js'
import {runWorker, type WorkerAction} from './worker.js'

export const workerArgs = {
  workerName: Args.string({description: 'Worker name. default: the worker whose directory you are in', required: false}),
}

/** What `monocf build`, `deploy`, `preview` and `dev` take, and `monocf worker -c` with them. */
export const workerFlags = {
  ...projectFlags,
  all: Flags.boolean({char: 'a', default: false, description: 'Run command for all workers'}),
  concurrency: Flags.integer({
    description: 'How many workers run at once. default: the CPU count up to 8 for build, 1 for deploy and preview',
    min: 1,
  }),
  'deploy-bindings': Flags.boolean({
    allowNo: true,
    char: 'd',
    description: 'Also deploy or upload the workers it binds to, first',
  }),
  'deploy-from-version-id': Flags.string({
    char: 'F',
    description: 'Version ID to deploy instead of the latest uploaded version. Requires --from-version',
  }),
  'deploy-secrets': Flags.boolean({allowNo: true, char: 's', description: 'Also upload secrets, from the exact .dev.vars files for the env'}),
  env: Flags.string({char: 'e', description: 'Environment to use (dev, production etc.)'}),
  'from-version': Flags.boolean({char: 'f', description: 'Deploy from an existing version or latest uploaded version'}),
  json: Flags.boolean({description: 'Print results as NDJSON on stdout'}),
  message: Flags.string({char: 'M', description: 'Message for the version: on deploy, preview or --from-version'}),
  minify: Flags.boolean({allowNo: true, char: 'm', description: 'Minify the worker script during build/deploy'}),
  port: Flags.integer({
    char: 'p',
    description: 'Port for dev: of the worker, or of the proxy with --all. default for the proxy: 8787',
  }),
}

type ParsedFlags = Interfaces.InferredFlags<typeof workerFlags>

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<T, K>
}

const COMMON = ['base-config', 'root-dir', 'workers-dir-name', 'all', 'env', 'json'] as const

/**
 * What each command's `--help` lists: only the flags it acts on. `monocf worker -c` still takes them all, and refuses the ones
 * its action doesn't use with a message naming the flag.
 */
export const buildFlags = pick(workerFlags, [...COMMON, 'concurrency', 'minify'])
export const deployFlags = pick(workerFlags, [
  ...COMMON,
  'concurrency',
  'deploy-bindings',
  'deploy-from-version-id',
  'deploy-secrets',
  'from-version',
  'message',
  'minify',
])
export const devFlags = pick(workerFlags, [...COMMON, 'port'])
export const previewFlags = pick(workerFlags, [...COMMON, 'concurrency', 'deploy-bindings', 'deploy-secrets', 'message', 'minify'])

export function runWorkerCommand(command: WorkerAction, workerName: string | undefined, flags: Partial<ParsedFlags>): Promise<void> {
  return runWorker(workerName, {
    all: flags.all ?? false,
    baseConfig: flags['base-config'],
    command,
    concurrency: flags.concurrency,
    deployBindings: flags['deploy-bindings'],
    deployFromVersionId: flags['deploy-from-version-id'],
    deploySecrets: flags['deploy-secrets'],
    env: flags.env,
    fromVersion: flags['from-version'],
    json: flags.json,
    message: flags.message,
    minify: flags.minify,
    port: flags.port,
    rootDir: flags['root-dir'],
    workersDirName: flags['workers-dir-name'],
  })
}
