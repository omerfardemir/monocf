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

## Architecture

Flags and configs are resolved first, with no writes. Everything wrangler reads is then written to one private run directory, and wrangler runs with no shell. The design is in [docs/design/ci-foundation.md](docs/design/ci-foundation.md).

```markdown
src/
  commands/  -- oclif classes: parse flags, call one app function
  app/       -- what each command does, run setup, error handling
  project/   -- monocf.config.json, option precedence, worker discovery, .monocfignore
  config/    -- merge, placeholders, resolve, validate
  graph/     -- nodes and edges, levels, cycles
  runtime/   -- run directory, materialised configs, secrets, signals, dev proxy
  wrangler/  -- locate wrangler, build argv, spawn and capture
  report/    -- events, human output, NDJSON
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

### Requirements

* Node.js 22 or newer.
* `wrangler` 4.151.0 or newer, installed in your project: `npm install --save-dev wrangler`. MonoCF has it as a peer dependency and uses the one your project root resolves, so the bundle follows your lockfile. If there is none, or it is too old, MonoCF exits with code 3.

### The `.monocf` directory

While it runs, MonoCF writes generated configs and secrets files to `.monocf/runs/` in the project root, and never next to your source. The directory is private and is removed when the run ends, also after a failure or a signal. `dev --all` keeps local data in `.monocf/local-storage/`. Add `.monocf/` to your `.gitignore`. MonoCF only does this for you in `worker create`.

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

You can create a `.monocfignore` file in your project's root directory to specify workers that should be excluded from bulk commands like `dev --all` and `deploy --all`. The file uses the same syntax as `.gitignore`. It applies only to `--all`: naming an ignored worker on the command line is an error.

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

Secret uploads are strict. With `--env <name>`, the only files read are `.dev.vars.<name>` of the worker and of the root, and at least one of them has to exist. Without `--env`, the file is `.dev.vars`. When neither exists, the run fails before anything is deployed, and the error names both paths. Another environment's file is never used as a fallback. Local `dev` still falls back to `.dev.vars`. `dev` is an ordinary environment name, so `--env dev` reads `.dev.vars.dev`.

`secrets deploy` first checks that the worker exists, because `wrangler secret bulk` would create a missing one. Pass `--create` to allow that.

For example, if both files contain an `API_KEY` variable:

1. The worker-specific value will be used for that worker
2. Other workers without their own `API_KEY` will use the root value

This allows you to define common variables at the root level and override them as needed for specific workers.

## The RELEASE variable

`deploy`, `preview` and `dev` give your worker a `RELEASE` variable holding the short commit: the first 7 characters of `GITHUB_SHA` when it is set, otherwise `git rev-parse --short HEAD`, otherwise `unknown`. It is passed as `--var RELEASE:<sha>`, so it overrides a `RELEASE` you set in a wrangler config. A `build` doesn't get it, so a bundle doesn't change with the commit alone.

## Environments

`--env <name>` must be defined under `env` in the base config or in the wrangler config of each selected worker, so a typo can't create a new worker. There are no built-in names: `dev` and `local` need to be defined like any other environment.

## Commands

<!-- commands -->
* [`monocf whoami`](#monocf-whoami)
* [`monocf plan`](#monocf-plan)
* [`monocf apply`](#monocf-apply)
* [`monocf rollback`](#monocf-rollback)
* [`monocf secrets check`](#monocf-secrets-check)
* [`monocf secrets deploy`](#monocf-secrets-deploy)
* [`monocf worker [WORKERNAME]`](#monocf-worker-workername)
* [`monocf worker create WORKERNAME`](#monocf-worker-create-workername)

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

## `monocf plan`

Works out what needs deploying, in what order and why, and writes it to a plan file. It deploys nothing. It compares fingerprints from `monocf bundle` with stored state and with the version Cloudflare serves.

```
monocf plan -e staging --state r2://my-state-bucket/monocf
monocf plan -e staging --state file:state --out plan.json --markdown plan.md
monocf plan -e production --state r2://my-state-bucket/monocf --on-drift fail --json
```

| Flag | Meaning |
|---|---|
| `-e, --env` | The environment. Required. |
| `--state` | Where state lives: `file:<dir>` or `r2://<bucket>/<prefix>`. Required. The directory or bucket must exist, and a missing one exits 3. |
| `--bundle-dir` | Reuse an earlier `monocf bundle`, if it matches this env, commit and wrangler. Otherwise it bundles. |
| `--out` | Where to write the plan. Defaults to `.monocf/plan/<env>.json`. |
| `--markdown` | Also write a summary for a pull request comment: names only, no values. |
| `--on-drift` | `warn` (default) deploys over what else is live, with a warning. `fail` blocks that worker. |
| `--workers` | Plan only these, as a comma-separated list. |
| `--first-run` | Accept that this environment has no state and none of its workers exist. Without it, that exits 3, because a wrong account looks the same. |
| `--allow-recreate` | Accept that most known workers read as missing, or that the account differs from the one that last deployed. Without it, either exits 3. |
| `--json` | NDJSON events on stdout, ending in a `plan` event. |

