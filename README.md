[![Version](https://img.shields.io/npm/v/monocf.svg)](https://npmjs.org/package/monocf)
[![Downloads/week](https://img.shields.io/npm/dw/monocf.svg)](https://npmjs.org/package/monocf)

# Table of contents

<!-- toc -->
* [MonoCF](#monocf)
* [Features](#features)
* [Architecture](#architecture)
* [Directory Structure](#directory-structure)
* [Usage](#usage)
* [Configuration](#configuration)
* [Commands](#commands)
* [Contributing](#contributing)
* [Table of contents](#table-of-contents)
<!-- tocstop -->

# MonoCF

A powerful command-line interface for managing Cloudflare Workers in monorepo environments. This tool simplifies the development, deployment, and management of multiple Cloudflare Workers projects by providing a unified interface with support for environment-specific configurations, service bindings, and more.

MonoCF streamlines the development workflow by wrapping Wrangler commands with additional features specifically designed for monorepo setups, making it easier to manage multiple workers from a single codebase.

## Features

- **Monorepo Support**: Easily manage multiple workers in a monorepo structure
- **Environment Management**: Deploy to different environments (dev, production, etc.)
- **Bulk Operations**: Run commands on all workers at once
- **Service Bindings**: Simplified management of service bindings between workers
- **Configuration Management**: Centralized configuration with environment-specific overrides
- **Worker Creation**: Quickly scaffold new worker projects with best practices
- **Command Pattern**: Implementation of command pattern for extensibility
- **Service Binding Management**: Simplified management of service bindings between workers

## Architecture

The codebase follows a clean architecture with separation of concerns:

- **Commands**: Implementation of oclif commands that handle CLI interactions
- **Core**: Business logic and command pattern implementation for extensibility
- **Services**: Reusable services for handling specific functionality
- **Types**: TypeScript type definitions for strong typing
- **Utils**: Utility functions for common operations

### Directory Structure

```
src/
  commands/       -- oclif command implementations
    whoami/       -- Whoami command for checking Cloudflare identity
    worker/       -- Worker-related commands
      create.ts   -- Worker creation command
      index.ts    -- Main worker command (dev/deploy)
  core/           -- Core business logic
    commands/     -- Command pattern implementations
      abstract-command.ts   -- Abstract base class for commands
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

## Usage

<!-- usage -->
```sh-session
$ npm install -g monocf
$ monocf COMMAND
running command...
$ monocf (--version)
monocf/0.0.2-alpha.0 win32-x64 node-v22.14.0
$ monocf --help [COMMAND]
USAGE
  $ monocf COMMAND
...
```
<!-- usagestop -->

## Configuration

### worker.config.json

The `worker.config.json` file is a central configuration file for the MonoCF that allows you to define global settings for your workers project. This file should be placed in the root directory of your project.

#### Configuration Options

| Option | Description |
|--------|-------------|
| `rootDir` | The root directory of your project (default: `./`) |
| `workersDirName` | The name of the directory containing your workers (default: `workers`) |
| `baseConfig` | The base Wrangler configuration file to extend (default: `base.wrangler.jsonc`) |
| `deploySecrets` | Whether to deploy secrets when deploying workers (default: `false`) |
| `variables` | Custom variables that can be replace(like {version}) in your worker configurations |

#### Example Configuration

```json
{
  "rootDir": "./",
  "workersDirName": "workers",
  "baseConfig": "base.wrangler.jsonc",
  "deploySecrets": true,
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

You can override these settings using command-line flags when running commands.

## Commands

<!-- commands -->
* [`monocf help [COMMAND]`](#monocf-help-command)
* [`monocf whoami`](#monocf-whoami)
* [`monocf worker [WORKERNAME]`](#monocf-worker-workername)
* [`monocf worker create WORKERNAME`](#monocf-worker-create-workername)

### `monocf help [COMMAND]`

Display help for monocf.

```
USAGE
  $ monocf help [COMMAND...] [-n]

ARGUMENTS
  COMMAND...  Command to show help for.

FLAGS
  -n, --nested-commands  Include all nested commands in the output.

DESCRIPTION
  Display help for monocf.
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v6.2.27/src/commands/help.ts)_

### `monocf whoami`

Show whoami from wrangler

```
USAGE
  $ monocf whoami

DESCRIPTION
  Show whoami from wrangler

EXAMPLES
  $ monocf whoami
```

_See code: [src/commands/whoami/index.ts](https://github.com/omerfardemir/monocf/blob/v0.0.2-alpha.0/src/commands/whoami/index.ts)_

### `monocf worker [WORKERNAME]`

Workers command for running dev or deploy for a worker or all workers

```
USAGE
  $ monocf worker [WORKERNAME] -c <value> [-a] [-b <value>] [-s] [-e <value>] [-r <value>] [-w
    <value>]

ARGUMENTS
  WORKERNAME  Worker name

FLAGS
  -a, --all                     Run command for all workers
  -b, --baseConfig=<value>      Base wrangler config file
  -c, --command=<value>         (required) Command to execute (dev or deploy)
  -e, --env=<value>             Environment to use (dev, production etc.)
  -r, --rootDir=<value>         Root directory of the project
  -s, --deploySecrets           Deploy secrets for the worker
  -w, --workersDirName=<value>  Workers directory name in monorepo

DESCRIPTION
  Workers command for running dev or deploy for a worker or all workers

EXAMPLES
  $ monocf worker my-worker -c dev

  $ monocf worker my-worker -c deploy -e dev

  $ monocf worker -c deploy -a -e production
```

_See code: [src/commands/worker/index.ts](https://github.com/omerfardemir/monocf/blob/v0.0.2-alpha.0/src/commands/worker/index.ts)_

### `monocf worker create WORKERNAME`

Create a new worker in the workers directory

```
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

_See code: [src/commands/worker/create.ts](https://github.com/omerfardemir/monocf/blob/v0.0.2-alpha.0/src/commands/worker/create.ts)_
<!-- commandsstop -->

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
   import { AbstractCommand } from "../abstract-command.js";
   
   export class ExampleCommand extends AbstractCommand<ExampleArgs, ExampleFlags> {
     // Implement your command logic here
     protected async execute(args: ExampleArgs, flags: ExampleFlags): Promise<void> {
       // Command implementation
     }
     
     protected async finally(): Promise<void> {
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
     
     async run() {
       await CommandRegistry.executeCommand('example', this);
     }
   }
   ```

### Code Style

We follow these coding practices:

- Use TypeScript for type safety
- Follow the command pattern for all commands
- Write unit tests for new functionality
- Document your code with JSDoc comments
- Use meaningful variable and function names

### Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request