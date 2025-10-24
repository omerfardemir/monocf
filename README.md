[![Version](https://img.shields.io/npm/v/monocf.svg)](https://npmjs.org/package/monocf)
[![Downloads/week](https://img.shields.io/npm/dw/monocf.svg)](https://npmjs.org/package/monocf)

# Table of contents

* [MonoCF](#monocf)
* [Features](#features)
* [Architecture](#architecture)
* [Directory Structure](#directory-structure)
* [Creating a New Project](#creating-a-new-project)
* [Usage](#usage)
* [Configuration](#configuration)
* [Commands](#commands)
* [Contributing](#contributing)

# MonoCF

A powerful command-line interface for managing Cloudflare Workers in monorepo environments. This tool simplifies the development, deployment, and management of multiple Cloudflare Workers projects by providing a unified interface with support for environment-specific configurations, service bindings, and more.

MonoCF streamlines the development workflow by wrapping Wrangler commands with additional features specifically designed for monorepo setups, making it easier to manage multiple workers from a single codebase.

## Features

* **Monorepo Support**: Easily manage multiple workers in a monorepo structure
* **Environment Management**: Deploy to different environment secrets (dev, production, etc.)
* **Bulk Operations**: Run commands on all workers at once
* **Service Bindings**: Simplified management of service bindings between workers for development
* **Configuration Management**: Centralized configuration with environment-specific overrides
* **Worker Creation**: Quickly scaffold new worker projects with best practices
* **Command Pattern**: Implementation of command pattern for extensibility

## Architecture

The codebase follows a clean architecture with separation of concerns:

* **Commands**: Implementation of oclif commands that handle CLI interactions
* **Core**: Business logic and command pattern implementation for extensibility
* **Services**: Reusable services for handling specific functionality
* **Types**: TypeScript type definitions for strong typing
* **Utils**: Utility functions for common operations

### Directory Structure

```markdown
src/
  commands/       -- oclif command implementations
    whoami/       -- Whoami command for checking Cloudflare identity
    worker/       -- Worker-related commands
      create.ts   -- Worker creation command
      index.ts    -- Main worker command (dev/deploy)
  core/           -- Core business logic
    commands/     -- Command pattern implementations
      command.ts   -- Abstract base class for commands
      command-factory.ts    -- Factory for creating commands
      registry.ts           -- Command registry for auto-discovery
      whoami/               -- Whoami command implementation
      worker/               -- Worker command implementations
    worker-command-factory/ -- Factory for worker-specific commands
  services/       -- Service implementations
    configuration-service.ts -- Configuration loading and management
    error-service.ts        -- Error handling and reporting
    file-service.ts         -- File system operations
    service-binding-service.ts -- Service binding management
    wrangler-service.ts     -- Wrangler CLI integration
  types/          -- Type definitions
    command-types.ts        -- Command-related types
    config-types.ts         -- Configuration types
    oclif-types.ts          -- oclif-specific types
    error-types.ts          -- Error types
    wrangler-types.ts       -- Wrangler-specific types and constants
  flags/          -- Command flags definitions
  utils/          -- Utility functions
```

## Getting Started

### Creating a New Project

You can quickly create a new monorepo project with MonoCF using our dedicated CLI tool:

```sh-session
$ npm create monocf@latest
# or
$ npx create-monocf@latest
# or
$ yarn create monocf
# or
$ pnpm create monocf
```

This will set up a new monorepo with Turbo Repo configured and ready to use with MonoCF.

## Usage

<!-- usage -->
```sh-session
$ npm install -g monocf
$ monocf COMMAND
running command...
$ monocf (--version)
monocf/0.0.9 win32-x64 node-v22.14.0
$ monocf --help [COMMAND]
USAGE
  $ monocf COMMAND
```
<!-- usagestop -->

## Configuration

### monocf.config.json

The `monocf.config.json` file is a central configuration file for the MonoCF that allows you to define global settings for your workers project. This file should be placed in the root directory of your project.

#### Configuration Options

| Option | Description |
|--------|-------------|
| `rootDir` | The root directory of your project (default: `./`) |
| `workersDirName` | The name of the directory containing your workers (default: `workers`) |
| `baseConfig` | The base Wrangler configuration file to extend (default: `base.wrangler.jsonc`) |
| `deploySecrets` | Whether to deploy secrets when deploying workers (default: `false`) |
| `variables` | Custom variables that can be replace(like {version}) in your worker configurations |
| `deployBindings` | Whether to deploy service bindings for the worker before deploy main worker (default: `false`) |
| `port` | The port to use for the proxy worker in multi-worker dev mode (default: `8787`) |

#### Example Configuration

```json
{
  "rootDir": "./",
  "workersDirName": "workers",
  "baseConfig": "base.wrangler.jsonc",
  "deploySecrets": true,
  "deployBindings": true,
  "port": 8787,
  "variables": {
    "version": "1.0.0"
  }
}
```

With this configuration:

1. The CLI will look for workers in the `./workers` directory
2. Each worker will extend the `base.wrangler.jsonc` configuration
3. Secrets will be deployed automatically during deployment
4. The `version` variable (1.0.0) will be replaced in your worker configurations where {version} is used
5. Service bindings will be deployed automatically during deployment
6. The proxy worker will run on port 8787 in multi-worker dev mode.

You can override these settings using command-line flags when running commands.

### .monocfignore

You can create a `.monocfignore` file in your project's root directory to specify workers that should be excluded from bulk commands like `dev --all` and `deploy --all`. The file uses the same syntax as `.gitignore`.

#### Example .monocfignore

```ignore
# Comments are supported
# Ignore a worker by its directory name
worker-to-ignore

# Ignore workers in a specific path
workers/another-to-ignore

# You can also use glob patterns
**/experimental-*
```

### Environment Variables Management

MonoCF provides a powerful way to manage environment variables across your monorepo using `.dev.vars` files. This approach allows you to define both global and worker-specific environment variables. To set different secrets for each environment, create files named `.dev.vars.<environment-name>`. When you use MonoCF with `--env <environment-name>`, the corresponding environment-specific file will be loaded instead of the .`dev.vars` file. If you enabled `deploySecrets` in the configuration, the environment variables will be deployed to the worker secrets.
**This is important:** If you enabled `deploySecrets` in the configuration, the environment variables will be deployed to the worker secrets. So `.dev.vars` file for only secret variables. For other variables, you can use `wrangler.jsonc` vars property.

#### Root-level Environment Variables

You can define global environment variables that apply to all workers by creating a `.dev.vars` file in the root directory of your project:

```env
# Root .dev.vars file
API_KEY=global-api-key
DATABASE_URL=https://example.com/db
```

#### Worker-specific Environment Variables

Each worker can have its own `.dev.vars` file with worker-specific environment variables:

```env
# Worker-specific .dev.vars file
API_KEY=worker-specific-api-key
WORKER_SETTING=some-value
```

#### Environment-specific Variables

You can also create environment-specific `.dev.vars` files for both root and worker levels:

* Root level: `.dev.vars.production`, `.dev.vars.staging`, etc.
* Worker level: `workers/my-worker/.dev.vars.production`, etc.

#### Variable Precedence

When deploying a worker with `deploySecrets: true`, MonoCF automatically combines the environment variables from both the root and worker-specific `.dev.vars` files, with worker-specific variables taking precedence over root variables.

For example, if both files contain an `API_KEY` variable:

1. The worker-specific value will be used for that worker
2. Other workers without their own `API_KEY` will use the root value

This allows you to define common variables at the root level and override them as needed for specific workers.

## Commands

<!-- commands -->
* [`monocf docker start`](#monocf-docker-start)
* [`monocf docker stop`](#monocf-docker-stop)
* [`monocf whoami`](#monocf-whoami)
* [`monocf secrets deploy`](#monocf-secrets-deploy)
* [`monocf worker [WORKERNAME]`](#monocf-worker-workername)
* [`monocf worker create WORKERNAME`](#monocf-worker-create-workername)

## `monocf docker start`

Starts a local development environment for multiple workers using Docker.

```sh-session
USAGE
  $ monocf docker start [-p <value>]

FLAGS
  -p, --port=<value>  Port to use for the proxy worker (default: 8787)

DESCRIPTION
  Starts a local development environment for multiple workers using Docker. This command generates a `docker-compose.yml` file in a `.monocf` directory and starts the services. It creates a reverse proxy that routes requests to the correct worker based on the path.

EXAMPLES
  $ monocf docker start

  $ monocf docker start -p 3000
```

## `monocf docker stop`

Stops the local development environment for multiple workers using Docker.

```sh-session
USAGE
  $ monocf docker stop

DESCRIPTION
  Stops the local development environment for multiple workers using Docker.

EXAMPLES
  $ monocf docker stop
```

## `monocf whoami`

Show whoami from wrangler

```sh-session
USAGE
  $ monocf whoami

DESCRIPTION
  Show whoami from wrangler

EXAMPLES
  $ monocf whoami
```

_See code: [src/commands/whoami/index.ts](https://github.com/omerfardemir/monocf/blob/v0.0.9/src/commands/whoami/index.ts)_

## `monocf secrets deploy`

Deploy secrets for one or multiple workers.

```sh-session
USAGE
  $ monocf secrets deploy [WORKERNAME] [-a] [-b <value>] [-e <value>] [-r <value>] [-w <value>]

ARGUMENTS
  WORKERNAME  Worker name

FLAGS
  -a, --all                       Run command for all workers
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               Environment to use (dev, production etc.)
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo

DESCRIPTION
  Deploy secrets for the worker. When using --all, secrets for all workers will be deployed.

EXAMPLES
  $ monocf secrets deploy my-worker

  $ monocf secrets deploy --all --env production
```

_See code: [src/commands/secrets/deploy.ts](https://github.com/omerfardemir/monocf/blob/v0.0.9/src/commands/secrets/deploy.ts)_

## `monocf worker [WORKERNAME]`

Workers command for running dev or deploy for a worker or all workers

```sh-session
USAGE
  $ monocf worker [WORKERNAME] -c <value> [-a] [-b <value>] [-s] [-e <value>] [-r <value>] [-w <value>] [-d] [-p <value>]

ARGUMENTS
  WORKERNAME  Worker name

FLAGS
  -a, --all                       Run command for all workers
  -b, --base-config=<value>       Base wrangler config file
  -c, --command=<value>           (required) Command to execute (dev or deploy)
  -d, --deploy-bindings           Deploy service bindings for the worker before deploy main worker
  -e, --env=<value>               Environment to use (dev, production etc.)
  -p, --port=<value>              Port to use for the proxy worker in multi-worker dev mode (default: 8787)
  -r, --root-dir=<value>          Root directory of the project
  -s, --deploy-secrets            Deploy secrets for the worker
  -w, --workers-dir-name=<value>  Workers directory name in monorepo

DESCRIPTION
  Workers command for running dev or deploy for a worker or all workers.
  When using `dev --all`, a proxy worker is started to route requests to the correct worker.

EXAMPLES
  $ monocf worker my-worker -c dev

  $ monocf worker my-worker -c deploy -e dev

  $ monocf worker -c deploy -a -e production

  $ monocf worker -c dev -a --port 8000
```

_See code: [src/commands/worker/index.ts](https://github.com/omerfardemir/monocf/blob/v0.0.9/src/commands/worker/index.ts)_

## `monocf worker create WORKERNAME`

Create a new worker in the workers directory

```sh-session
USAGE
  $ monocf worker create WORKERNAME [-r <value>] [-w <value>]

ARGUMENTS
  WORKERNAME  Worker name

FLAGS
  -r, --rootDir=<value>         Root directory of the project
  -w, --workersDirName=<value>  Workers directory name in monorepo

DESCRIPTION
  Create a new worker in the workers directory

EXAMPLES
  $ monocf worker create my-worker
```

_See code: [src/commands/worker/create.ts](https://github.com/omerfardemir/monocf/blob/v0.0.9/src/commands/worker/create.ts)_
<!-- commandsstop -->

## Multi-Worker Local Development

MonoCF offers two ways to run multiple workers locally for development:

1. **Proxy-Based Development (`dev --all`)**: This is the simplest method and works out-of-the-box without needing Docker. When you run `monocf worker -c dev --all`, it will:
    * Start a `wrangler dev` session for each of your workers on a different port.
    * Start an additional proxy worker (by default on port `8787`) that intelligently routes incoming requests to the correct worker based on the URL path. The path is determined by the `route` property in each worker's `wrangler.jsonc` file, or it defaults to the worker's directory name.
    * You can specify a different port for the proxy using the `--port` flag.

    ```bash
    # Run all workers, with the proxy listening on port 8000
    $ monocf worker -c dev --all --port 8000
    ```

2. **Docker-Based Development (`docker start`)**: For a more robust and isolated environment, you can use the Docker-based setup. This is ideal for complex scenarios or to ensure consistency across different development machines.
    * Running `monocf docker start` will generate a `.monocf` directory in your project root containing a `docker-compose.yml`, `Dockerfile`, and `nginx.conf`.
    * It spins up a Docker container with `workerd` running all your workers, and an Nginx container acting as a reverse proxy.
    * This provides a production-like environment locally. You can stop the environment with `monocf docker stop`.

    ```bash
    # Start the Docker-based multi-worker environment
    $ monocf docker start
    
    # Stop the environment
    $ monocf docker stop
    ```

## Contributing

We welcome contributions to the MonoCF! Here's how you can help:

### Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/omerfardemir/monocf.git
   cd monocf
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the project**

   ```bash
   npm run build
   ```

4. **Link for local development**

   ```bash
   npm link
   ```

### Adding a New Command

To add a new command to the CLI:

1. **Create args and flags types** in the appropriate directory under `src/flags/`

   ```typescript
   // src/flags/example.ts
   export interface ExampleArgs {
     arg1: string;
     arg2: number;
   }
   
   export interface ExampleFlags {
     flag1: boolean;
     flag2: string;
   }
   ```

2. **Create a new command class** in the appropriate directory under `src/core/commands/`

   ```typescript
   // src/core/commands/example/example-command.ts
   import { Commander } from "../../../types/command-types.js";
   import { MonocfCommand } from "../command.js";
   
   export class ExampleCommand extends MonocfCommand<ExampleArgs, ExampleFlags> {
    // add your services
    private wranglerService: WranglerService

    constructor(command: Commander) {
      super(command)
      this.wranglerService = new WranglerService(this.errorService, this.fileService, command.cmdEvents())

    }
     // Implement your command logic here
     public async execute(args: ExampleArgs, flags: ExampleFlags): Promise<void> {
       // Command implementation
     }
     
     public async finally(): Promise<void> {
       // Cleanup logic
       return Promise.resolve();
     }
   }
   ```

3. **Register the command** in the command registry (`src/core/commands/registry.ts`)

   ```typescript
   // In the registerBuiltInCommands method
   this.registerCommand('example', ExampleCommand);
   ```

4. **Create an oclif command** in `src/commands/`

   ```typescript
   // src/commands/example.ts
   import { CommandBase } from '../types/oclif-types.js';
   import { CommandRegistry } from '../core/commands/registry.js';
   
   export default class Example extends CommandBase {
     static description = 'Example command description';
     static examples = ['<%= config.bin %> example'];
     static args = {
      name: Args.string({
        description: 'Worker name',
        required: false,
      }),
     }
     static flags = {
      flag: Flags.boolean({
        char: 'a',
        default: false,
        description: 'example flag',
        required: false,
      }),
     }
     
     async run() {
      const {args, flags} = await this.parse(Example)
      this.command = await CommandRegistry.createCommand('example', this)
      return this.command.execute(args, flags)
     }
   }
   ```

### Code Style

We follow these coding practices:

* Use TypeScript for type safety
* Follow the command pattern for all commands
* Write unit tests for new functionality
* Document your code with JSDoc comments
* Use meaningful variable and function names

### Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
