import {join} from 'node:path'

import {effectiveField, envSection, type ProjectInputs, type ResolvedProject} from '../config/resolve.js'
import {isPlainObject, UnknownPlaceholderError, type Notice, type RawConfig, type ResolvedWorker} from '../config/types.js'
import {definedEnvs, isEnvMissing} from '../config/validate.js'
import {buildGraph, type Edge, type Graph} from '../graph/graph.js'
import {computeOrder} from '../graph/order.js'
import type {FileReader} from '../project/load.js'
import type {Options} from '../project/options.js'
import {IGNORE_FILE, matchesDirectory, readIgnoreLines, unknownEnvProblems} from '../project/workers.js'

export type FindingLevel = 'error' | 'warning'

export interface Finding {
  env?: string
  level: FindingLevel
  message: string
  rule: string
  worker?: string
}

export interface CheckContext {
  /** Every directory in the workers directory, with a config or not. */
  directories: string[]
  env?: string
  ignored: string[]
  inputs: ProjectInputs
  options: Options
  project: ResolvedProject
  reader: FileReader
  selected: string[]
}

type Rule = (context: CheckContext) => Omit<Finding, 'env'>[]

/** From wrangler's checkWorkerNameValidity. */
const MAX_NAME_LENGTH = 63
const VALID_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** The fields wrangler's validateBindingsHaveUniqueNames compares, as of 4.151. */
const BINDING_FIELDS = [
  'agent_memory',
  'ai',
  'ai_search',
  'ai_search_namespaces',
  'analytics',
  'analytics_engine_datasets',
  'artifacts',
  'assets',
  'browser',
  'd1_databases',
  'data_blobs',
  'dispatch_namespaces',
  'durable_objects',
  'flagship',
  'hyperdrive',
  'images',
  'k2',
  'kv_namespaces',
  'logfwdr',
  'media',
  'mtls_certificates',
  'pipelines',
  'r2_buckets',
  'ratelimits',
  'secrets_store_secrets',
  'send_email',
  'services',
  'stream',
  'text_blobs',
  'unsafe',
  'unsafe_hello_world',
  'vars',
  'vectorize',
  'version_metadata',
  'vpc_networks',
  'vpc_services',
  'wasm_modules',
  'worker_loaders',
  'workflows',
] as const

function selectedWorkers({project, selected}: CheckContext): ResolvedWorker[] {
  return project.workers.filter(({dir}) => selected.includes(dir))
}

function selectedNotices<T extends Notice['type']>({project, selected}: CheckContext, type: T) {
  return project.notices.filter(
    (notice): notice is Extract<Notice, {type: T}> => notice.type === type && selected.includes(notice.worker),
  )
}

function selectedGraph(context: CheckContext): Graph {
  return buildGraph(selectedWorkers(context))
}

/** The way round a cycle from its first member and back, following only the given edges. */
function cyclePath(members: string[], edges: Edge[]): string[] {
  const [start] = members
  const inside = new Set(members)
  const seen = new Set<string>()
  const walk = (node: string): string[] | undefined => {
    for (const {from, to} of edges) {
      if (from === node && inside.has(to)) {
        if (to === start) return [node, start]
        if (!seen.has(to)) {
          seen.add(to)
          const rest = walk(to)
          if (rest) return [node, ...rest]
        }
      }
    }

    return undefined
  }

  return walk(start) ?? members
}

function multiMemberCycles(graph: Graph): string[][] {
  return computeOrder(graph).cycles.filter((cycle) => cycle.length > 1)
}

function cycleFinding(members: string[], edges: Edge[], level: FindingLevel, note: string) {
  return {
    level,
    message: `Binding cycle${note}: ${cyclePath(members, edges).join(' -> ')}`,
    rule: 'cycle',
    worker: members[0],
  }
}

/**
 * A cycle of bindings is an error. A queue edge is only a logical order, and two workers can send to each other's
 * queues with no trouble at deploy time, so a cycle that needs a queue edge to close is a warning.
 */
const cycle: Rule = (context) => {
  const graph = selectedGraph(context)
  const direct = {...graph, edges: graph.edges.filter(({kind}) => kind !== 'queues')}
  const hard = multiMemberCycles(direct)
  const hardMembers = new Set(hard.flat())
  return [
    ...hard.map((members) => cycleFinding(members, direct.edges, 'error', '')),
    ...multiMemberCycles(graph)
      .filter((members) => !members.some((member) => hardMembers.has(member)))
      .map((members) => cycleFinding(members, graph.edges, 'warning', ' through a queue')),
  ]
}

const selfBinding: Rule = (context) =>
  selectedGraph(context)
    .edges.filter(({from, kind, to}) => from === to && kind !== 'queues')
    .map(({from, kind, via}) => ({
      level: 'warning' as const,
      message: `${from} binds to itself through ${kind} ${via}. It adds no ordering, and a first deploy of such a worker fails on Cloudflare.`,
      rule: 'self-binding',
      worker: from,
    }))

