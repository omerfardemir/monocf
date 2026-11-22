import {readProjectInputs, resolveProject, type ResolvedProject} from '../config/resolve.js'
import {ConfigError, type ResolvedWorker} from '../config/types.js'
import {validateSelection} from '../config/validate.js'
import {MonocfError} from '../errors.js'
import type {OptionFlags, Options} from '../project/options.js'
import {materialiseConfig} from '../runtime/materialise.js'
import {declaredSecretNames, SECRETS_EXAMPLE_FILE} from '../runtime/secret-names.js'
import {
  assertDistinctPrefixes,
  readSecrets,
  readSecretsFromEnv,
  requireSecretsFile,
  type EnvValues,
} from '../runtime/secrets.js'
import {locateWrangler} from '../wrangler/locate.js'
import {confirmSecretsUpload, readLiveSecrets, type LiveSecrets} from './live-secrets.js'
import {loadOptions, selectFromArguments} from './project.js'
import {aloneMode, reportStep, runStep, withRun, type RunContext} from './run.js'

export interface SecretsFlags extends OptionFlags {
  create?: boolean
  fromEnv?: boolean
  json?: boolean
}

/** A worker either has values to upload or says why it has none, never both. */
type Upload =
  | {
      /** Where each value came from, by name, for --from-env. Printed so a run shows which variable won. */
      sources?: Record<string, string>
      values: EnvValues
      worker: ResolvedWorker
    }
  | {skip: string; worker: ResolvedWorker}

/** From the exact `.dev.vars.<env>` files: the root's, then the worker's. */
function fromFiles(workers: ResolvedWorker[], {env, rootDir}: Options): Upload[] {
  for (const worker of workers) requireSecretsFile(worker.path, rootDir, env)
  return workers.map((worker) => {
    const values = readSecrets(worker.path, rootDir, env)
    return Object.keys(values).length === 0 ? {skip: 'no secrets to upload', worker} : {values, worker}
  })
}

/** From environment variables, for the names each worker declares. A missing value anywhere stops the run before any upload. */
function fromEnvironment(workers: ResolvedWorker[], project: ResolvedProject, {env}: Options): Upload[] {
  assertDistinctPrefixes(project.workers.map(({dir}) => dir))
  const uploads: Upload[] = []
  const missing: string[] = []
  for (const worker of workers) {
    const names = declaredSecretNames(worker, env)
    if (names === undefined || names.length === 0) {
      uploads.push({skip: `no secret names to read: it has no secrets.required and no ${SECRETS_EXAMPLE_FILE}`, worker})
      continue
    }

    const found = readSecretsFromEnv(worker.dir, names, process.env)
    missing.push(...found.missing.map(({name, tried}) => `${worker.dir}: ${name} (set ${tried.join(' or ')})`))
    uploads.push({sources: found.variables, values: found.values, worker})
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `No value for ${missing.length === 1 ? 'a secret' : `${missing.length} secrets`}, so nothing was uploaded. An empty variable counts as unset.\n  ${missing.join('\n  ')}`,
      {code: 'secret-env-missing'},
    )
  }

  return uploads
}

function describeSources(sources: Record<string, string>): string {
  return Object.entries(sources)
    .map(([name, variable]) => (name === variable ? name : `${name} from ${variable}`))
    .join(', ')
}

/**
 * The live version of each worker, read before any upload. A missing worker stops the run here, as `secret bulk` would create
 * one from what may be a typo, and the version is what a new upload has to replace.
 */
async function readBefore(context: RunContext, uploads: Upload[], {create, env}: {create: boolean; env?: string}): Promise<Map<string, LiveSecrets | undefined>> {
  const before = new Map<string, LiveSecrets | undefined>()
  for (const {worker} of uploads.filter((upload) => !('skip' in upload))) before.set(worker.dir, await readLiveSecrets(context, worker, env))
  const missing = [...before].filter(([, live]) => live === undefined).map(([dir]) => dir)
  if (missing.length > 0 && !create) {
    const message =
      missing.length === 1
        ? `${missing[0]}: this worker does not exist on Cloudflare. Deploy it first, or pass --create to create it with its secrets.`
        : `${missing.join(', ')}: these workers do not exist on Cloudflare. Deploy them first, or pass --create to create them with their secrets.`
    throw new MonocfError(message, {
      code: 'worker-not-deployed',
    })
  }

  return before
}

/** `monocf secrets deploy`: uploads each selected worker's secrets, from its exact env files or from the environment. */
export async function runSecretsDeploy(name: string | undefined, flags: SecretsFlags): Promise<void> {
  const options = loadOptions(flags)
  const {selected} = selectFromArguments(options, name)
  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  validateSelection(selected, options, inputs, project)
  const workers = selected.map((dir) => project.workers.find((worker) => worker.dir === dir)!)
  const uploads = flags.fromEnv ? fromEnvironment(workers, project, options) : fromFiles(workers, options)
  const {env} = options

  await withRun(
    {action: 'secrets', env, json: flags.json === true, notices: [], resolved: workers, rootDir: options.rootDir, workers: selected, wrangler: locateWrangler(options.rootDir)},
    async (context) => {
      const before = await readBefore(context, uploads, {create: flags.create === true, env})
      for (const upload of uploads) {
        const {dir} = upload.worker
        if ('skip' in upload) {
          context.emit({message: `${dir}: ${upload.skip}.`, type: 'notice', worker: dir})
          continue
        }

        const {sources, values, worker} = upload
        if (sources !== undefined) context.emit({message: `${dir}: uploading ${describeSources(sources)}.`, type: 'notice', worker: dir})
        await reportStep(context, 'secrets', dir, async () => {
          await runStep(context, {
            argvOptions: {env},
            input: JSON.stringify(values),
            mode: aloneMode(context, false),
            step: {action: 'secret-bulk', configPath: materialiseConfig(worker, context.runDir)},
            worker: dir,
          })
          return confirmSecretsUpload(() => readLiveSecrets(context, worker, env), {before: before.get(dir)?.versionId, dir, names: Object.keys(values)}, {signal: context.interrupts.signal})
        })
      }
    },
  )
}
