import {join} from 'node:path'

import {CONFIG_FILE, nodeReader, parseJsonc, type FileReader} from '../project/load.js'
import type {Options} from '../project/options.js'
import {discoverWorkers, WORKER_CONFIG_FILE, workerPath} from '../project/workers.js'
import {applyPatch, mergeConfig} from './merge.js'
import {findUnknownPlaceholders, substituteConfig} from './substitute.js'
import {
  ConfigError,
  isPlainObject,
  type BindingSource,
  type BindingTarget,
  type Notice,
  type RawConfig,
  type ResolvedBinding,
  type ResolvedWorker,
} from './types.js'
import {validateList, validateName, validateTargetName} from './validate.js'

const FALLBACK_VERSION = '0.0.0'

export interface RawWorker {
  config: RawConfig
  configPath: string
  dir: string
  /** Undefined when the worker has no package.json. */
  packageJson?: {path: string; version?: unknown}
  path: string
}

export interface WorkerFailure {
  dir: string
  error: ConfigError
}

export interface ProjectInputs {
  base?: {config: RawConfig; path: string}
  /** Workers whose files could not be read. A failure stops only runs that need that worker. */
  failures: WorkerFailure[]
  workers: RawWorker[]
}

export interface ResolvedProject {
  failures: WorkerFailure[]
  notices: Notice[]
  workers: ResolvedWorker[]
}

function parseConfigObject(text: string, file: string): RawConfig {
  const config = parseJsonc(text, file)
  if (!isPlainObject(config)) throw new ConfigError('The config must be an object.', file)
  return config
}

function readPackageJson(dir: string, reader: FileReader): RawWorker['packageJson'] {
  const path = join(dir, 'package.json')
  if (!reader.exists(path)) return undefined
  try {
    const {version} = JSON.parse(reader.readFile(path)) as {version?: unknown}
    return {path, version}
  } catch (error) {
    throw new ConfigError(`Invalid package.json: ${(error as Error).message}`, path)
  }
}

function readWorker(options: Options, dir: string, reader: FileReader): RawWorker {
  const path = workerPath(options, dir)
  const configPath = join(path, WORKER_CONFIG_FILE)
  return {
    config: parseConfigObject(reader.readFile(configPath), configPath),
    configPath,
    dir,
    packageJson: readPackageJson(path, reader),
    path,
  }
}

function asFailure(dir: string, error: unknown): WorkerFailure {
  if (error instanceof ConfigError) return {dir, error}
  throw error
}

/** Reads every file resolution needs, once. A broken base config stops everything; a broken worker doesn't. */
export function readProjectInputs(options: Options, reader: FileReader = nodeReader): ProjectInputs {
  const inputs: ProjectInputs = {failures: [], workers: []}
  const {baseConfigPath} = options
  if (baseConfigPath) {
    if (!reader.exists(baseConfigPath)) throw new ConfigError('The base config does not exist.', baseConfigPath)
    inputs.base = {config: parseConfigObject(reader.readFile(baseConfigPath), baseConfigPath), path: baseConfigPath}
  }

  for (const dir of discoverWorkers(options, reader)) {
    try {
      inputs.workers.push(readWorker(options, dir, reader))
    } catch (error) {
      inputs.failures.push(asFailure(dir, error))
    }
  }

  return inputs
}

/** The part of a config wrangler reads bindings from: they don't inherit, so an env uses its own section only. */
export function envSection(config: RawConfig, env?: string): RawConfig {
  if (!env) return config
  const section = isPlainObject(config.env) ? config.env[env] : undefined
  return isPlainObject(section) ? section : {}
}

/** Replaces every character a worker name can't hold with a dash. Uppercase letters aren't lowercased. */
export function sanitizeWorkerName(name: string): string {
  return name.replaceAll(/[^a-z0-9-]/g, '-')
}

function placeholderSource(placeholder: string, raw: RawWorker, inputs: ProjectInputs): string {
  if (JSON.stringify(raw.config).includes(placeholder)) return raw.configPath
  if (inputs.base && JSON.stringify(inputs.base.config).includes(placeholder)) return inputs.base.path
  return CONFIG_FILE
}

