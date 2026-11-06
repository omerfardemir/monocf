import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import dotenv from 'dotenv'

import {envSection, readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError, isPlainObject, type ResolvedWorker} from '../config/types.js'
import {validateSelection} from '../config/validate.js'
import {EXIT_FAILED, EXIT_OK} from '../errors.js'
import type {OptionFlags} from '../project/options.js'
import {locateWrangler} from '../wrangler/locate.js'
import {isSuccessful, readActiveVersion, readFailure, type ActiveInfo} from '../wrangler/read.js'
import {accountOf, runWorkerSteps, withRun, type RunContext} from './run.js'
import {workerCall} from './deployment.js'
import {loadOptions, selectAll} from './project.js'

export interface SecretsCheckFlags extends OptionFlags {
  json?: boolean
}

const READ_CONCURRENCY = 8
const EXAMPLE_FILE = '.dev.vars.example'

/** Names only: the values in the example are dropped as soon as the file is parsed. */
function exampleNames(path: string): string[] | undefined {
  try {
    return Object.keys(dotenv.parse(readFileSync(join(path, EXAMPLE_FILE), 'utf8')))
  } catch {
    return undefined
  }
}

function requiredNames(config: ResolvedWorker['config'], env: string): string[] | undefined {
  const {secrets} = envSection(config, env)
  if (!isPlainObject(secrets) || !Array.isArray(secrets.required)) return undefined
  return secrets.required.filter((name): name is string => typeof name === 'string')
}

/** Every source says something, or nothing does. Undefined means this worker can't be checked. */
function expectedNames({config, path}: ResolvedWorker, env: string): string[] | undefined {
  const required = requiredNames(config, env)
  const example = exampleNames(path)
  if (required === undefined && example === undefined) return undefined
  return [...new Set([...(required ?? []), ...(example ?? [])])].sort()
}

function activeVersionOf(active: ActiveInfo): string | undefined {
  if (active.state === 'missing') return undefined
  if (active.state === 'active') return active.versionId
  return [...active.shares].sort((a, b) => b.percentage - a.percentage)[0].versionId
}

/** `secret list` follows the latest upload, so the version that's live has to be asked. */
async function actualNames(context: RunContext, worker: ResolvedWorker, env: string): Promise<string[] | undefined> {
  const {deployedName, dir} = worker
  const accountId = accountOf(context, worker, env)
  const call = workerCall(context, dir)
  const versionId = activeVersionOf(await readActiveVersion(call, deployedName, accountId))
  if (versionId === undefined) return undefined
  const result = await call({action: 'version-view', name: deployedName, versionId}, accountId)
  if (!isSuccessful(result)) throw readFailure(deployedName, result)
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw readFailure(deployedName, {...result, code: 1, stderr: 'wrangler versions view printed something that is not JSON.'})
  }

  const resources = isPlainObject(parsed) ? parsed.resources : undefined
  const bindings = isPlainObject(resources) && Array.isArray(resources.bindings) ? resources.bindings : []
  return bindings
    .filter((binding): binding is {name: string; type: string} => isPlainObject(binding) && binding.type === 'secret_text' && typeof binding.name === 'string')
    .map(({name}) => name)
    .sort()
}

/** `monocf secrets check`: says which secret names the active version of each worker is missing. Never a value. */
export async function runSecretsCheck(flags: SecretsCheckFlags): Promise<void> {
  const options = loadOptions(flags)
  const {env, rootDir} = options
  if (env === undefined) throw new ConfigError('secrets check needs --env.')
  const selection = selectAll(options)
  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  validateSelection(selection.selected, options, inputs, project)
  const workers = project.workers.filter(({dir}) => selection.selected.includes(dir))
  let exitCode: number = EXIT_OK

  await withRun(
    {action: 'secrets-check', env, json: flags.json === true, notices: [], resolved: workers, rootDir, workers: selection.selected, wrangler: locateWrangler(rootDir)},
    async (context) => {
      await runWorkerSteps(context, {
        action: 'secrets-check',
        concurrency: READ_CONCURRENCY,
        steps: workers.map((worker) => ({
          dependsOn: [],
          async run() {
            const {dir} = worker
            const expected = expectedNames(worker, env)
            if (expected === undefined) {
              context.emit({note: `no secrets.required and no ${EXAMPLE_FILE}, so nothing to check against`, type: 'secrets-check', worker: dir})
              return
            }

            const actual = await actualNames(context, worker, env)
            if (actual === undefined) {
              exitCode = EXIT_FAILED
              context.emit({missing: expected, note: 'the worker does not exist', type: 'secrets-check', worker: dir})
              return
            }

            const missing = expected.filter((name) => !actual.includes(name))
            const extra = actual.filter((name) => !expected.includes(name))
            if (missing.length > 0) exitCode = EXIT_FAILED
            context.emit({...(extra.length > 0 && {extra}), ...(missing.length > 0 && {missing}), present: actual.filter((name) => expected.includes(name)), type: 'secrets-check', worker: dir})
          },
          worker: worker.dir,
        })),
      })
      return exitCode
    },
  )

  process.exitCode = exitCode
}