const missingEnv: Rule = ({env, inputs, options, selected}) =>
  selected
    .filter((dir) => isEnvMissing(dir, options, inputs))
    .map((worker) => ({level: 'error', message: `${worker} does not define the env ${env}.`, rule: 'missing-env', worker}))

const ignoredDependency: Rule = ({env, ignored, options, project, reader, selected}) => {
  const edges = buildGraph(project.workers).edges.filter(({from, kind, to}) => selected.includes(from) && ignored.includes(to) && kind !== 'queues')
  if (edges.length === 0) return []
  // Only a scope makes this depend on the env. A file with none reads as it always has.
  const scoped = env !== undefined && readIgnoreLines(options, reader).some(({scope}) => scope !== undefined)
  return edges.map(({from, kind, to, via}) => ({
    level: 'error',
    message: `${from} has a binding to ${to} through ${kind} ${via}, and ${to} is ${scoped ? `ignored in ${env} by` : 'in'} ${IGNORE_FILE}.`,
    rule: 'ignored-dependency',
    worker: from,
  }))
}

const hardcodedBinding: Rule = (context) =>
  selectedNotices(context, 'hardcoded-name')
    .filter(({source, targetEnv}) => source === 'services' && targetEnv === context.env)
    .map(({binding, name, targetDir, worker}) => ({
      level: 'error',
      message: `${worker}: service binding ${binding} hardcodes ${name}. Use the directory name ${targetDir}, which monocf rewrites for each env.`,
      rule: 'hardcoded-binding',
      worker,
    }))

const crossEnvBinding: Rule = (context) =>
  selectedNotices(context, 'hardcoded-name')
    .filter(({targetEnv}) => targetEnv !== context.env)
    .map(({binding, name, source, targetDir, targetEnv, worker}) => ({
      level: 'error',
      message: `${worker}: ${source} ${binding} targets ${name}, the deployed name of ${targetDir} ${targetEnv ? `in ${targetEnv}` : 'with no env'}.`,
      rule: 'cross-env-binding',
      worker,
    }))

function directoryRule(rule: string, sources: string[]): Rule {
  return (context) =>
    selectedNotices(context, 'directory-name')
      .filter(({source}) => sources.includes(source))
      .map(({message, worker}) => ({level: 'error', message, rule, worker}))
}

const scriptNameDirectory = directoryRule('script-name-directory', ['durable_objects', 'workflows'])

/** The outbound service of a dispatch namespace is the same kind of field, and fails the same way. */
const tailServiceDirectory = directoryRule('tail-service-directory', [
  'dispatch_namespaces',
  'streaming_tail_consumers',
  'tail_consumers',
])

const duplicateName: Rule = (context) => {
  const byName = new Map<string, string[]>()
  for (const {deployedName, dir} of context.project.workers) {
    byName.set(deployedName, [...(byName.get(deployedName) ?? []), dir])
  }

  return [...byName]
    .filter(([, dirs]) => dirs.length > 1 && dirs.some((dir) => context.selected.includes(dir)))
    .map(([name, dirs]) => ({
      level: 'error',
      message: `${dirs.join(' and ')} all deploy as ${name}, so each deploy overwrites the other.`,
      rule: 'duplicate-name',
      worker: dirs[0],
    }))
}

function routePatterns(config: RawConfig, env?: string): string[] {
  const routes = effectiveField(config, env, 'routes') ?? [effectiveField(config, env, 'route')]
  return (Array.isArray(routes) ? routes : []).flatMap((route: unknown) => {
    const pattern = isPlainObject(route) ? route.pattern : route
    return typeof pattern === 'string' ? [pattern] : []
  })
}

const duplicateRoute: Rule = (context) => {
  const owners = new Map<string, string[]>()
  for (const {config, dir, env} of selectedWorkers(context)) {
    for (const pattern of new Set(routePatterns(config, env))) owners.set(pattern, [...(owners.get(pattern) ?? []), dir])
  }

  return [...owners]
    .filter(([, dirs]) => dirs.length > 1)
    .map(([pattern, dirs]) => ({
      level: 'error',
      message: `${dirs.join(' and ')} claim the route ${pattern}.`,
      rule: 'duplicate-route',
      worker: dirs[0],
    }))
}

const resolveFailures: Rule = ({project, selected}) =>
  project.failures
    .filter(({dir}) => selected.includes(dir))
    .map(({dir, error}) => ({
      level: 'error',
      message: error.message,
      rule: error instanceof UnknownPlaceholderError ? 'unknown-placeholder' : 'resolve-failed',
      worker: dir,
    }))

const externalBinding: Rule = (context) =>
  selectedNotices(context, 'external-binding').map(({message, worker}) => ({
    level: 'warning',
    message,
    rule: 'external-binding',
    worker,
  }))

const ignoredStale: Rule = ({directories, options, reader}) =>
  readIgnoreLines(options, reader)
    .filter(({problem, text}) => problem === undefined && text.trim() !== '' && !text.trim().startsWith('#'))
    .filter((line) => !matchesDirectory(line, options, directories))
    .map(({text}) => ({
      level: 'warning',
      message: `The ${IGNORE_FILE} line "${text.trim()}" matches no directory.`,
      rule: 'ignored-stale',
    }))

