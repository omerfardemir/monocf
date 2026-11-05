import {cpus} from 'node:os'
import {join} from 'node:path'

import {readProjectInputs, resolveProject, type ResolvedProject} from '../config/resolve.js'
import {ConfigError, isPlainObject, type ResolvedWorker} from '../config/types.js'
import {assertResolved, validateSelection} from '../config/validate.js'
import {EXIT_FAILED, MonocfError} from '../errors.js'
import {buildGraph} from '../graph/graph.js'
import {computeOrder, dependenciesWithin, serviceClosure} from '../graph/order.js'
import type {OptionFlags, Options} from '../project/options.js'
import {materialiseProxy, PROXY_WORKER, routePrefix} from '../runtime/dev-proxy.js'
import {materialiseConfig, writeDevVars, writeSecretsFile} from '../runtime/materialise.js'
import {readLocalVars, readSecrets, requireSecretsFile} from '../runtime/secrets.js'
import {buildArgv, type ArgvOptions} from '../wrangler/argv.js'
import {locateWrangler} from '../wrangler/locate.js'
import {spawnWrangler} from '../wrangler/process.js'
import {loadOptions, resolveRelease, selectFromArguments, type Selection} from './project.js'
import {aloneMode, failureOf, isSuccess, reportStep, runStep, runWorkerSteps, withRun, type RunContext} from './run.js'

export type WorkerAction = 'build' | 'deploy' | 'dev' | 'preview'

export interface WorkerFlags extends OptionFlags {
  command: WorkerAction
  concurrency?: number
  json?: boolean
}

const BASE_WORKER_PORT = 9001
const BASE_INSPECTOR_PORT = 9230
const MAX_BUILD_CONCURRENCY = 8

/** The optional flags each command acts on. Anything else is rejected instead of being dropped. */
const FLAGS_BY_ACTION: Record<WorkerAction, (keyof WorkerFlags)[]> = {
  build: ['concurrency', 'minify'],
  deploy: ['concurrency', 'deployBindings', 'deployFromVersionId', 'deploySecrets', 'fromVersion', 'message', 'minify'],
  dev: ['port'],
  preview: ['concurrency', 'deployBindings', 'deploySecrets', 'message', 'minify'],
}

const CHECKED_FLAGS: (keyof WorkerFlags)[] = [
  'concurrency',
  'deployBindings',
  'deployFromVersionId',
  'deploySecrets',
  'fromVersion',
  'message',
  'minify',
  'port',
]

function validateFlags(flags: WorkerFlags): void {
  if (flags.deployFromVersionId !== undefined && !flags.fromVersion) {
    throw new ConfigError('--deploy-from-version-id requires --from-version')
  }

  for (const flag of CHECKED_FLAGS) {
    if (flags[flag] !== undefined && !FLAGS_BY_ACTION[flags.command].includes(flag)) {
      const name = flag.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      throw new ConfigError(`--${name} is not supported by the ${flags.command} command`)
    }
  }

  if (flags.fromVersion) {
    if (flags.all || flags.deployBindings) {
      throw new ConfigError(
        'Deploying from a version works for one named worker. It cannot be combined with --all or with --deploy-bindings.',
      )
    }

    if (flags.concurrency !== undefined) {
      throw new ConfigError('--concurrency has no effect with --from-version, which runs for one worker')
    }

    if (flags.minify) throw new ConfigError('--minify has no effect with --from-version, which uploads nothing')
    if (flags.deploySecrets) {
      throw new ConfigError('--deploy-secrets has no effect with --from-version, which uploads nothing')
    }
  }
}

/** One process per worker is mostly waiting on esbuild, so this tracks the CPU count, up to a limit. */
export function defaultBuildConcurrency(): number {
  return Math.min(cpus().length, MAX_BUILD_CONCURRENCY)
}

interface WorkerPlan {
  /** Bindings left out because they're ignored. */
  ignoredBindings: string[]
  /** Every worker that gets a wrangler call of its own, in order. */
  order: string[]
  uploadSecrets: boolean
}