function mergeAndSubstitute(raw: RawWorker, inputs: ProjectInputs, options: Options): RawConfig {
  // Without a base config, the old flow never expanded {workerName}, so it stays unknown here.
  const merged = inputs.base
    ? substituteConfig(mergeConfig(inputs.base.config, raw.config, raw.configPath), {workerName: raw.dir})
    : structuredClone(raw.config)
  const config = substituteConfig(merged, options.variables)

  const [unknown] = findUnknownPlaceholders(config, Object.keys(options.variables))
  if (unknown) {
    throw new ConfigError(
      `Unknown placeholder ${unknown}. Define it under "variables" in ${CONFIG_FILE}. To keep it literal, map it to itself there.`,
      placeholderSource(unknown, raw, inputs),
    )
  }

  return config
}

function injectVars(config: RawConfig, raw: RawWorker, name: string, env: string | undefined): Notice[] {
  const notices: Notice[] = []
  let version: unknown = FALLBACK_VERSION
  if (raw.packageJson) {
    version = raw.packageJson.version
    if (version === undefined) {
      notices.push({
        file: raw.packageJson.path,
        message: `package.json of ${raw.dir} has no version, so VERSION is not set.`,
        type: 'missing-version',
        worker: raw.dir,
      })
    }
  } else {
    const file = join(raw.path, 'package.json')
    notices.push({
      file,
      message: `${raw.dir} has no package.json, so VERSION is ${FALLBACK_VERSION}.`,
      type: 'missing-package-json',
      worker: raw.dir,
    })
  }

  const injected: RawConfig = {ENVIRONMENT: env ?? 'dev', NAME: name, VERSION: version}
  const own = envSection(raw.config, env).vars
  const explicit = (key: string) => isPlainObject(own) && Object.hasOwn(own, key)
  const vars = Object.fromEntries(Object.entries(injected).filter(([key, value]) => value !== undefined && !explicit(key)))
  applyPatch(config, env ? {env: {[env]: {vars}}} : {vars}, raw.configPath)

  const finalVars = envSection(config, env).vars as RawConfig
  // Deployed with --var at deploy time, so a new commit with an unchanged bundle keeps its fingerprint.
  delete finalVars.RELEASE
  if (version === undefined && !explicit('VERSION')) delete finalVars.VERSION
  return notices
}

interface PreparedWorker {
  config: RawConfig
  name: string
  notices: Notice[]
  raw: RawWorker
}

function prepareWorker(raw: RawWorker, inputs: ProjectInputs, options: Options): PreparedWorker {
  const {env} = options
  const config = mergeAndSubstitute(raw, inputs, options)
  const name = sanitizeWorkerName(validateName(config, raw.configPath))
  config.name = name
  if (env) applyPatch(config, {env: {[env]: {name: `${name}-${env}`}}}, raw.configPath)
  const notices = injectVars(config, raw, name, env)
  return {config, name, notices, raw}
}

function deployedNameOf(name: string, env?: string): string {
  return env ? `${name}-${env}` : name
}

type NameOwner = {dir: string; env?: string}

/** Indexes the names local workers deploy under. The selected env comes first, so it wins over any other. */
function indexDeployedNames(prepared: PreparedWorker[], env?: string): Map<string, NameOwner> {
  const owners = new Map<string, NameOwner>()
  const add = (name: string, owner: NameOwner) => {
    if (!owners.has(name)) owners.set(name, owner)
  }

  for (const {name, raw} of prepared) add(deployedNameOf(name, env), {dir: raw.dir, env})
  for (const {config, name, raw} of prepared) {
    add(name, {dir: raw.dir})
    for (const other of Object.keys(isPlainObject(config.env) ? config.env : {})) {
      add(`${name}-${other}`, {dir: raw.dir, env: other})
    }
  }

  return owners
}

interface TargetContext {
  env?: string
  failed: Set<string>
  owners: Map<string, NameOwner>
  prepared: Map<string, PreparedWorker>
  worker: string
}

function resolveTarget(
  {binding, name, source}: {binding: string; name: string; source: BindingSource},
  context: TargetContext,
  notices: Notice[],
): BindingTarget {
  const {env, failed, owners, prepared, worker} = context
  // Only a service binding needs its target's name. The other fields pass through, so they don't depend on it.
  if (source === 'services' && failed.has(name)) {
    throw new ConfigError(`Binding ${binding} targets worker ${name}, which could not be resolved.`)
  }

  if (prepared.has(name)) return {dir: name, kind: 'local'}

  const owner = owners.get(name)
  if (!owner) {
    notices.push({
      binding,
      message: `${worker}: ${binding} targets ${name}, which matches no local worker, so it passes through as external.`,
      name,
      source,
      type: 'external-binding',
      worker,
    })
    return {kind: 'external', name}
  }

  // Only service bindings get rewritten, so elsewhere a directory name would reach wrangler as it is.
  const advice = source === 'services' ? ' Use the directory name instead.' : ''
  notices.push({
    binding,
    message: `${worker}: ${binding} hardcodes ${name}, the deployed name of ${owner.dir}${owner.env ? ` in ${owner.env}` : ''}.${advice}`,
    name,
    source,
    targetDir: owner.dir,
    targetEnv: owner.env,
    type: 'hardcoded-name',
    worker,
  })
  return owner.env === env ? {dir: owner.dir, kind: 'local'} : {kind: 'external', name}
}

