import fs, {existsSync, mkdirSync} from 'node:fs'
import path, {join} from 'node:path'
import {parse} from 'jsonc-parser'
import {Unstable_RawConfig} from 'wrangler'
import {DockerParams} from '../types/command-types.js'
import {MONOCF_FOLDER} from '../types/config-types.js'
import {WranglerService} from './wrangler-service.js'
import {FileService} from './file-service.js'
import {ErrorService} from './error-service.js'
import {LogService} from './log-service.js'
import {parseRouteFromPattern} from '../utils/string.js'

interface WorkerConfig {
  workerName: string
  workerPath: string
  serviceName: string
  jsoncPath: string
  config: Unstable_RawConfig
  port: number
  compatibilityDate: string
  compatibilityFlags?: string[]
  workerBindings: string[]
  envPath: string
}

interface ConfigCollections {
  workers: WorkerConfig[]
  nginxLocations: string[]
  exposedPorts: number[]
}

export class GenerateConfigService {
  private wranglerService: WranglerService
  private readonly BASE_PORT = 9001

  constructor(
    errorService: ErrorService,
    fileService: FileService,
    private logService: LogService,
  ) {
    this.wranglerService = new WranglerService(errorService, fileService)
  }

  /**
   * Main method to generate Docker configuration files
   */
  public async generateDockerConfig(
    workers: {
      name: string
      path: string
      config: string
      envPath: string
    }[],
    params: DockerParams,
  ): Promise<void> {
    if (workers.length === 0) {
      return
    }

    // create .monocf folder
    const monocfFolder = join(params.rootDir, MONOCF_FOLDER)
    if (!existsSync(monocfFolder)) {
      mkdirSync(monocfFolder)
    }

    // workers parent folder full path
    const workersParentFolder = path.basename(path.dirname(workers[0].path)).replaceAll('\\', '/')

    // Initialize collections for configuration data
    const collections: ConfigCollections = {
      workers: [],
      nginxLocations: [],
      exposedPorts: [],
    }

    // Process each worker
    let index = 0
    for (const worker of workers) {
      const workerPath = worker.path
      const jsoncPath = worker.config
      const {envPath} = worker

      if (!fs.existsSync(jsoncPath)) {
        console.warn(`  ⚠️  Skipping worker ${worker.path}: missing wrangler configuration file`)
        continue // Skip this worker but continue with others
      }

      // Load and process worker configuration
      const config = this.loadWorkerConfig(jsoncPath, params.env)

      // Set port and track it
      const port = config.dev?.port ?? this.BASE_PORT + index
      index++
      collections.exposedPorts.push(port)

      // Validate compatibility date
      const compatibilityDate = config.compatibility_date
      if (!compatibilityDate) {
        throw new Error(`❌ Missing 'compatibility_date' for worker '${worker.path}'`)
      }

      // Process worker variables and bindings
      const workerConfig: WorkerConfig = {
        workerName: worker.name,
        workerPath,
        serviceName: config.name || worker.name,
        jsoncPath,
        config,
        port,
        compatibilityDate,
        compatibilityFlags: config.compatibility_flags,
        workerBindings: [],
        envPath,
      }

      collections.workers.push(workerConfig)

      // Build the worker
      await this.wranglerService.buildWorker(jsoncPath, envPath, params.env)

      // Generate configuration parts for this worker
      this.generateWorkerConfigParts(workerConfig, collections)
    }

    // Generate all output files
    this.generateOutputFiles(collections, params.port ?? 8787, workersParentFolder, params.env)
  }

  /**
   * Load and merge worker configuration
   */
  private loadWorkerConfig(jsoncPath: string, env?: string): Unstable_RawConfig {
    const baseConfig: Unstable_RawConfig = parse(fs.readFileSync(jsoncPath, 'utf8'))
    const envConfig = baseConfig.env && env ? baseConfig.env[env] : {}

    return {
      ...baseConfig,
      ...envConfig,
      vars: {...baseConfig.vars, ...envConfig.vars},
    }
  }

  /**
   * Generate configuration parts for a worker
   */
  private generateWorkerConfigParts(workerConfig: WorkerConfig, collections: ConfigCollections): void {
    const {workerName, port, config} = workerConfig
    const {nginxLocations} = collections

    const route = this.getRoutePattern(config) ?? workerName
    const regexRoute = `~* ^/${route}(/.*)?$`

    // Add nginx location - route to the workerd container on the worker's port
    nginxLocations.push(`
  location ${regexRoute} {
    proxy_pass http://workerd:${port}$request_uri;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
  }`)
  }

