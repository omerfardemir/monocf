import {ChildProcess, exec, spawn, StdioOptions} from 'node:child_process'
import {constants} from 'node:os'
import path, {join} from 'node:path'
import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs'
import {experimental_patchConfig, Unstable_RawConfig} from 'wrangler'
import {
  execEventListener,
  TEMP_BASE_WRANGLER_FILE,
  TEMP_WRANGLER_FILE,
  WRANGLER_FILE,
  WorkerCommand,
  WranglerError,
  WorkerVersion,
} from '../types/index.js'
import {ErrorService} from './error-service.js'
import {createSpinner} from 'nanospinner'
import {downloadTemplate} from '@bluwy/giget-core'
import {parse, stripComments} from 'jsonc-parser'
import {FileService} from './file-service.js'
import {locateWranglerBin} from '../utils/wrangler-bin.js'

const EXIT_ENVIRONMENT_ERROR = 3
const EXIT_UNKNOWN_FAILURE = 1

/**
 * Converts how a child process ended into an exit code. A process killed by a signal is always a failure.
 * @param code Exit code of the process, null if a signal ended it
 * @param signal Signal that ended the process, null if it exited by itself
 * @returns 128 + signal number after a signal, the exit code otherwise
 */
function toExitCode(code: null | number, signal: NodeJS.Signals | null): number {
  if (signal) return 128 + (constants.signals[signal] ?? 0)
  return code ?? EXIT_UNKNOWN_FAILURE
}

function describeFailure(command: string, code: null | number, signal: NodeJS.Signals | null): string {
  return signal
    ? `Wrangler command '${command}' was killed by ${signal}`
    : `Wrangler command '${command}' failed with exit code ${code}`
}

/**
 * Service for handling wrangler operations
 */
export class WranglerService {
  private errorService: ErrorService
  private fileService: FileService
  private eventListeners?: execEventListener
  private rootDir: string = process.cwd()
  public childProcesses: ChildProcess[] = []

  /**
   * Creates a new WranglerService
   * @param errorService Error service for handling errors
   * @param fileService File service for handling file operations
   * @param eventListeners Event listeners for wrangler commands
   */
  constructor(errorService: ErrorService, fileService: FileService, eventListeners?: execEventListener) {
    this.errorService = errorService
    this.fileService = fileService
    this.eventListeners = eventListeners
  }

  /**
   * Sets the directory that wrangler is resolved from
   * @param rootDir Project root directory
   */
  setRootDir(rootDir: string): void {
    this.rootDir = rootDir
  }

