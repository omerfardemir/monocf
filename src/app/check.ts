import {join} from 'node:path'

import {crossEnvRoutes, runRules, type CheckContext, type Finding} from '../check/rules.js'
import {readProjectInputs, resolveProject, type ProjectInputs} from '../config/resolve.js'
import {definedEnvs} from '../config/validate.js'
import {EXIT_OK, EXIT_USAGE} from '../errors.js'
import {nodeReader} from '../project/load.js'
import type {OptionFlags, Options} from '../project/options.js'
import {SCHEMA_VERSION} from '../report/events.js'
import {loadOptions, selectPerEnv} from './project.js'

export interface CheckFlags extends OptionFlags {
  allEnvs?: boolean
  json?: boolean
  strict?: boolean
}

/** A project with no env is checked with no env. */
function allEnvs(inputs: ProjectInputs, options: Options): (string | undefined)[] {
  const names = definedEnvs(inputs, options)
  return names.length > 0 ? names : [undefined]
}

function formatFinding({env, level, message, rule}: Finding): string {
  return `${level} ${rule}${env ? ` [${env}]` : ''}: ${message}\n`
}

/** `monocf check`: finds what would go wrong without running anything. It needs no wrangler and no credentials. */
export function runCheck(flags: CheckFlags): void {
  const options = loadOptions(flags)
  const inputs = readProjectInputs(options)
  const envs = flags.allEnvs ? allEnvs(inputs, options) : [options.env]
  const selections = selectPerEnv(options, envs)
  const directories = nodeReader.readDir(join(options.rootDir, options.workersDirName))

  const contexts: CheckContext[] = selections.map(({env, ignored, selected}) => {
    const envOptions = {...options, env}
    return {directories, env, ignored, inputs, options: envOptions, project: resolveProject(envOptions, inputs), reader: nodeReader, selected}
  })
  const crossEnv = crossEnvRoutes(contexts)
  // The error names every env, so the warning each env gives on its own would only repeat it.
  const covered = new Set(crossEnv.map(({worker}) => worker))
  const seen = new Set<string>()
  const findings = [...contexts.flatMap((context) => runRules(context)), ...crossEnv]
    .filter((finding) => !(finding.rule === 'inherited-route' && covered.has(finding.worker)))
    .filter((finding) => {
      const key = JSON.stringify(finding)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  const count = (level: Finding['level']) => findings.filter((finding) => finding.level === level).length
  const [errors, warnings, notes] = [count('error'), count('warning'), count('note')]
  if (flags.json) {
    const result = {envs: envs.map((env) => env ?? null), errors, findings, notes, schemaVersion: SCHEMA_VERSION, warnings}
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(findings.map((finding) => formatFinding(finding)).join(''))
    process.stdout.write(`${errors} errors, ${warnings} warnings${notes > 0 ? `, ${notes} notes` : ''}\n`)
  }

  // Not an exception: the findings are the result, so stdout must stay exactly what was printed above.
  process.exitCode = errors > 0 || (flags.strict && warnings > 0) ? EXIT_USAGE : EXIT_OK
}