function resolveServices(
  section: RawConfig,
  file: string,
  context: TargetContext,
  notices: Notice[],
): ResolvedBinding[] {
  const {env, prepared} = context
  return validateList(section, 'services', file).flatMap((entry) => {
    const name = validateTargetName(entry, 'service', file)
    if (name === undefined) return []

    const binding = typeof entry.binding === 'string' ? entry.binding : name
    const target = resolveTarget({binding, name, source: 'services'}, context, notices)
    const owner = prepared.get(name)
    // A local target given by directory name becomes the name it deploys under. Anything else stays as written.
    if (owner) entry.service = sanitizeWorkerName(deployedNameOf(owner.name, env))
    return [
      {
        binding,
        ...(typeof entry.entrypoint === 'string' && {entrypoint: entry.entrypoint}),
        source: 'services' as const,
        target,
      },
    ]
  })
}

function resolveReferences(
  section: RawConfig,
  file: string,
  context: TargetContext,
  notices: Notice[],
): ResolvedBinding[] {
  const durableObjects = isPlainObject(section.durable_objects) ? section.durable_objects : {}
  const sources: [BindingSource, RawConfig[], string, string][] = [
    ['durable_objects', validateList(durableObjects, 'bindings', file), 'script_name', 'name'],
    ['tail_consumers', validateList(section, 'tail_consumers', file), 'service', 'service'],
    ['workflows', validateList(section, 'workflows', file), 'script_name', 'binding'],
  ]

  return sources.flatMap(([source, entries, targetField, bindingField]) =>
    entries.flatMap((entry) => {
      const name = validateTargetName(entry, targetField, file)
      if (name === undefined) return []
      const label = entry[bindingField]
      const binding = typeof label === 'string' ? label : name
      return [{binding, source, target: resolveTarget({binding, name, source}, context, notices)}]
    }),
  )
}

function finishWorker(worker: PreparedWorker, context: TargetContext): {notices: Notice[]; resolved: ResolvedWorker} {
  const {config, name, raw} = worker
  const {env} = context
  const notices = [...worker.notices]
  const section = envSection(config, env)
  const bindings = [
    ...resolveServices(section, raw.configPath, context, notices),
    ...resolveReferences(section, raw.configPath, context, notices),
  ]

  return {
    notices,
    resolved: {
      bindings,
      config,
      deployedName: deployedNameOf(name, env),
      dir: raw.dir,
      ...(env && {env}),
      path: raw.path,
    },
  }
}

/**
 * Turns raw inputs into what wrangler receives for options.env. Pure: it reads and writes nothing. Each worker
 * resolves once, so cost grows with the number of workers, not with the paths through the graph.
 * A worker that can't resolve goes into `failures`, because a run may not need it. validateSelection decides.
 */
export function resolveProject(options: Options, inputs: ProjectInputs): ResolvedProject {
  const {env} = options
  const failures = [...inputs.failures]
  const prepared = new Map<string, PreparedWorker>()
  for (const raw of inputs.workers) {
    try {
      prepared.set(raw.dir, prepareWorker(raw, inputs, options))
    } catch (error) {
      failures.push(asFailure(raw.dir, error))
    }
  }

  const failed = new Set(failures.map(({dir}) => dir))
  const owners = indexDeployedNames([...prepared.values()], env)
  const notices: Notice[] = []
  const workers: ResolvedWorker[] = []
  for (const worker of prepared.values()) {
    try {
      const finished = finishWorker(worker, {env, failed, owners, prepared, worker: worker.raw.dir})
      workers.push(finished.resolved)
      notices.push(...finished.notices)
    } catch (error) {
      failures.push(asFailure(worker.raw.dir, error))
    }
  }

  return {failures: failures.sort((a, b) => a.dir.localeCompare(b.dir)), notices, workers}
}