interface PlanInputs {
  flags: WorkerFlags
  inputs: ReturnType<typeof readProjectInputs>
  options: Options
  project: ResolvedProject
  selection: Selection
}

function followsBindings({command, deployBindings, fromVersion}: WorkerFlags, options: Options): boolean {
  if (command === 'deploy') return !fromVersion && options.deployBindings
  return command === 'preview' && deployBindings === true
}

function byLevel(project: ResolvedProject, workers: string[]): string[] {
  const members = new Set(workers)
  return computeOrder(buildGraph(project.workers))
    .levels.flat()
    .filter((dir) => members.has(dir))
}

/** Dependencies first by graph level, without recursion. A cycle's members share a level, in a stable order. */
function planOrder({flags, options, project, selection}: PlanInputs): Pick<WorkerPlan, 'ignoredBindings' | 'order'> {
  if (flags.command !== 'deploy' && flags.command !== 'preview') return {ignoredBindings: [], order: selection.selected}

  if (!followsBindings(flags, options)) return {ignoredBindings: [], order: byLevel(project, selection.selected)}

  const {reached, skipped, unresolved} = serviceClosure(project.workers, selection.selected, selection.ignored)
  assertResolved(unresolved, project)
  return {ignoredBindings: skipped, order: byLevel(project, [...selection.selected, ...reached])}
}

function bindingNotices(project: ResolvedProject, workers: string[]): {message: string; worker: string}[] {
  return project.notices
    .filter(({worker}) => workers.includes(worker))
    .map(({message, worker}) => ({message, worker}))
}

function byDir(project: ResolvedProject, dir: string): ResolvedWorker {
  const worker = project.workers.find((candidate) => candidate.dir === dir)
  if (!worker) throw new ConfigError(`Worker ${dir} could not be resolved.`)
  return worker
}

/** A build reads no other worker, so a failed one doesn't hold another back, and every failure gets reported. */
async function runBuild(
  context: RunContext,
  {concurrency, options, workers}: {concurrency: number; options: Options; workers: ResolvedWorker[]},
): Promise<void> {
  await runWorkerSteps(context, {
    action: 'build',
    concurrency,
    steps: workers.map((worker) => ({
      dependsOn: [],
      async run(mode) {
        await runStep(context, {
          argvOptions: {env: options.env, minify: options.minify},
          cwd: worker.path,
          mode,
          step: {
            action: 'build',
            configPath: materialiseConfig(worker, context.runDir),
            outdir: join(worker.path, 'dist'),
          },
          worker: worker.dir,
        })
      },
      worker: worker.dir,
    })),
  })
}

interface UploadRun {
  action: 'deploy' | 'preview'
  concurrency: number
  dependencies: Map<string, string[]>
  options: Options
  release: string
  uploadSecrets: boolean
  workers: ResolvedWorker[]
}

async function runUploads(context: RunContext, run: UploadRun) {
  const {action, concurrency, dependencies, options, release, uploadSecrets, workers} = run
  await runWorkerSteps(context, {
    action,
    concurrency,
    steps: workers.map((worker) => {
      const {dir, path} = worker
      return {
        dependsOn: dependencies.get(dir) ?? [],
        async run(mode) {
          const secrets = uploadSecrets ? readSecrets(path, options.rootDir, options.env) : {}
          const secretsFile = Object.keys(secrets).length > 0 ? writeSecretsFile(dir, secrets, context.runDir) : undefined
          const result = await runStep(context, {
            argvOptions: {env: options.env, message: options.message, minify: options.minify, release},
            cwd: path,
            mode,
            step: {action, configPath: materialiseConfig(worker, context.runDir), secretsFile},
            worker: dir,
          })
          return result.output.versionId
        },
        worker: dir,
      }
    }),
  })
}

