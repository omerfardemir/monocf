import {join} from 'node:path'
import {
  EnvironmentService,
  ErrorService,
  FileService,
  LogService,
  ServiceBindingService,
  WranglerService,
} from '../../services/index.js'
import {DevCommandParams, isDevCommandParams} from '../../types/command-types.js'
import {WorkerCommandExecutor} from './worker-command-executor.js'
import {WorkerService} from '../../services/worker-service.js'
import {parse} from 'jsonc-parser'
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {Unstable_RawConfig} from 'wrangler'
import {MONOCF_FOLDER} from '../../types/config-types.js'
import {getRoutePrefix} from '../../utils/string.js'

/**
 * Command executor for the dev command
 */
export class DevCommand implements WorkerCommandExecutor {
  private errorService: ErrorService
  private fileService: FileService
  private wranglerService: WranglerService
  private logService: LogService
  private workerService: WorkerService
  private readonly BASE_PORT = 9001

  /**
   * Creates a new DevCommand
   * @param serviceBindingService Service binding service
   * @param errorService Error service
   * @param fileService File service
   * @param wranglerService Wrangler service
   * @param environmentService Environment service
   * @param logService Log service
   */
  // eslint-disable-next-line max-params
  constructor(
    serviceBindingService: ServiceBindingService,
    errorService: ErrorService,
    fileService: FileService,
    wranglerService: WranglerService,
    environmentService: EnvironmentService,
    logService: LogService,
  ) {
    this.errorService = errorService
    this.fileService = fileService
    this.wranglerService = wranglerService
    this.logService = logService
    this.workerService = new WorkerService(fileService, logService, environmentService, serviceBindingService)
  }

  /**
   * Executes the dev command
   * @param workerName Worker name
   * @param params Command parameters
   * @returns Promise that resolves when the command completes successfully
   */
  async execute(workerName: string, params: DevCommandParams): Promise<void> {
    this.logService.log('MonoCF dev command starting...')

    if (!isDevCommandParams(params)) {
      this.errorService.throwConfigurationError('Invalid command parameters for dev command')
    }

    if (this.fileService.isIgnoredWorker(workerName)) {
      this.logService.log(`Worker ${workerName} is ignored, skipping`)
      return
    }

    if (params.multiWorker) {
        return this.executeMultiWorker(params)
      }

      const workerConfigPath = this.workerService.initializeWorker(workerName, params)

      if (!workerConfigPath) {
        return
      }

      // Run wrangler command
      return this.wranglerService.execWorkerCommand(
        'dev',
        [
          workerConfigPath.tempWranglerConfigPath,
          ...new Set(workerConfigPath.serviceBindingPaths.flatMap((serviceBindingPath) => serviceBindingPath.path)),
        ],
        params.env,
      )
  }

  async executeMultiWorker(params: DevCommandParams): Promise<void> {
    const workers = this.fileService.getWorkers(params.rootDir, params.workersDirName)
    const workersConfigPaths = workers
      .filter((workerName) => !this.fileService.isIgnoredWorker(workerName))
      .map((workerName) => this.workerService.initializeWorker(workerName, params))
      .filter((s) => s !== undefined)

    const monocfFolder = join(params.rootDir, MONOCF_FOLDER)
    if (!existsSync(monocfFolder)) {
      mkdirSync(monocfFolder)
    }

    const proxyMap: Record<string, number> = {}

    for (const [index, workerConfigPath] of workersConfigPaths.entries()) {
      const config: Unstable_RawConfig = parse(readFileSync(workerConfigPath.tempWranglerConfigPath, 'utf8'))
      const port = config.dev?.port ?? this.BASE_PORT + index
      const args = [
        'dev',
        `--inspector-port ${9230 + index}`,
        `--port ${port}`,
        `--persist-to ${monocfFolder}/local-storage/${config.name}`,
        `--config ${workerConfigPath.tempWranglerConfigPath}`,
      ]

      if (params.env) {
        args.push('--env', params.env)
      }

      // Populate proxyMap using the route defined in the worker's wrangler config
      const prefix = getRoutePrefix(config) ?? `/${workerConfigPath.workerName}`
      proxyMap[prefix] = port

      this.wranglerService.executeHiddenCommand(args)
      continue
    }

    // Write proxy worker source file into .monocf folder
    const proxyWorkerName = 'proxy-worker'
    const proxyWorkerPath = join(monocfFolder, proxyWorkerName)
    const proxySrcDir = join(proxyWorkerPath, 'src')
    if (!existsSync(proxyWorkerPath)) mkdirSync(proxyWorkerPath, {recursive: true})
    if (!existsSync(proxySrcDir)) mkdirSync(proxySrcDir, {recursive: true})
    const proxyIndexPath = join(proxySrcDir, 'index.ts')
    const proxyHandler = `export default {
  async fetch(request, env, ctx) {
    const map = ${JSON.stringify(proxyMap, null, 2)}
    const url = new URL(request.url);
    const pathname = url.pathname;
    const match = Object.keys(map).find(p => pathname.startsWith(p));
    if (!match) return new Response('Not found', { status: 404 });
    const targetPort = map[match];
    const targetUrl = new URL(request.url);
    targetUrl.port = String(targetPort);
    const proxied = new Request(targetUrl.toString(), request);
    return fetch(proxied);
  },
};`
    writeFileSync(proxyIndexPath, proxyHandler)

    // Write proxy worker wrangler.jsonc
    const proxyPort = params.port ?? 8787
    const proxyConfigPath = join(proxyWorkerPath, 'wrangler.jsonc')
    const proxyConfig = `{
  "name": "${proxyWorkerName}",
  "compatibility_date": "2025-01-09",
  "main": "./src/index.ts",
  "dev": {
    "port": ${proxyPort}
  }
}`
    writeFileSync(proxyConfigPath, proxyConfig)

    // Add proxy worker to the list of workers to run
    const proxyArgs = [
      'dev',
      `--inspector-port ${9230 + workersConfigPaths.length}`,
      `--port ${proxyPort}`,
      `--persist-to ${monocfFolder}/${proxyWorkerName}`,
      `--config ${proxyConfigPath}`,
    ]

    return this.wranglerService.executeWranglerCommand(proxyArgs)
  }
}