  private getRoutePattern(config: Unstable_RawConfig): string | undefined {
    if (config.route) {
      if (typeof config.route === 'string') {
        return parseRouteFromPattern(config.route)
      }

      if (Object.keys(config.route).includes('pattern')) {
        return parseRouteFromPattern(config.route.pattern)
      }
    }

    if (config.routes && config.routes.length > 0) {
      const regex = `~* ^/(${config.routes
        .map((route) => {
          if (typeof route === 'string') {
            return parseRouteFromPattern(route)
          }

          if (Object.keys(route).includes('pattern')) {
            return parseRouteFromPattern(route.pattern)
          }

          return ''
        })
        .join('|')})/?(.*)$`

      return regex
    }
  }

  /**
   * Generate all output configuration files
   */
  private generateOutputFiles(
    collections: ConfigCollections,
    port: number,
    workersParentFolder: string,
    env?: string,
  ): void {
    this.generateNginxConfigFile(collections.nginxLocations)
    this.generateDockerfile(collections, workersParentFolder, env)
    this.generateDockerCompose(port)
  }

  /**
   * Generate the nginx.conf file
   */
  private generateNginxConfigFile(nginxLocations: string[]): void {
    const nginxContent = `
# AUTO-GENERATED BY MonoCF. DO NOT EDIT MANUALLY.
events {}
http {
  server {
    listen 80;
    server_name localhost;

    resolver 127.0.0.11 valid=30s;

    ${nginxLocations.join('\n   ')}
  }
}
`

    fs.writeFileSync(`${MONOCF_FOLDER}/nginx.conf`, nginxContent.trim())

    this.logService.log('✅ Successfully generated nginx.conf')
  }

  /**
   * Generate a single Dockerfile for all workers
   */
  private generateDockerfile(collections: ConfigCollections, workersParentFolder: string, env?: string): void {
    const {workers} = collections

    const workerDistList: {
      source: string
      destination: string
    }[] = []

    for (const worker of workers) {
      workerDistList.push({
        source: `./${workersParentFolder}/${worker.workerName}/dist`,
        destination: `./workers/${worker.workerName}`,
      })
    }

    // Create scripts for each worker with isolated storage directories and unique debug ports
    const scripts: Record<string, string> = {}
    for (const [index, worker] of workers.entries()) {
      scripts[`worker-${index}`] =
        `mkdir -p /var/local-storage/${worker.workerName} && wrangler dev ${env ? `--env ${env}` : ''} -c ./workers/${worker.workerName}/wrangler.jsonc --ip 0.0.0.0 --port ${worker.port} --persist-to /var/local-storage/${worker.workerName} --inspector-port ${9230 + index}`
    }

    // Create a package.json for the workerd container
    const workerdPackageJson = {
      name: 'workerd-runtime-env',
      version: '1.0.0',
      description: 'A runtime environment for workerd, auto-generated.',
      dependencies: {
        wrangler: '^4.28.0',
      },
      devDependencies: {
        concurrently: '^9.2.0',
      },
      scripts: {
        ...scripts,
        start: `concurrently ${workers.map((_, index) => `npm run worker-${index}`).join(' ')}`,
      },
    }

    fs.writeFileSync(join(MONOCF_FOLDER, 'workerd-package.json'), JSON.stringify(workerdPackageJson, null, 2))
    this.logService.log('✅ Generated workerd-package.json')

    // Create a single Dockerfile for all workers
    const dockerfileContent = `
# AUTO-GENERATED BY MonoCF. DO NOT EDIT MANUALLY.
FROM node:22-slim
WORKDIR /app

# Install wget
RUN apt-get update && apt-get install -y wget --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Create the parent directory for all persistent storage mounts
RUN mkdir -p /var/local-storage

# Copy the workerd package.json file
COPY ${MONOCF_FOLDER}/workerd-package.json ./package.json

# Install dependencies
RUN npm install

# Copy the pre-built worker code for each discovered worker
${workerDistList.map((worker) => `COPY ${worker.source} ${worker.destination}`).join('\n')}

# Expose all worker ports
${workers.map((worker) => `EXPOSE ${worker.port}`).join('\n')}

# Run wrangler for each worker
CMD ["npm", "run", "start"]
`

    fs.writeFileSync(`${MONOCF_FOLDER}/Dockerfile.workerd`, dockerfileContent.trim())
    this.logService.log('✅ Generated Dockerfile.workerd')
  }

  private generateDockerCompose(port: number) {
    // Start building the docker-compose content
    const dockerComposeContent = `
# AUTO-GENERATED BY MonoCF. DO NOT EDIT MANUALLY.
services:
  workerd:
    build:
      context: ..
      dockerfile: ./.monocf/Dockerfile.workerd
    volumes:
      - ./local-storage:/var/local-storage

  nginx:
    image: nginx:1.25-alpine
    ports:
      - '${port}:80'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - workerd
`

    fs.writeFileSync(`${join(MONOCF_FOLDER, 'docker-compose.yml')}`, dockerComposeContent.trim())
    this.logService.log('✅ Generated docker-compose.yml')
  }
}
