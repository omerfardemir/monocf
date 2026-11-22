import {readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError, type ResolvedWorker} from '../config/types.js'
import {validateSelection} from '../config/validate.js'
import {MonocfError} from '../errors.js'
import type {OptionFlags} from '../project/options.js'
import {materialiseConfig} from '../runtime/materialise.js'
import {declaredSecretNames, SECRETS_EXAMPLE_FILE} from '../runtime/secret-names.js'
import {
  assertDistinctPrefixes,
  readSecrets,
  readSecretsFromEnv,
  requireSecretsFile,
  workerVariablePrefix,
  type EnvValues,
} from '../runtime/secrets.js'
import {buildArgv} from '../wrangler/argv.js'
import {locateWrangler} from '../wrangler/locate.js'
import {spawnWrangler} from '../wrangler/process.js'
import {loadOptions, selectFromArguments} from './project.js'
import {aloneMode, failureOf, isSuccess, reportStep, runStep, withRun, type RunContext} from './run.js'

const WORKER_NOT_FOUND_CODE = 10_007

export interface SecretsFlags extends OptionFlags {
  create?: boolean
  fromEnv?: boolean
  json?: boolean
}

interface Upload {
  /** Why there's nothing to upload, when there isn't. */
  skip?: string
  /** Where each value came from, by name: a variable, for --from-env. */
  sources?: Record<string, string>
  values: EnvValues
  worker: ResolvedWorker
}

interface WorkerTarget {
  configPath: string
  dir: string
  env?: string
}

/** `secret bulk` creates a missing worker in a non-interactive run, so a typo in a name would make a new one. */
async function assertWorkerExists(context: RunContext, {configPath, dir, env}: WorkerTarget): Promise<void> {
  const {environmentOf, interrupts, runDir, wrangler} = context
  const step = {action: 'deployment-status', configPath} as const
  const running = spawnWrangler(wrangler, buildArgv(step, {env}), {
    cwd: runDir.workerDir(dir),
    environment: environmentOf(dir),
    mode: 'capture',
    outputFile: runDir.outputFile(dir),
  })
  interrupts.track(running.child)
  const result = await running.done
  interrupts.throwIfInterrupted()
  if (isSuccess(result)) return

  const missing = result.output.failure?.code === WORKER_NOT_FOUND_CODE || result.stderr.includes('code: 10007')
  if (missing) {
    throw new MonocfError(
      `${dir}: this worker does not exist on Cloudflare. Deploy it first, or pass --create to create it with its secrets.`,
      {code: 'worker-not-deployed'},
    )
  }

  throw failureOf(`${dir}: `, step.action, result)
}

/** From the exact `.dev.vars.<env>` files: the root's, then the worker's. */
function fromFiles(workers: ResolvedWorker[], rootDir: string, env: string | undefined): Upload[] {
  for (const worker of workers) requireSecretsFile(worker.path, rootDir, env)
  return workers.map((worker) => {
    const values = readSecrets(worker.path, rootDir, env)
    return {...(Object.keys(values).length === 0 && {skip: 'no secrets to upload'}), values, worker}
  })
}

/**
 * From environment variables, for the names each worker declares. Every value has to be there before anything is uploaded, so a
 * run never leaves one worker with new secrets and the next with old ones.
 */
function fromEnvironment(workers: ResolvedWorker[], allWorkers: ResolvedWorker[], env: string | undefined): Upload[] {
  assertDistinctPrefixes(allWorkers.map(({dir}) => dir))
  const uploads: Upload[] = []
  const missing: string[] = []
  for (const worker of workers) {
    const names = declaredSecretNames(worker, env)
    if (names === undefined || names.length === 0) {
      uploads.push({skip: `no secret names to read: it has no secrets.required and no ${SECRETS_EXAMPLE_FILE}`, values: {}, worker})
      continue
    }

    const found = readSecretsFromEnv(worker.dir, names, process.env)
    const prefix = workerVariablePrefix(worker.dir)
    missing.push(...found.missing.map((name) => `${worker.dir}: ${name} (set ${prefix}${name} or ${name})`))
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

/** `monocf secrets deploy`: uploads each selected worker's secrets, from its exact env files or from the environment. */
export async function runSecretsDeploy(name: string | undefined, flags: SecretsFlags): Promise<void> {
  const options = loadOptions(flags)
  const {selected} = selectFromArguments(options, name)
  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  validateSelection(selected, options, inputs, project)
  const workers = selected.map((dir) => project.workers.find((worker) => worker.dir === dir)!)
  const uploads = flags.fromEnv ? fromEnvironment(workers, project.workers, options.env) : fromFiles(workers, options.rootDir, options.env)
  const wrangler = locateWrangler(options.rootDir)

  await withRun(
    {
      action: 'secrets',
      env: options.env,
      json: flags.json === true,
      notices: [],
      resolved: workers,
      rootDir: options.rootDir,
      workers: selected,
      wrangler,
    },
    async (context) => {
      for (const {skip, sources, values, worker} of uploads) {
        const {dir} = worker
        if (skip !== undefined) {
          context.emit({message: `${dir}: ${skip}.`, type: 'notice', worker: dir})
          continue
        }

        if (sources !== undefined) context.emit({message: `${dir}: uploading ${describeSources(sources)}.`, type: 'notice', worker: dir})
        await reportStep(context, 'secrets', dir, async () => {
          const configPath = materialiseConfig(worker, context.runDir)
          if (!flags.create) await assertWorkerExists(context, {configPath, dir, env: options.env})
          await runStep(context, {
            argvOptions: {env: options.env},
            input: JSON.stringify(values),
            mode: aloneMode(context, false),
            step: {action: 'secret-bulk', configPath},
            worker: dir,
          })
        })
      }
    },
  )
}
