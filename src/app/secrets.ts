import {readProjectInputs, resolveProject} from '../config/resolve.js'
import {validateSelection} from '../config/validate.js'
import {EXIT_FAILED, MonocfError} from '../errors.js'
import type {OptionFlags} from '../project/options.js'
import {materialiseConfig, writeSecretsFile} from '../runtime/materialise.js'
import {readSecrets, requireSecretsFile} from '../runtime/secrets.js'
import {buildArgv} from '../wrangler/argv.js'
import {locateWrangler} from '../wrangler/locate.js'
import {spawnWrangler} from '../wrangler/process.js'
import {loadOptions, selectFromArguments} from './project.js'
import {aloneMode, failureOf, isSuccess, reportStep, runStep, withRun, type RunContext} from './run.js'

const WORKER_NOT_FOUND_CODE = 10_007

export interface SecretsFlags extends OptionFlags {
  create?: boolean
  json?: boolean
}

interface WorkerTarget {
  configPath: string
  dir: string
  env?: string
}

/** `secret bulk` creates a missing worker in a non-interactive run, so a typo in a name would make a new one. */
async function assertWorkerExists(context: RunContext, {configPath, dir, env}: WorkerTarget): Promise<void> {
  const {interrupts, runDir, wrangler} = context
  const step = {action: 'deployment-status', configPath} as const
  const running = spawnWrangler(wrangler, buildArgv(step, {env}), {
    cwd: runDir.workerDir(dir),
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
      EXIT_FAILED,
    )
  }

  throw failureOf(`${dir}: `, step.action, result)
}

/** `monocf secrets deploy`: uploads each selected worker's secrets from its exact env files. */
export async function runSecretsDeploy(name: string | undefined, flags: SecretsFlags): Promise<void> {
  const options = loadOptions(flags)
  const {selected} = selectFromArguments(options, name)
  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  validateSelection(selected, options, inputs, project)
  const workers = selected.map((dir) => project.workers.find((worker) => worker.dir === dir)!)
  for (const worker of workers) requireSecretsFile(worker.path, options.rootDir, options.env)
  const wrangler = locateWrangler(options.rootDir)

  await withRun(
    {
      action: 'secrets',
      env: options.env,
      json: flags.json === true,
      notices: [],
      rootDir: options.rootDir,
      workers: selected,
      wrangler,
    },
    async (context) => {
      for (const worker of workers) {
        const {dir, path} = worker
        const secrets = readSecrets(path, options.rootDir, options.env)
        if (Object.keys(secrets).length === 0) {
          context.emit({message: `${dir}: no secrets to upload.`, type: 'notice', worker: dir})
          continue
        }

        await reportStep(context, 'secrets', dir, async () => {
          const configPath = materialiseConfig(worker, context.runDir)
          if (!flags.create) await assertWorkerExists(context, {configPath, dir, env: options.env})
          await runStep(context, {
            argvOptions: {env: options.env},
            mode: aloneMode(context, false),
            step: {action: 'secret-bulk', configPath, file: writeSecretsFile(dir, secrets, context.runDir)},
            worker: dir,
          })
        })
      }
    },
  )
}