  /**
   * Executes a wrangler command
   * @param args Arguments to pass to wrangler
   * @returns Promise that resolves when the command completes successfully
   */
  public executeWranglerCommand(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = args[0] || 'unknown'
      const childProcess = this.spawnWrangler(args, ['inherit', 'inherit', 'inherit'])

      // 'close' rather than 'exit': it fires once stdio has flushed
      childProcess.on('close', (code, signal) => {
        const exitCode = toExitCode(code, signal)
        if (exitCode === 0) {
          resolve()
          return
        }

        reject(new WranglerError(describeFailure(command, code, signal), exitCode, command, args))
      })

      // Handle unexpected errors (e.g., process couldn't start)
      childProcess.on('error', (err) => {
        reject(
          new WranglerError(`Failed to start wrangler command: ${err.message}`, EXIT_ENVIRONMENT_ERROR, command, args),
        )
      })

      this.childProcesses.push(childProcess)
    })
  }

  public executeHiddenCommand(args: string[]): ChildProcess {
    const childProcess = this.spawnHiddenWrangler(args)
    this.childProcesses.push(childProcess)
    return childProcess
  }

  /**
   * Spawns a hidden wrangler process
   * @param args Arguments to pass to wrangler
   * @returns Child process
   */
  private spawnHiddenWrangler(args: string[]): ChildProcess {
    return this.spawnWrangler(args, ['inherit', 'pipe', 'ignore'])
  }

  /**
   * Spawns wrangler without a shell, so every argument reaches it unchanged
   * @param args Arguments to pass to wrangler
   * @param stdio Stdio configuration of the child process
   * @returns Child process
   */
  private spawnWrangler(args: string[], stdio: StdioOptions): ChildProcess {
    return spawn(process.execPath, [locateWranglerBin(this.rootDir), ...args], {shell: false, stdio})
  }

  /**
   * Executes a wrangler secret bulk upload command
   * @param varsPath Path to the vars file
   * @param configPath Path to the wrangler config file
   * @param env Environment to use
   * @returns Promise that resolves when the command completes successfully
   */
  async execSecretBulkUpload(varsPath: string, configPath: string, env?: string, versions?: boolean): Promise<void> {
    const args = ['secret', 'bulk', varsPath, '--config', configPath]

    if (versions) {
      args.unshift('versions')
    }

    if (env) {
      args.push('--env', env)
    }

    return this.executeWranglerCommand(args)
  }

  /**
   * Executes a wrangler worker command
   * @param command Command to execute
   * @param configPaths Paths to the wrangler config files
   * @param {object} options Options for the command
   * @param {string} options.env Environment to use
   * @param {boolean} options.minify Whether to minify the worker (only for deploy)
   * @param {number} options.port Port to listen on (only for dev)
   * @returns Promise that resolves when the command completes successfully
   */
  async execWorkerCommand(
    command: WorkerCommand,
    configPaths: string[],
    {env, minify, port}: {env?: string; minify?: boolean; port?: number} = {},
  ): Promise<void> {
    const args = [command, ...configPaths.flatMap((c) => ['-c', c])]

    if (env) {
      args.push('--env', env)
    }

    if (command === 'deploy' && minify) {
      args.push('--minify')
    }

    if (command === 'dev' && port !== undefined) {
      args.push('--port', String(port))
    }

    return this.executeWranglerCommand(args)
  }

  /**
   * Executes a wrangler version upload command
   * @param configPath Paths to the wrangler config files
   * @param env Environment to use
   * @param message Commit message for the version
   * @param minify Whether to minify the worker
   * @returns Promise that resolves when the command completes successfully
   */
  async versionUploadCommand(configPath: string, env?: string, message?: string, minify?: boolean): Promise<void> {
    const args = ['versions', 'upload', '-c', configPath]

    if (env) {
      args.push('--env', env)
    }

    if (minify) {
      args.push('--minify')
    }

    if (message) {
      args.push('--message', message)
    }

    await this.executeWranglerCommand(args)
  }

  async versionDeployCommand(configPath: string, env?: string, message?: string, versionId?: string): Promise<void> {
    const args = ['versions', 'deploy', '-c', configPath, '--yes']
    const triggerArgs = ['triggers', 'deploy', '-c', configPath]

    if (env) {
      args.push('--env', env)
      triggerArgs.push('--env', env)
    }

    if (message) {
      args.push('--message', message)
    }

    if (versionId) {
      args.push('--version-id', versionId)
    }

    await this.executeWranglerCommand(args)
    await this.executeWranglerCommand(triggerArgs)
  }

  /**
   * Gets the list of versions for a worker
   * @param configPath Path to the wrangler config file
   * @param env Environment to use
   * @returns Promise that resolves to the list of worker versions
   */
  async getVersions(configPath: string, env?: string): Promise<WorkerVersion[]> {
    const args = ['versions', 'list', '-c', configPath, '--json']

    if (env) {
      args.push('--env', env)
    }

    const child = this.spawnHiddenWrangler(args)

    let output = ''
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString()
    })

    const {code, signal} = await new Promise<{code: null | number; signal: NodeJS.Signals | null}>(
      (resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({code, signal}))
      },
    )

    const exitCode = toExitCode(code, signal)
    if (exitCode !== 0) {
      throw new WranglerError(describeFailure('versions list', code, signal), exitCode, 'versions list', args)
    }

    return JSON.parse(output) as WorkerVersion[]
  }

  async buildWorker(configPath: string, env?: string, minify?: boolean): Promise<string> {
    const baseFolder = path.dirname(configPath)
    const args = ['deploy', '--dry-run', '--outdir', join(baseFolder, 'dist')]

    if (env) {
      args.push('--env', env)
    }

    if (minify) {
      args.push('--minify')
    }

    args.push('--config', configPath)

    await this.executeWranglerCommand(args)

    // copy wrangler.jsonc to dist folder
    const json: Unstable_RawConfig = parse(readFileSync(configPath, 'utf8'))
    json.main = 'index.js'
    const distWranglerJsoncPath = join(baseFolder, 'dist', 'wrangler.jsonc')
    writeFileSync(distWranglerJsoncPath, JSON.stringify(json, null, 2))

    return distWranglerJsoncPath
  }

  /**
   * Executes a wrangler whoami command
   * @returns Promise that resolves when the command completes successfully
   */
  async execWhoami(): Promise<void> {
    const args = ['whoami']
    return this.executeWranglerCommand(args)
  }

  /**
   * Creates a new worker
   * @param {object} options Options for the worker creation
   * @param {string} options.workerName Worker name
   * @param {string} options.rootDir Root directory of the project
   * @param {string} options.workersDirName Workers directory name (eg: workers)
   * @returns {Promise<void>} Promise that resolves when the worker is created successfully
   */
  async createWorker({
    workerName,
    rootDir,
    workersDirName,
  }: {
    workerName: string
    rootDir: string
    workersDirName?: string
  }): Promise<void> {
    const spinner = createSpinner('Initializing worker...').start()

    const workersPath = join(rootDir, workersDirName || '')
    const targetDir = join(workersPath, workerName)

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir)
    }

    spinner.info('Downloading template...').start()

    await downloadTemplate(`gh:honojs/starter/templates/cloudflare-workers`, {
      dir: targetDir,
      force: true,
    })

    spinner.info('Rewriting wrangler config...').start()

    const wranglerConfigPath = join(targetDir, WRANGLER_FILE)
    const stripCommentFromFile = stripComments(readFileSync(wranglerConfigPath, 'utf8'))
    writeFileSync(wranglerConfigPath, stripCommentFromFile)

    experimental_patchConfig(wranglerConfigPath, {
      compatibility_date: undefined,
      name: undefined,
    })

    unlinkSync(join(targetDir, 'tsconfig.json'))
    unlinkSync(join(targetDir, '.gitignore'))

    const baseGitignorePath = join(rootDir, '.gitignore')
    this.fileService.addGitignore(baseGitignorePath, ['.wrangler', TEMP_BASE_WRANGLER_FILE, TEMP_WRANGLER_FILE])

    spinner.info('Rewriting package.json...').start()
    const packagePath = join(targetDir, 'package.json')
    const packageJson = readFileSync(packagePath, 'utf8')
    const rewrittenPackageJson = JSON.parse(packageJson)
    rewrittenPackageJson.name = workerName
    rewrittenPackageJson.version = '0.0.0'

    delete rewrittenPackageJson.scripts
    delete rewrittenPackageJson.dependencies
    delete rewrittenPackageJson.devDependencies

    writeFileSync(packagePath, JSON.stringify(rewrittenPackageJson, null, 2))

    spinner.info('Installing dependencies...').start()
    return new Promise<void>((resolve, reject) => {
      const proc = exec('npm install', {cwd: targetDir})

      proc.on('exit', (code) => {
        const exitCode = code === null ? 0xff : code

        if (exitCode === 0) {
          spinner.success(`Worker ${workerName} created successfully.`)
          resolve()
        } else {
          reject(
            new WranglerError(`Failed to install dependencies for worker ${workerName}`, exitCode, 'npm install', [
              workerName,
            ]),
          )
        }
      })
    })
  }
}
