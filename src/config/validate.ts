import type {Options} from '../project/options.js'
import type {ProjectInputs, ResolvedProject} from './resolve.js'
import {substituteConfig} from './substitute.js'
import {ConfigError, isPlainObject, type RawConfig} from './types.js'

interface EnvSources {
  base?: RawConfig
  worker: RawConfig
}

/** An env is defined when the base or the worker declares it, even as an empty object. */
function isEnvDefined({base, worker}: EnvSources, env: string): boolean {
  return [base, worker].some((config) => isPlainObject(config?.env) && Object.hasOwn(config.env, env))
}

export function validateEnv(dir: string, sources: EnvSources, env?: string): void {
  if (env !== undefined && !isEnvDefined(sources, env)) {
    throw new ConfigError(
      `Unknown environment "${env}" for worker ${dir}. Define it under "env" in the base config or in the wrangler config of the worker.`,
    )
  }
}

/** Returns a config's name, which must be a non-empty string by the time placeholders are replaced. */
export function validateName(config: RawConfig, file: string): string {
  const {name} = config
  if (typeof name !== 'string' || name === '') {
    throw new ConfigError('The worker has no name. Set "name" in the base config or in the wrangler config.', file)
  }

  return name
}

/** Reads a list a binding field holds. Wrangler would reject another shape, but later and with less context. */
export function validateList(section: RawConfig, field: string, file: string): RawConfig[] {
  const list = section[field]
  if (list === undefined) return []
  if (!Array.isArray(list) || !list.every((entry) => isPlainObject(entry))) {
    throw new ConfigError(`"${field}" must be a list of objects.`, file)
  }

  return list
}

/** Reads a binding's target name. A non-string can't be matched to a worker, so it's reported here. */
export function validateTargetName(entry: RawConfig, field: string, file: string): string | undefined {
  const name = entry[field]
  if (name === undefined) return undefined
  if (typeof name !== 'string') throw new ConfigError(`"${field}" must be a string in every binding.`, file)
  return name
}

/** Throws when any of these workers could not be resolved. */
export function assertResolved(workers: string[], project: ResolvedProject): void {
  for (const dir of workers) {
    const failure = project.failures.find((candidate) => candidate.dir === dir)
    if (failure) throw failure.error
  }
}

/** The env keys as the resolver sees them: a key can hold a placeholder too. */
function resolvedEnvKeys(config: RawConfig | undefined, variables: Record<string, string>): RawConfig {
  return substituteConfig({env: config?.env}, variables)
}

/** Stops a run whose selected workers can't be resolved, or don't define the env. */
export function validateSelection(
  selected: string[],
  options: Options,
  inputs: ProjectInputs,
  project: ResolvedProject,
): void {
  assertResolved(selected, project)
  for (const dir of selected) {
    const raw = inputs.workers.find((candidate) => candidate.dir === dir)
    if (raw) {
      const variables = {workerName: raw.dir, ...options.variables}
      const sources = {
        base: resolvedEnvKeys(inputs.base?.config, variables),
        worker: resolvedEnvKeys(raw.config, variables),
      }
      validateEnv(dir, sources, options.env)
    }
  }
}