function latestVersion(stdout: string, worker: string): string {
  let versions: unknown
  try {
    versions = JSON.parse(stdout)
  } catch (error) {
    throw new MonocfError(`${worker}: wrangler versions list gave invalid JSON: ${(error as Error).message}`, EXIT_FAILED)
  }

  // The list is ascending, so the newest version comes last.
  const latest: unknown = Array.isArray(versions) ? versions.at(-1) : undefined
  if (!isPlainObject(latest) || typeof latest.id !== 'string') {
    throw new MonocfError(
      `${worker}: no versions found. Before deploying from a version, create one with "monocf worker ${worker} -c preview".`,
      EXIT_FAILED,
    )
  }

  return latest.id
}

async function runDeployFromVersion(context: RunContext, worker: ResolvedWorker, options: Options): Promise<void> {
  const {dir, path} = worker
  const configPath = materialiseConfig(worker, context.runDir)
  const shared = {cwd: path, mode: aloneMode(context, false), worker: dir}
  const argvOptions: ArgvOptions = {env: options.env, message: options.message}

  await reportStep(context, 'deploy', dir, async () => {
    let versionId = options.deployFromVersionId
    if (versionId === undefined) {
      const step = {action: 'versions-list', configPath} as const
      const {stdout} = await runStep(context, {...shared, argvOptions, mode: 'capture', step})
      versionId = latestVersion(stdout, dir)
    }

    await runStep(context, {...shared, argvOptions, step: {action: 'versions-deploy', configPath, versionId}})
    await runStep(context, {...shared, argvOptions, step: {action: 'triggers-deploy', configPath}})
    return versionId
  })
}

function writeWorkerVars(context: RunContext, worker: ResolvedWorker, options: Options): void {
  const values = readLocalVars(worker.path, options.rootDir, options.env)
  if (values) writeDevVars(worker.dir, values, context.runDir)
}

interface DevRun {
  dependencies: ResolvedWorker[]
  explicitPort?: number
  options: Options
  release: string
  worker: ResolvedWorker
}

/** One session with the worker first and every transitive binding after it. Local data stays in the worker's tree. */
async function runDev(context: RunContext, {dependencies, explicitPort, options, release, worker}: DevRun) {
  const workers = [worker, ...dependencies]
  const configPaths = workers.map((each) => {
    writeWorkerVars(context, each, options)
    return materialiseConfig(each, context.runDir)
  })
  await runStep(context, {
    argvOptions: {env: options.env, release},
    cwd: worker.path,
    mode: aloneMode(context, true),
    step: {action: 'dev', configPaths, persistTo: join(worker.path, '.wrangler', 'state'), port: explicitPort},
    worker: worker.dir,
  })
}

interface DevAllRun {
  options: Options
  proxyPort: number
  release: string
  workers: ResolvedWorker[]
}

/**
 * A session per worker plus a proxy in front of them. Output is labelled per process. A child that ends with a failure
 * ends the rest, and a signal reaches them all through the handler.
 */
async function runDevAll(context: RunContext, {options, proxyPort, release, workers}: DevAllRun): Promise<void> {
  const {interrupts, runDir, wrangler} = context
  const proxyMap: Record<string, number> = {}
  const sessions = workers.map((worker, index) => {
    writeWorkerVars(context, worker, options)
    const dev = isPlainObject(worker.config.dev) ? worker.config.dev : {}
    const port = typeof dev.port === 'number' ? dev.port : BASE_WORKER_PORT + index
    proxyMap[routePrefix(worker.config, options.env) ?? `/${worker.dir}`] = port
    return {
      argv: buildArgv(
        {
          action: 'dev',
          configPaths: [materialiseConfig(worker, runDir)],
          inspectorPort: BASE_INSPECTOR_PORT + index,
          persistTo: join(options.rootDir, '.monocf', 'local-storage', String(worker.config.name)),
          port,
        },
        {env: options.env, release},
      ),
      cwd: worker.path,
      name: worker.dir,
    }
  })

  sessions.push({
    argv: buildArgv({
      action: 'dev',
      configPaths: [materialiseProxy(proxyMap, proxyPort, runDir)],
      inspectorPort: BASE_INSPECTOR_PORT + workers.length,
      persistTo: join(options.rootDir, '.monocf', 'local-storage', PROXY_WORKER),
      port: proxyPort,
    }),
    cwd: options.rootDir,
    name: PROXY_WORKER,
  })

  let failure: MonocfError | undefined
  await Promise.all(
    sessions.map(async ({argv, cwd, name}) => {
      interrupts.throwIfInterrupted()
      const running = spawnWrangler(wrangler, argv, {
        cwd,
        mode: {prefix: `[${name}] `},
        outputFile: runDir.outputFile(name),
      })
      interrupts.track(running.child)
      const result = await running.done
      if (!isSuccess(result) && !failure) {
        failure = failureOf(`${name}: `, 'dev', result)
        interrupts.stopAll()
      }
    }),
  )
  interrupts.throwIfInterrupted()
  if (failure) throw failure
}

