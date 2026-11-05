import {join} from 'node:path'

import {runRules, type Finding} from '../check/rules.js'
import {readProjectInputs, resolveProject, type ProjectInputs} from '../config/resolve.js'
import {substituteConfig} from '../config/substitute.js'
import {isPlainObject} from '../config/types.js'
import {EXIT_OK, EXIT_USAGE} from '../errors.js'
import {nodeReader} from '../project/load.js'
import type {OptionFlags, Options} from '../project/options.js'
import {SCHEMA_VERSION} from '../report/events.js'
import {loadOptions, selectAll} from './project.js'

export interface CheckFlags extends OptionFlags {
  allEnvs?: boolean
  json?: boolean
  strict?: boolean
}

/** Every env the base config or a worker defines, after placeholders. A project with none is checked with no env. */
function allEnvs(inputs: ProjectInputs, options: Options): (string | undefined)[] {
  const sources = [inputs.base?.config, ...inputs.workers.map(({config}) => config)]
  const names = sources.flatMap((config) => {
    const {env} = substituteConfig({env: config?.env}, options.variables)
    return isPlainObject(env) ? Object.keys(env) : []
  })
  return names.length > 0 ? [...new Set(names)].sort() : [undefined]
}

function formatFinding({env, level, message, rule}: Finding): string {
  return `${level} ${rule}${env ? ` [${env}]` : ''}: ${message}\n`
}

/** `monocf check`: finds what would go wrong without running anything. It needs no wrangler and no credentials. */
export function runCheck(flags: CheckFlags): void {
  const options = loadOptions(flags)
  const {ignored, selected} = selectAll(options)
  const inputs = readProjectInputs(options)
  const envs = flags.allEnvs ? allEnvs(inputs, options) : [options.env]
  const directories = nodeReader.readDir(join(options.rootDir, options.workersDirName))

  const seen = new Set<string>()
  const findings = envs
    .flatMap((env) => {
      const envOptions = {...options, env}
      return runRules({
        directories,
        env,
        ignored,
        inputs,
        options: envOptions,
        project: resolveProject(envOptions, inputs),
        reader: nodeReader,
        selected,
      })
    })
    .filter((finding) => {
      const key = JSON.stringify(finding)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  const errors = findings.filter(({level}) => level === 'error').length
  const warnings = findings.length - errors
  if (flags.json) {
    const result = {envs: envs.map((env) => env ?? null), errors, findings, schemaVersion: SCHEMA_VERSION, warnings}
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(findings.map((finding) => formatFinding(finding)).join(''))
    process.stdout.write(`${errors} errors, ${warnings} warnings\n`)
  }

  // Not an exception: the findings are the result, so stdout must stay exactly what was printed above.
  process.exitCode = errors > 0 || (flags.strict && warnings > 0) ? EXIT_USAGE : EXIT_OK
}