Each worker gets an action: `create`, `upload`, `triggers`, `full-deploy`, `adopt`, `skip` or `blocked`, with the reasons for it. Exit codes: 0 when a plan is made, even with no changes; 1 when anything is blocked or a read fails; 2 on a usage or check error; 3 when the state store or credentials can't be used.

A worker in `.monocfignore` is never touched. A deployed worker that left the repository is listed as an orphan and never deleted.

Rotating a secret with `monocf secrets deploy` or `wrangler secret put` makes a new version with no tag. That isn't drift: the next plan gives that worker an `upload` with the reason `secret-changed`, also under `--on-drift fail`, and the secret carries over.

Someone who deletes and recreates a worker by hand must also redeploy its callers. Monocf can't see that. When `apply` recreates one itself, it keeps a note of the callers until they have a new version.

**Allow one pipeline per environment.** Wrangler offers R2 no conditional writes, so the state store can't act as a lock. In GitHub Actions:

```yaml
concurrency:
  group: deploy-${{ inputs.environment }}
  cancel-in-progress: false
```

## `monocf apply`

Runs a plan: new workers first, then every upload in parallel, then promotes, callees first. Each step is checked against what Cloudflare serves. A failure skips the workers that call the failed one, and everything else carries on.

```
monocf apply plan.json
monocf apply plan.json --expect-branch-tip origin/main --summary-file "$GITHUB_STEP_SUMMARY" --json
```

| Flag | Meaning |
|---|---|
| `--concurrency` | How many steps run at once. Defaults to 6. |
| `--expect-branch-tip` | Refuse the plan unless this ref is at its commit, which stops a re-run deploying over something newer. Needs an up-to-date fetch. |
| `--summary-file` | Also add a summary in markdown to this file. A failure to write it only warns. |
| `--json` | NDJSON events on stdout. Only a promote or a deploy reports a `versionId`. |

Exit codes: 0 when everything worked; 1 when a worker failed or was skipped, or state couldn't be written; 2 when the plan is stale and nothing was attempted; 130 or 143 on a signal. Each run writes `<env>/runs/<run-id>.json` to the state store, and prints its run ID, for `rollback`.

## `monocf rollback`

Puts back what a run replaced, callers first, and restores crons, which don't follow a version.

```
monocf rollback -e production --state r2://my-state-bucket/monocf --to-run 20260101T000000Z-abc123 --dry-run
monocf rollback -e production --state r2://my-state-bucket/monocf --to-run 20260101T000000Z-abc123
monocf rollback orders -e production --state r2://my-state-bucket/monocf --to 1a2b3c4d --force
```

A worker whose Durable Object classes differ between the two versions is refused unless you pass `--force`: Cloudflare can accept that with exit 0 and leave a class broken. A named worker with `--to` has no record to check, so it always needs `--force`, and the next plan uploads over it. Each rollback writes a run record of its own, so `--to-run` can undo it too.

Exit codes: 0 when everything was restored; 1 when a worker was refused or failed; 2 on a usage error or a run that doesn't exist; 3 when a run record can't be trusted.

## `monocf secrets check`

