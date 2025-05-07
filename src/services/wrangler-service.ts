import { ChildProcess, exec, spawn } from "node:child_process";
import { join } from "node:path";
import { 
  existsSync, 
  mkdirSync, 
  readFileSync, 
  unlinkSync, 
  writeFileSync 
} from "node:fs";
import { experimental_patchConfig } from "wrangler";
import { 
  execEventListener, 
  TEMP_BASE_WRANGLER_FILE, 
  TEMP_WRANGLER_FILE, 
  WRANGLER_FILE,
  WorkerCommand,
  WranglerError
} from "../types/index.js";
import { ErrorService } from "./error-service.js";
import { createSpinner } from "nanospinner";
import { downloadTemplate } from "@bluwy/giget-core";
import { stripComments } from "jsonc-parser";
import { FileService } from "./file-service.js";

/**
 * Service for handling wrangler operations
 */
export class WranglerService {
  private errorService: ErrorService;
  private fileService: FileService;
  private eventListeners?: execEventListener;

  /**
   * Creates a new WranglerService
   * @param errorService Error service for handling errors
   * @param fileService File service for handling file operations
   * @param eventListeners Event listeners for wrangler commands
   */
  constructor(
    errorService: ErrorService,
    fileService: FileService,
    eventListeners?: execEventListener
  ) {
    this.errorService = errorService;
    this.fileService = fileService;
    this.eventListeners = eventListeners;
  }

  /**
   * Executes a wrangler command
   * @param args Arguments to pass to wrangler
   * @returns Promise that resolves when the command completes successfully
   */
  private executeWranglerCommand(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create a wrapper for the stdout/stderr/exit events to handle Promise resolution
      const enhancedOptions: execEventListener = {
        ...this.eventListeners,
        onExitListener: (code: number) => {
          // Handle Promise resolution/rejection
          if (code === 0) {
            resolve();
          } else {
            // Create a more detailed error with the command context
            const command = args[0] || "unknown";
            const errorMessage = `Wrangler command '${command}' failed with exit code ${code}`;

            reject(
              new WranglerError(
                errorMessage,
                code,
                command,
                args
              )
            );
          }
        },
        onStdoutListener: (data: string) => {
          this.eventListeners?.onStdoutListener?.(data);
        },
        onStderrListener: (data: string) => {
          this.eventListeners?.onStderrListener?.(data);
        },
      };

      // Spawn the process with the enhanced options
      const childProcess = this.spawnInteractiveWrangler(args, enhancedOptions);

      // Handle unexpected errors (e.g., process couldn't start)
      childProcess.on("error", (err) => {
        reject(
          new WranglerError(
            `Failed to start wrangler command: ${err.message}`,
            -1, // Use -1 for process start errors
            args[0] || "unknown",
            args
          )
        );
      });
    });
  }

  /**
   * Spawns an interactive wrangler process
   * @param args Arguments to pass to wrangler
   * @param options Event listeners for the command
   * @returns Child process
   */
  private spawnInteractiveWrangler(
    args: string[],
    options?: execEventListener
  ): ChildProcess {
    const wrangler = spawn("wrangler", args, {
      shell: true,
      stdio: ["inherit", "inherit", "inherit"],
    });

    wrangler.on("exit", (code) => {
      // Call the exit listener with the exit code (whether success or failure)
      // This allows the Promise to resolve or reject appropriately
      options?.onExitListener?.(code || 0);
    });

    return wrangler;
  }

  /**
   * Executes a wrangler secret bulk upload command
   * @param varsPath Path to the vars file
   * @param configPath Path to the wrangler config file
   * @param env Environment to use
   * @returns Promise that resolves when the command completes successfully
   */
  async execSecretBulkUpload(
    varsPath: string,
    configPath: string,
    env?: string
  ): Promise<void> {
    const args = ["secret", "bulk", varsPath, "--config", configPath];

    if (env) {
      args.push("--env", env);
    }

    return this.executeWranglerCommand(args);
  }

  /**
   * Executes a wrangler worker command
   * @param command Command to execute (dev, deploy)
   * @param configPaths Paths to the wrangler config files
   * @param env Environment to use
   * @returns Promise that resolves when the command completes successfully
   */
  async execWorkerCommand(
    command: WorkerCommand,
    configPaths: string[],
    env?: string
  ): Promise<void> {
    const args = [
      command, 
      ...configPaths.flatMap(c => ["-c", c])
    ];

    if (env) {
      args.push("--env", env);
    }

    return this.executeWranglerCommand(args);
  }

  /**
   * Executes a wrangler whoami command
   * @returns Promise that resolves when the command completes successfully
   */
  async execWhoami(): Promise<void> {
    const args = ["whoami"];
    return this.executeWranglerCommand(args);
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
    workersDirName
  }: {
    workerName: string;
    rootDir: string;
    workersDirName?: string;
  }): Promise<void> {
    const spinner = createSpinner('Initializing worker...').start();

    const workersPath = join(rootDir, workersDirName || '');
    const targetDir = join(workersPath, workerName);

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir);
    }

    spinner.info('Downloading template...').start();

    await downloadTemplate(
      `gh:honojs/starter/templates/cloudflare-workers`,
      {
        dir: targetDir,
        force: true,
      },
    );

    spinner.info('Rewriting wrangler config...').start();

    const wranglerConfigPath = join(targetDir, WRANGLER_FILE);
    const stripCommentFromFile = stripComments(readFileSync(wranglerConfigPath, 'utf8'));
    writeFileSync(wranglerConfigPath, stripCommentFromFile);

    experimental_patchConfig(wranglerConfigPath, {
      compatibility_date: undefined,
      name: undefined
    });

    unlinkSync(join(targetDir, 'tsconfig.json'));
    unlinkSync(join(targetDir, '.gitignore'));

    const baseGitignorePath = join(rootDir, '.gitignore');
    this.fileService.addGitignore(baseGitignorePath, [
      '.wrangler',
      TEMP_BASE_WRANGLER_FILE,
      TEMP_WRANGLER_FILE
    ]);

    spinner.info('Rewriting package.json...').start();
    const packagePath = join(targetDir, 'package.json');
    const packageJson = readFileSync(packagePath, 'utf8');
    const rewrittenPackageJson = JSON.parse(packageJson);
    rewrittenPackageJson.name = workerName;
    rewrittenPackageJson.version = "0.0.0";

    delete rewrittenPackageJson.scripts;
    delete rewrittenPackageJson.dependencies;
    delete rewrittenPackageJson.devDependencies;

    writeFileSync(packagePath, JSON.stringify(rewrittenPackageJson, null, 2));

    spinner.info('Installing dependencies...').start();
    return new Promise<void>((resolve, reject) => {
      const proc = exec('npm install', { cwd: targetDir });

      proc.on('exit', (code) => {
        const exitCode = code === null ? 0xff : code;

        if (exitCode === 0) {
          spinner.success(`Worker ${workerName} created successfully.`);
          resolve();
        } else {
          reject(new WranglerError(`Failed to install dependencies for worker ${workerName}`, exitCode, 'npm install', [workerName]));
        }
      });
    })
  }
}