/** Stops a run before any wrangler call if one of its workers can't take part. */
function validatePlan(plan: PlanInputs): WorkerPlan {
  const {flags, inputs, options, project, selection} = plan
  validateSelection(selection.selected, options, inputs, project)
  const {ignoredBindings, order} = planOrder(plan)
  validateSelection(order, options, inputs, project)

  const uploadSecrets = flags.command === 'preview' || (flags.command === 'deploy' && !flags.fromVersion)
  const secretsWanted = uploadSecrets && options.deploySecrets
  if (secretsWanted) {
    for (const dir of order) requireSecretsFile(byDir(project, dir).path, options.rootDir, options.env)
  }

  return {ignoredBindings, order, uploadSecrets: secretsWanted}
}

/** `monocf worker`: resolve, check, then run one action for the selected workers. */
export async function runWorker(name: string | undefined, flags: WorkerFlags): Promise<void> {
  validateFlags(flags)
  const options = loadOptions(flags)
  const selection = selectFromArguments(options, name)
  const inputs = readProjectInputs(options)
  const project = resolveProject(options, inputs)
  const {ignoredBindings, order, uploadSecrets} = validatePlan({flags, inputs, options, project, selection})
  const wrangler = locateWrangler(options.rootDir)
  const workers = order.map((dir) => byDir(project, dir))

  const notices: {message: string; worker?: string}[] = [
    ...bindingNotices(project, order),
    ...ignoredBindings.map((dir) => ({message: `Not following the binding to ${dir}: it is in .monocfignore.`})),
  ]
  const needsRelease = flags.command !== 'build' && !flags.fromVersion
  const release = needsRelease
    ? resolveRelease(options.rootDir, (message) => {
        notices.push({message})
      })
    : ''

  const devAll = flags.command === 'dev' && options.all
  await withRun(
    {
      action: flags.command,
      env: options.env,
      json: flags.json === true,
      notices,
      rootDir: options.rootDir,
      workers: order,
      wrangler,
    },
    async (context) => {
      switch (flags.command) {
        case 'build': {
          return runBuild(context, {concurrency: flags.concurrency ?? defaultBuildConcurrency(), options, workers})
        }

        case 'dev': {
          if (devAll) return runDevAll(context, {options, proxyPort: options.port, release, workers})
          const {reached, unresolved} = serviceClosure(project.workers, order)
          assertResolved(unresolved, project)
          return runDev(context, {
            dependencies: reached.map((dir) => byDir(project, dir)),
            explicitPort: flags.port,
            options,
            release,
            worker: workers[0],
          })
        }

        default: {
          if (flags.fromVersion) return runDeployFromVersion(context, workers[0], options)
          return runUploads(context, {
            action: flags.command,
            concurrency: flags.concurrency ?? 1,
            dependencies: dependenciesWithin(buildGraph(project.workers), order),
            options,
            release,
            uploadSecrets,
            workers,
          })
        }
      }
    },
  )
}