Says which secret names the active version of each worker is missing. It prints names only, never values.

```
monocf secrets check -e production
```

It expects `secrets.required` from the worker's env section and the keys of a `.dev.vars.example` next to its config. Exit 1 when a name is missing or the worker doesn't exist. A name nothing expects is a warning, and a worker with neither source is skipped with a note. `apply` doesn't call this, so a pipeline has to, and before `apply`: wrangler refuses to upload a worker while a name in `secrets.required` is unset, and it can't create a new worker that has one unless it gets a secrets file, which `apply` doesn't pass.

## `monocf secrets deploy`

Deploy secrets for one or multiple workers.

```sh-session
USAGE
  $ monocf secrets deploy [WORKERNAME] [-a] [-b <value>] [-e <value>] [-r <value>] [-w <value>] [--create] [--json]

ARGUMENTS
  WORKERNAME  Worker name

FLAGS
  -a, --all                       Run command for all workers
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               Environment to use (dev, production etc.)
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --create                    Create the worker if it does not exist yet
      --json                      Print results as NDJSON on stdout

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
  $ monocf worker [WORKERNAME] -c build|deploy|dev|preview [-a] [-b <value>] [-s] [-e <value>] [-r <value>] [-w <value>] [-d] [-p <value>] [-m] [-M <value>] [-f] [-F <value>] [--json]

ARGUMENTS
  WORKERNAME  Worker name

FLAGS
  -a, --all                       Run command for all workers
  -b, --base-config=<value>       Base wrangler config file
  -c, --command=<option>          (required) Command to execute
                                  <options: build|deploy|dev|preview>
  -d, --deploy-bindings           Deploy or upload service bindings before the worker (deploy, preview)
  -e, --env=<value>               Environment to use (dev, production etc.)
  -f, --from-version              Deploy an uploaded version: the latest one, or the one from -F (deploy, one named worker)
  -F, --deploy-from-version-id=<value>  Version ID to deploy. Requires -f
  -m, --minify                    Minify the worker script (build, deploy, preview)
  -M, --message=<value>           Message for the version (deploy, preview)
  -p, --port=<value>              Port for dev: of the worker, or of the proxy with --all (default for the proxy: 8787)
  -r, --root-dir=<value>          Root directory of the project
  -s, --deploy-secrets            Deploy secrets for the worker (deploy, preview)
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --json                      Print results as NDJSON on stdout

DESCRIPTION
  Workers command for running dev or deploy for a worker or all workers.
  When using `dev --all`, a proxy worker is started to route requests to the correct worker.
  A flag that the chosen command doesn't support is an error.

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
  Create a new worker in the workers directory, from a small built-in template. Nothing is downloaded or installed, so
  install its dependencies afterwards. Adds .wrangler and .monocf to the .gitignore in the project root.

EXAMPLES
  $ monocf worker create my-worker
```

_See code: [src/commands/worker/create.ts](https://github.com/omerfardemir/monocf/blob/v0.0.9/src/commands/worker/create.ts)_
<!-- commandsstop -->

## Multi-Worker Local Development

When you run `monocf worker -c dev --all`, MonoCF will:

* Start a `wrangler dev` session for each of your workers on a different port.
* Start an additional proxy worker (by default on port `8787`) that routes incoming requests to the correct worker based on the URL path. The path is determined by the `route` property in each worker's `wrangler.jsonc` file, or it defaults to the worker's directory name.

You can specify a different port for the proxy using the `--port` flag.

```bash
# Run all workers, with the proxy listening on port 8000
$ monocf worker -c dev --all --port 8000
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

Add an oclif class under `src/commands/` that extends `BaseCommand` from `src/app/base-command.ts`, parses its flags and calls one function in `src/app/`. Add a step to `src/wrangler/argv.ts` if it needs a new wrangler call. Throw `MonocfError` with an exit code from `src/errors.ts`, or `ConfigError` for a usage problem.

### Code Style

We follow these coding practices:

* Use TypeScript for type safety
* Write unit tests for new functionality
* Document your code with JSDoc comments
* Use meaningful variable and function names

### Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