/** A line nothing can read would leave a worker in or out by accident, so it never counts as a pattern. */
const ignoredMalformed: Rule = ({options, reader}) =>
  readIgnoreLines(options, reader).flatMap(({problem}) => (problem === undefined ? [] : [{level: 'error' as const, message: problem, rule: 'ignored-malformed'}]))

/** Without this, `except produciton` keeps a worker out of production and nothing says so. */
const ignoredUnknownEnv: Rule = ({inputs, options, reader}) =>
  unknownEnvProblems(readIgnoreLines(options, reader), () => definedEnvs(inputs, options)).map((message) => ({level: 'error', message, rule: 'ignored-unknown-env'}))

function effectiveBuildCommand(config: RawConfig, env?: string): unknown {
  const build = effectiveField(config, env, 'build')
  return isPlainObject(build) ? build.command : undefined
}

const missingMain: Rule = (context) =>
  selectedWorkers(context).flatMap(({config, dir, env, path}) => {
    // The build runs before wrangler looks for main, and it isn't run here, so a generated entry can't be there yet.
    if (effectiveBuildCommand(config, env) !== undefined) return []
    const main = effectiveField(config, env, 'main')
    if (typeof main === 'string') {
      return context.reader.exists(join(path, main))
        ? []
        : [{level: 'error' as const, message: `${dir}: the main file ${main} does not exist.`, rule: 'missing-main', worker: dir}]
    }

    return effectiveField(config, env, 'assets') === undefined && effectiveField(config, env, 'site') === undefined
      ? [{level: 'error' as const, message: `${dir} has no main file, no assets and no site.`, rule: 'missing-main', worker: dir}]
      : []
  })

const nameLength: Rule = (context) =>
  selectedWorkers(context).flatMap(({deployedName, dir}) => [
    ...(deployedName.length > MAX_NAME_LENGTH
      ? [{level: 'error' as const, message: `${dir}: ${deployedName} is ${deployedName.length} characters long, over the limit of ${MAX_NAME_LENGTH}.`, rule: 'name-length', worker: dir}]
      : []),
    ...(VALID_NAME.test(deployedName)
      ? []
      : [{level: 'error' as const, message: `${dir}: ${deployedName} may hold only lowercase letters, digits and inner dashes.`, rule: 'name-length', worker: dir}]),
  ])

const noCompatDate: Rule = (context) =>
  selectedWorkers(context)
    .filter(({config, env}) => effectiveField(config, env, 'compatibility_date') === undefined)
    .map(({dir}) => ({level: 'warning', message: `${dir} has no compatibility_date.`, rule: 'no-compat-date', worker: dir}))

function bindingNames(field: string, value: unknown): string[] {
  const list = field === 'queues' && isPlainObject(value) ? value.producers : value
  if (Array.isArray(list)) {
    return list.flatMap((entry: unknown) =>
      isPlainObject(entry) && typeof entry.binding === 'string' ? [entry.binding] : [],
    )
  }

  if (!isPlainObject(list)) return []
  if (Array.isArray(list.bindings)) {
    return list.bindings.flatMap((entry: unknown) =>
      isPlainObject(entry) && typeof entry.name === 'string' ? [entry.name] : [],
    )
  }

  return typeof list.binding === 'string' ? [list.binding] : Object.keys(list)
}

const duplicateBindingName: Rule = (context) =>
  selectedWorkers(context).flatMap(({config, dir, env}) => {
    const section = envSection(config, env)
    const fields: RawConfig = {...section, assets: effectiveField(config, env, 'assets')}
    const names = [
      ...[...BINDING_FIELDS, 'queues'].flatMap((field) => bindingNames(field, fields[field])),
      ...(isPlainObject(section.secrets) && Array.isArray(section.secrets.required)
        ? section.secrets.required.filter((name): name is string => typeof name === 'string')
        : []),
    ]
    const repeated = new Set(names.filter((name, index) => names.indexOf(name) !== index))
    return [...repeated].map((name) => ({
      level: 'error' as const,
      message: `${dir} has more than one binding named ${name}, which wrangler rejects.`,
      rule: 'duplicate-binding-name',
      worker: dir,
    }))
  })

const RULES: Rule[] = [
  cycle,
  selfBinding,
  missingEnv,
  ignoredDependency,
  hardcodedBinding,
  crossEnvBinding,
  scriptNameDirectory,
  tailServiceDirectory,
  duplicateName,
  duplicateRoute,
  duplicateBindingName,
  resolveFailures,
  externalBinding,
  ignoredStale,
  ignoredMalformed,
  ignoredUnknownEnv,
  missingMain,
  nameLength,
  noCompatDate,
]

/** Runs every rule for one env. Pure, apart from what the reader looks at. */
export function runRules(context: CheckContext): Finding[] {
  return RULES.flatMap((rule) =>
    rule(context).map((finding) => ({
      ...finding,
      // A finding with no worker is about the project file, so it doesn't depend on the env.
      ...(finding.worker !== undefined && context.env !== undefined && {env: context.env}),
    })),
  )
}
