import {readProjectInputs, resolveProject} from '../config/resolve.js'
import {ConfigError} from '../config/types.js'
import {validateSelection} from '../config/validate.js'
import {EXIT_FAILED, EXIT_OK} from '../errors.js'
import type {OptionFlags} from '../project/options.js'
import {declaredSecretNames, SECRETS_EXAMPLE_FILE} from '../runtime/secret-names.js'
import {locateWrangler} from '../wrangler/locate.js'
import {readLiveSecrets} from './live-secrets.js'
import {runWorkerSteps, withRun} from './run.js'
import {loadOptions, selectAll} from './project.js'

export interface SecretsCheckFlags extends OptionFlags {
  json?: boolean
}

const READ_CONCURRENCY = 8

/** `monocf secrets check`: says which secret names the active version of each worker is missing. Never a value. */
export async function runSecretsCheck(flags: SecretsCheckFlags): Promise<void> {
  const options = loadOptions(flags)
  const {env, rootDir} = options
  if (env === undefined) throw new ConfigError('secrets check needs --env.', {code: 'missing-flag'})
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
            const expected = declaredSecretNames(worker, env)
            if (expected === undefined) {
              context.emit({note: `no secrets.required and no ${SECRETS_EXAMPLE_FILE}, so nothing to check against`, type: 'secrets-check', worker: dir})
              return
            }

            const actual = (await readLiveSecrets(context, worker, env))?.names
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
