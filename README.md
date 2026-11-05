# monocf

[![Version](https://img.shields.io/npm/v/monocf.svg)](https://npmjs.org/package/monocf)

monocf deploys a monorepo of Cloudflare Workers. It reads your wrangler configs, works out which worker depends on which, and deploys only what changed, callees first. It wraps wrangler and doesn't replace it.

Use it when you have several workers in one repository, they call each other through service bindings, and you want a pipeline that can answer three questions:

1. What needs deploying?
2. In what order?
3. Did it work, and can we go back?

If you have one worker, plain wrangler is enough.

```console
$ monocf graph -e staging
Level 0:
  orders
Level 1:
  gateway
    -> orders (services: ORDERS)

$ monocf plan -e staging --state r2://my-monocf-state/monocf --out plan.json
Plan for staging at 3f2a9c10d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9: 1 upload, 1 skip.
Account: abcd…wxyz.
  orders: upload (bundle-changed)
Order:
  1. orders
Callers to check: gateway

$ monocf apply plan.json
```

The progress lines are left out here. A minimal project is in [`examples/basic`](examples/basic).

## Contents

- [Install](#install)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Local development](#local-development)
- [Commands](#commands)
- [Continuous deployment](#continuous-deployment)
- [Exit codes and JSON output](#exit-codes-and-json-output)
- [What causes a redeploy](#what-causes-a-redeploy)
- [Known limits](#known-limits)
- [Migrating from 0.2](#migrating-from-02)

## Install

```sh
npm install --save-dev monocf wrangler
```

- **Node.js 22 or newer.**
- **wrangler 4.151.0 or newer** is a peer dependency. monocf finds it from your project root and refuses an older one with exit 3. Pin an exact version: see [What causes a redeploy](#what-causes-a-redeploy).

`graph` and `check` need neither wrangler nor credentials. `bundle` needs wrangler but no credentials.

## Project layout

```text
my-project/
  monocf.config.json
  base.wrangler.jsonc        optional: what every worker starts from
  .monocfignore              optional
  .dev.vars.staging          optional: values for every worker in staging
  workers/
    orders/
      wrangler.jsonc         required: only this file name counts
      package.json           optional: gives VERSION
      src/index.ts
    gateway/
      wrangler.jsonc
      src/index.ts
```

A worker is a direct child of the workers directory that holds a `wrangler.jsonc`. Create one with `monocf worker create <name>`. It writes a small template, needs no network, and adds `.wrangler` and `.monocf` to your `.gitignore`.

Add `.monocf/` to your `.gitignore` in any case. monocf keeps its private run directories, default bundles and plans there.

**Ignore what your build and tools write before your first CI run.** `apply` refuses a checkout with changes git doesn't ignore, so anything written into the tree between checkout and `apply` stops it. A starting `.gitignore`:

```text
node_modules/
.monocf/
.wrangler/
# Wherever your build writes:
dist/
.dev.vars*
!.dev.vars.example
.env*
# If plan writes its files into the tree:
plan.json
plan.md
# Only with --state file:state:
state/
```

Keep `.dev.vars*` and `.env*` out of git in any case, as they hold secrets. In CI, prefer writing plans and summaries to `$RUNNER_TEMP` over ignoring them.

monocf never writes configs or `.dev.vars` next to your source. It writes what wrangler needs to a private directory under `.monocf/runs/` and removes it when the run ends.

## Configuration

### monocf.config.json

monocf looks for this file in the current directory and then in each parent. With `--root-dir` it starts looking there. Comments and trailing commas are allowed. An unknown key is an error, so a typo can't silently turn something off.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `$schema` | string | | Ignored. Allowed for editors |
| `rootDir` | string | the file's directory | Project root, relative to this file |
| `workersDirName` | string | `""` | Directory that holds the workers, relative to the root. Leave it empty and the workers sit in the root itself |
| `baseConfig` | string | `base.wrangler.jsonc` if it exists | Base config, relative to the root. If you name one that doesn't exist, that's an error |
| `variables` | object | `{}` | Values for placeholders: strings, numbers or booleans |
| `port` | number | `8787` | Port of the proxy in `dev -a` |
| `deployBindings` | boolean | `false` | `deploy` also deploys the workers a worker binds to |
| `deploySecrets` | boolean | `false` | `deploy` and `preview` also upload secrets |
| `minify` | boolean | `false` | Minify on `build`, `deploy` and `preview` |

Flags win over this file, and this file wins over the defaults. The three boolean fields have a `--no-` flag, such as `--no-minify`, so a flag can turn off what this file turns on.

```json
{
  "workersDirName": "workers",
  "variables": {"greeting": "hello"}
}
```

### .monocfignore

The file sits in the root and uses `.gitignore` syntax. A pattern matches a worker's directory name, or its path from the root, as in `workers/orders`.

It removes workers from bulk selections: `--all`, and `bundle`, `plan`, `check` and `graph` with no names. Naming an ignored worker is an error, not a silent skip, and so is running a command from inside its directory. A selected worker that binds to an ignored one fails `check`.

A line can apply to some environments only, with a trailing `in` or `except` and a list of names. **Scoped lines need monocf 0.3.0 or later.** An older monocf reads one as a literal pattern that matches nothing, so the worker silently stops being ignored.

```gitignore
# Ignored in every environment
workers/legacy-tool

# Ignored in these environments only
workers/load-test in dev,staging

# Ignored in every environment except these
workers/nightly-report except production
```

- For each env, monocf keeps the lines that apply to it, in their order, and removes the scopes. So `!` and last-match-wins work as in `.gitignore`.
- Names are matched exactly, case included. Spaces after commas are fine.
- **With no `-e` there's no environment.** An `in` line doesn't apply, and an `except` line does.
- **`except` covers everything it doesn't name, `local` and no env included.** With `workers/nightly-report except production`, `monocf dev nightly-report -e local` and `monocf build nightly-report` are both refused. Write `except production,local` to allow `-e local`. Only an `in` line, or none, leaves a worker usable with no env.
- A scope starts at the first whole word `in` or `except` after the pattern, so `workers/in` has no scope. To name a directory with a space and one of those words in it, escape the space, as in `my\ in\ tray`.
- A comment needs a line of its own, as `.gitignore` has no inline comments. It may be indented.
- **A line that can't reach the worker it was written for is an error,** so that a typo can't quietly leave a worker selected everywhere. Each of these stops `check` and every command that selects workers, with exit 2:
  - Whitespace inside a pattern, tabs and no-break spaces included, unless it's escaped: `workers/x excpet production`, `workers/x IN dev` (`in` and `except` are lower case), `workers/x # except production`, or `except production` with no pattern. Write a directory with a space in its name as `my\ dir`.
  - Whitespace at the start of a line, which `.gitignore` keeps as part of the pattern, so the line would match nothing. Whitespace at the end goes, as in `.gitignore`.
  - A line with a scope whose pattern matches no directory, as in `workers/nightlly except production` or `workers\nightly in dev`. Use `/` in paths, as `\` escapes the next character.
  - A scope naming an env that no config defines, as in `except produciton`.
- A line with no scope that matches no directory is only a warning, `ignored-stale`, as a removed worker leaves one behind. `workers/nightly-in-dev` is such a line, so check that warning.
- `dev <worker>` still starts the workers it binds to, ignored or not, as a local session needs them. `deploy -d` and `preview -d` don't follow a binding to a worker ignored in their env, and say so.

`check` looks after this file:

| Rule | Level | What it means |
|---|---|---|
| `ignored-dependency` | error | A selected worker binds to one that's ignored in that env |
| `ignored-malformed` | error | A scope with no names, an empty name or something that isn't a name, as in `workers/x except a,,b` or `workers/x except production # note`; a pattern with unescaped whitespace inside or at the start, as in `workers/x excpet production`; or a scoped line whose pattern matches no directory. Every command that selects workers stops on this too, as nothing says what the line was meant to leave out |
| `ignored-unknown-env` | error | A scope names an env that neither the base config nor any worker defines, as in `except produciton`. Every command that selects workers stops on this too |
| `ignored-stale` | warning | A line with no scope matches no directory |
| `ignored-negation-unused` | warning | A line starting with `!`, scoped or not, reaches only workers that no line before it ignores, so it does nothing. `!` undoes an earlier line; it doesn't mean "not" |

`check` and `check --all-envs` give each env its own ignored set. A worker ignored in an env gets no `missing-env` there, so a production-only worker needs no `dev` section.

### Base config merge rules

Each worker's `wrangler.jsonc` is merged over the base config. The worker is the patch.

- **Arrays concatenate.** The worker's elements are appended to the base's, with no deduplication. A worker can't remove an inherited element.
- **Objects merge,** key by key, all the way down.
- **Worker scalars win.** A string, number or boolean replaces whatever the base has there.
- **Empty values vanish.** An empty `[]` or `{}` in a worker changes nothing, so it can't clear a base value.
- `null` in a worker config is an error that names the key. So is a merge between two different types, such as an object in the base and an array in the worker.

An example: with `"compatibility_flags": ["nodejs_compat"]` in the base and `"compatibility_flags": ["nodejs_als"]` in the worker, the result holds both. With `"triggers": {"crons": []}` in the worker, the base's crons stay.

Wrangler's own rule still applies after the merge: **`vars` and bindings don't inherit into an env.** A `services` list at the top level does nothing under `-e staging`. Put it in `env.staging`, as `examples/basic` does.

### Names

- A worker deploys as `<name>` with no env and `<name>-<env>` with one, and with an env this always applies: an `env.<env>.name` in your config is overwritten.
- Any character other than `a-z`, `0-9` and `-` in a name becomes a dash, uppercase letters included, so write names in lowercase. `check` reports a deployed name that's too long or malformed, and warns, as `worker-name`, about a name that deploys as something other than what's written, or that starts or ends with a dash.
- An unknown `--env` is an error, so a typo can't create a new worker.

### Service bindings

Name the other worker **by its directory**. monocf rewrites it to the deployed name for the env:

```jsonc
{"env": {"staging": {"services": [{"binding": "ORDERS", "service": "orders"}]}}}
```

A name that matches no local worker passes through as external, with a notice. Hardcoding a local worker's deployed name is an error in `check`.

Only `services` gets rewritten. `workflows[].script_name`, `durable_objects.bindings[].script_name`, `tail_consumers`, `streaming_tail_consumers` and `dispatch_namespaces[].outbound.service` reach wrangler as written, so use the deployed name in them. They still count as dependencies, as do queues: a consumer of a queue that a worker produces to comes before that worker.

### Placeholders

`{key}` in any string of a config, object keys included, is replaced with `variables.key` from `monocf.config.json`. With a base config, `{workerName}` is the worker's directory name.

```jsonc
{"name": "{workerName}-{apiVersion}"}
```

An unknown placeholder is an error. To keep literal braces, map the variable to itself: `"id": "{id}"`. A glob such as `*.{js,ts}` and a quantifier such as `{3}` or `{3,5}` aren't placeholders.

### Injected vars

monocf adds these to each worker's vars for the selected env:

| Var | Value |
|---|---|
| `NAME` | The worker's name, without the env suffix |
| `ENVIRONMENT` | The env, or `dev` with no `-e` |
| `VERSION` | `version` from the worker's `package.json`. `0.0.0` with no `package.json`, and unset if the file has no version. Either case gives a notice |
| `RELEASE` | The short commit, at deploy time only |

A `NAME`, `ENVIRONMENT` or `VERSION` in the worker's own config, in the section for that env, is kept. One from the base config is overwritten.

`RELEASE` is passed as `--var RELEASE:<sha>` by `deploy`, `preview`, `dev` and `apply`. It's left out of `build` and `bundle`, so a new commit with the same bundle has the same fingerprint. The commit comes from `GITHUB_SHA`, cut to 7 characters, then `git rev-parse --short HEAD`, then `unknown` with a notice. A `RELEASE` in a config is overridden.

### Secrets files

`.dev.vars.<env>` in the root holds values for every worker, and the one in a worker's directory holds that worker's. The worker's values win. With no `-e`, the file is `.dev.vars`.

- **Uploads** (`secrets deploy`, `deploy -s`, `preview -s`) read the exact file for the env. If neither the root nor the worker has one, it's exit 2. There's no fallback, so development values can't reach production.
- **Local dev** falls back to `.dev.vars` when the env has no file of its own.

## Local development

```sh
monocf dev orders                 # one session: orders and every worker it calls
monocf dev orders -e staging -p 9000
monocf dev -a                     # every worker, behind one proxy on port 8787
```

From inside a worker's directory you can leave out the name, if `workersDirName` is set.

`dev <worker>` runs one wrangler session with the worker and every worker it reaches, transitively, through `services`, `durable_objects` with a `script_name`, and `workflows` with a `script_name`, as calls to them fail unless they run in the same session. It doesn't start a queue's consumer or a tail consumer, as neither is a call: a message sent to a queue whose consumer isn't in the session is accepted and never consumed, and a tail event goes nowhere. `dev` says so at the start, naming the worker. Use `dev -a` to run them all. Every worker in the session gets `RELEASE`.

`dev` takes local values from the `.dev.vars` files above. If there are none, wrangler reads the worker's `.env` files. Local data stays in the worker's `.wrangler/state`.

`dev -a` runs one wrangler per worker, on ports from 9001 unless the worker sets `dev.port`, with output labelled by worker. A proxy listens on `-p`, or `port`, or 8787:

- A worker's prefix is the path of its first route, or `/<directory>` if it has none, or if the route covers a whole host.
- The longest prefix wins, and a prefix matches only on a path boundary, so `/apiv2` doesn't match `/api`.
- **The path reaches the worker unchanged.** `/gateway/orders` arrives at `gateway` as `/gateway/orders`.
- If one worker fails, the others stop. Local data goes to `.monocf/local-storage/<name>`.

## Commands

| Command | What it's for | Needs |
|---|---|---|
| `graph` | Show the dependency graph | Nothing |
| `check` | Find config mistakes | Nothing |
| `bundle` | Build everything and write fingerprints | wrangler |
| `plan` | Compare this commit with what's live | wrangler, token |
| `apply` | Run a plan | wrangler, token |
| `rollback` | Go back | wrangler, token |
| `secrets check` | Compare secret names with what's live | wrangler, token |
| `secrets deploy` | Upload secrets | wrangler, token |
| `build`, `dev` | Build one worker or all of them, or run them locally | wrangler |
| `deploy`, `preview` | Direct, one-off use, with no plan and no state | wrangler, token |
| `worker create` | Add a worker from a small template | Nothing |
| `whoami` | Show the account wrangler sees | wrangler |

`build`, `deploy`, `preview` and `dev` share one set of flags, and a flag that means nothing to the command is exit 2:

| Flag | `build` | `deploy` | `preview` | `dev` |
|---|---|---|---|---|
| `--all`, `--env`, `--json` | Yes | Yes | Yes | Yes |
| `--concurrency` | Yes | Yes | Yes | |
| `--minify` | Yes | Yes | Yes | |
| `--deploy-bindings`, `--deploy-secrets`, `--message` | | Yes | Yes | |
| `--from-version`, `--deploy-from-version-id` | | Yes | | |
| `--port` | | | | Yes |

`--from-version` works for one named worker. It takes no `--all`, `--deploy-bindings`, `--concurrency`, `--minify` or `--deploy-secrets`.

The rest of this section is generated by `npm run readme`.

<!-- commands -->
* [`monocf apply PLAN`](#monocf-apply-plan)
* [`monocf build [WORKERNAME]`](#monocf-build-workername)
* [`monocf bundle`](#monocf-bundle)
* [`monocf check`](#monocf-check)
* [`monocf deploy [WORKERNAME]`](#monocf-deploy-workername)
* [`monocf dev [WORKERNAME]`](#monocf-dev-workername)
* [`monocf graph`](#monocf-graph)
* [`monocf plan`](#monocf-plan)
* [`monocf preview [WORKERNAME]`](#monocf-preview-workername)
* [`monocf rollback [WORKERNAME]`](#monocf-rollback-workername)
* [`monocf secrets check`](#monocf-secrets-check)
* [`monocf secrets deploy [WORKERNAME]`](#monocf-secrets-deploy-workername)
* [`monocf whoami`](#monocf-whoami)
* [`monocf worker [WORKERNAME]`](#monocf-worker-workername)
* [`monocf worker create WORKERNAME`](#monocf-worker-create-workername)

## `monocf apply PLAN`

Run a plan: new workers first, then uploads, then promotes, callees first, with state written as it goes. Exits 2 when the plan is stale, and 1 when a worker failed

```
USAGE
  $ monocf apply PLAN [-b <value>] [-r <value>] [-w <value>] [--concurrency <value>] [--expect-branch-tip
    <value>] [--json] [--summary-file <value>]

ARGUMENTS
  PLAN  The plan file that monocf plan wrote

FLAGS
  -b, --base-config=<value>        Base wrangler config file
  -r, --root-dir=<value>           Root directory of the project
  -w, --workers-dir-name=<value>   Workers directory name in monorepo
      --concurrency=<value>        How many steps run at once. default: 6
      --expect-branch-tip=<value>  Refuse the plan unless this ref is at its commit, which stops a re-run deploying over
                                   something newer
      --json                       Print results as NDJSON on stdout
      --summary-file=<value>       Also add a summary in markdown to this file, such as $GITHUB_STEP_SUMMARY

DESCRIPTION
  Run a plan: new workers first, then uploads, then promotes, callees first, with state written as it goes. Exits 2 when
  the plan is stale, and 1 when a worker failed

EXAMPLES
  $ monocf apply plan.json

  $ monocf apply plan.json --expect-branch-tip origin/main --summary-file "$GITHUB_STEP_SUMMARY" --json
```

_See code: [src/commands/apply/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/apply/index.ts)_

## `monocf build [WORKERNAME]`

Build workers into each worker's dist directory, without uploading

```
USAGE
  $ monocf build [WORKERNAME] [-b <value>] [-r <value>] [-w <value>] [-a] [-e <value>] [--json]
    [--concurrency <value>] [-m]

ARGUMENTS
  WORKERNAME  Worker name. default: the worker whose directory you are in

FLAGS
  -a, --all                       Run command for all workers
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               Environment to use (dev, production etc.)
  -m, --[no-]minify               Minify the worker script during build/deploy
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --concurrency=<value>       How many workers run at once. default: the CPU count up to 8 for build, 1 for deploy
                                  and preview
      --json                      Print results as NDJSON on stdout

DESCRIPTION
  Build workers into each worker's dist directory, without uploading

EXAMPLES
  $ monocf build orders -e dev

  $ monocf build -a -e dev --concurrency 4
```

_See code: [src/commands/build/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/build/index.ts)_

## `monocf bundle`

Build workers without uploading, and write a manifest of fingerprints. Needs no credentials. Pass worker names, or none for all

```
USAGE
  $ monocf bundle -e <value> [-b <value>] [-r <value>] [-w <value>] [--concurrency <value>] [--json] [--out
    <value>]

FLAGS
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               (required) Environment to use (dev, production etc.)
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --concurrency=<value>       How many workers build at once. default: the CPU count up to 8
      --json                      Print results as NDJSON on stdout
      --out=<value>               Output directory. default: .monocf/bundle/<env>

DESCRIPTION
  Build workers without uploading, and write a manifest of fingerprints. Needs no credentials. Pass worker names, or
  none for all

EXAMPLES
  $ monocf bundle -e dev

  $ monocf bundle orders billing -e dev --out build

  $ monocf bundle -e dev --concurrency 4 --json
```

_See code: [src/commands/bundle/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/bundle/index.ts)_

## `monocf check`

Check worker configs without running anything. Exits 2 on errors. Needs no credentials

```
USAGE
  $ monocf check [-b <value>] [-r <value>] [-w <value>] [--all-envs | -e <value>] [--json] [--strict]

FLAGS
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               Environment to use (dev, production etc.)
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --all-envs                  Check every env that any config defines
      --json                      Print findings as JSON
      --strict                    Warnings fail the check too

DESCRIPTION
  Check worker configs without running anything. Exits 2 on errors. Needs no credentials

EXAMPLES
  $ monocf check -e dev

  $ monocf check --all-envs --json

  $ monocf check -e dev --strict
```

_See code: [src/commands/check/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/check/index.ts)_

## `monocf deploy [WORKERNAME]`

Deploy workers straight away with wrangler deploy, with no plan and no state. For pipelines, use plan and apply

```
USAGE
  $ monocf deploy [WORKERNAME] [-b <value>] [-r <value>] [-w <value>] [-a] [-e <value>] [--json]
    [--concurrency <value>] [-d] [-F <value>] [-s] [-f] [-M <value>] [-m]

ARGUMENTS
  WORKERNAME  Worker name. default: the worker whose directory you are in

FLAGS
  -F, --deploy-from-version-id=<value>  Version ID to deploy instead of the latest uploaded version. Requires
                                        --from-version
  -M, --message=<value>                 Message for the version: on deploy, preview or --from-version
  -a, --all                             Run command for all workers
  -b, --base-config=<value>             Base wrangler config file
  -d, --[no-]deploy-bindings            Also deploy or upload the workers it binds to, first
  -e, --env=<value>                     Environment to use (dev, production etc.)
  -f, --from-version                    Deploy from an existing version or latest uploaded version
  -m, --[no-]minify                     Minify the worker script during build/deploy
  -r, --root-dir=<value>                Root directory of the project
  -s, --[no-]deploy-secrets             Also upload secrets, from the exact .dev.vars files for the env
  -w, --workers-dir-name=<value>        Workers directory name in monorepo
      --concurrency=<value>             How many workers run at once. default: the CPU count up to 8 for build, 1 for
                                        deploy and preview
      --json                            Print results as NDJSON on stdout

DESCRIPTION
  Deploy workers straight away with wrangler deploy, with no plan and no state. For pipelines, use plan and apply

EXAMPLES
  $ monocf deploy orders -e dev

  $ monocf deploy orders -e dev --deploy-bindings

  $ monocf deploy -a -e production
```

_See code: [src/commands/deploy/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/deploy/index.ts)_

## `monocf dev [WORKERNAME]`

Run a worker locally with the workers it binds to, or every worker behind one proxy with --all

```
USAGE
  $ monocf dev [WORKERNAME] [-b <value>] [-r <value>] [-w <value>] [-a] [-e <value>] [--json] [-p <value>]

ARGUMENTS
  WORKERNAME  Worker name. default: the worker whose directory you are in

FLAGS
  -a, --all                       Run command for all workers
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               Environment to use (dev, production etc.)
  -p, --port=<value>              Port for dev: of the worker, or of the proxy with --all. default for the proxy: 8787
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --json                      Print results as NDJSON on stdout

DESCRIPTION
  Run a worker locally with the workers it binds to, or every worker behind one proxy with --all

EXAMPLES
  $ monocf dev orders

  $ monocf dev orders -e dev -p 9000

  $ monocf dev -a -p 8787
```

_See code: [src/commands/dev/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/dev/index.ts)_

## `monocf graph`

Print the dependency graph of the workers, callees first. Needs no credentials

```
USAGE
  $ monocf graph [-b <value>] [-r <value>] [-w <value>] [--callers <value> | --mermaid] [-e <value>]
    [--json | ]

FLAGS
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               Environment to use (dev, production etc.)
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --callers=<value>           Print every worker that reaches this one, directly or not
      --json                      Print the graph as JSON
      --mermaid                   Print the graph as a Mermaid flowchart

DESCRIPTION
  Print the dependency graph of the workers, callees first. Needs no credentials

EXAMPLES
  $ monocf graph -e dev

  $ monocf graph -e dev --json

  $ monocf graph -e dev --mermaid

  $ monocf graph -e dev --callers orders
```

_See code: [src/commands/graph/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/graph/index.ts)_

## `monocf plan`

Compare this commit with what is live on Cloudflare, and write what needs deploying to a plan file. Deploys nothing. Exits 1 when drift blocks a worker

```
USAGE
  $ monocf plan -e <value> --state <value> [-b <value>] [-r <value>] [-w <value>] [--allow-recreate]
    [--bundle-dir <value>] [--first-run] [--json] [--markdown <value>] [--on-drift warn|fail] [--out <value>] [--workers
    <value>]

FLAGS
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               (required) Environment to use (dev, production etc.)
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --allow-recreate            Accept that known workers read as missing, or that their account changed
      --bundle-dir=<value>        Use the manifest of an earlier monocf bundle, if it matches this env and commit.
                                  default: bundle now
      --first-run                 Accept that no state exists and no worker is live: the first run for this env
      --json                      Print results as NDJSON on stdout, ending in a plan event
      --markdown=<value>          Also write a summary for a pull request comment to this file
      --on-drift=<option>         [default: warn] warn deploys over what else is live; fail blocks that worker and exits
                                  1
                                  <options: warn|fail>
      --out=<value>               Where to write the plan. default: .monocf/plan/<env>.json
      --state=<value>             (required) Where deployed state lives: file:<dir> or r2://<bucket>/<prefix>
      --workers=<value>           Plan only these workers, as a comma-separated list. default: all

DESCRIPTION
  Compare this commit with what is live on Cloudflare, and write what needs deploying to a plan file. Deploys nothing.
  Exits 1 when drift blocks a worker

EXAMPLES
  $ monocf plan -e staging --state r2://my-state-bucket/monocf

  $ monocf plan -e staging --state file:state --out plan.json --markdown plan.md

  $ monocf plan -e production --state r2://my-state-bucket/monocf --on-drift fail --json
```

_See code: [src/commands/plan/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/plan/index.ts)_

## `monocf preview [WORKERNAME]`

Upload a new version of workers with wrangler versions upload, without sending it traffic

```
USAGE
  $ monocf preview [WORKERNAME] [-b <value>] [-r <value>] [-w <value>] [-a] [-e <value>] [--json]
    [--concurrency <value>] [-d] [-s] [-M <value>] [-m]

ARGUMENTS
  WORKERNAME  Worker name. default: the worker whose directory you are in

FLAGS
  -M, --message=<value>           Message for the version: on deploy, preview or --from-version
  -a, --all                       Run command for all workers
  -b, --base-config=<value>       Base wrangler config file
  -d, --[no-]deploy-bindings      Also deploy or upload the workers it binds to, first
  -e, --env=<value>               Environment to use (dev, production etc.)
  -m, --[no-]minify               Minify the worker script during build/deploy
  -r, --root-dir=<value>          Root directory of the project
  -s, --[no-]deploy-secrets       Also upload secrets, from the exact .dev.vars files for the env
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --concurrency=<value>       How many workers run at once. default: the CPU count up to 8 for build, 1 for deploy
                                  and preview
      --json                      Print results as NDJSON on stdout

DESCRIPTION
  Upload a new version of workers with wrangler versions upload, without sending it traffic

EXAMPLES
  $ monocf preview orders -e dev

  $ monocf preview orders -e dev -M "try the new route"
```

_See code: [src/commands/preview/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/preview/index.ts)_

## `monocf rollback [WORKERNAME]`

Put back the versions a run replaced, callers first, or one worker to a given version. Refuses to cross a Durable Object change unless forced

```
USAGE
  $ monocf rollback [WORKERNAME] -e <value> --state <value> [-b <value>] [-r <value>] [-w <value>] [--dry-run]
    [--force] [--json] [--to <value>] [--to-run <value>]

ARGUMENTS
  WORKERNAME  The one worker to roll back, with --to

FLAGS
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               (required) Environment to use (dev, production etc.)
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --dry-run                   Say what would happen, and change nothing
      --force                     Accept a Durable Object change, or one that can't be checked
      --json                      Print results as NDJSON on stdout
      --state=<value>             (required) Where deployed state lives: file:<dir> or r2://<bucket>/<prefix>
      --to=<value>                The version to put back, for one named worker
      --to-run=<value>            The run whose changes to undo

DESCRIPTION
  Put back the versions a run replaced, callers first, or one worker to a given version. Refuses to cross a Durable
  Object change unless forced

EXAMPLES
  $ monocf rollback -e production --state r2://my-state-bucket/monocf --to-run 20260101T000000Z-abc123 --dry-run

  $ monocf rollback orders -e production --state r2://my-state-bucket/monocf --to 1a2b3c4d --force
```

_See code: [src/commands/rollback/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/rollback/index.ts)_

## `monocf secrets check`

Say which secret names the active version of each worker is missing, from secrets.required and .dev.vars.example. Names only, never values. Exits 1 when one is missing

```
USAGE
  $ monocf secrets check -e <value> [-b <value>] [-r <value>] [-w <value>] [--json]

FLAGS
  -b, --base-config=<value>       Base wrangler config file
  -e, --env=<value>               (required) Environment to use (dev, production etc.)
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo
      --json                      Print results as NDJSON on stdout

DESCRIPTION
  Say which secret names the active version of each worker is missing, from secrets.required and .dev.vars.example.
  Names only, never values. Exits 1 when one is missing

EXAMPLES
  $ monocf secrets check -e production
```

_See code: [src/commands/secrets/check.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/secrets/check.ts)_

## `monocf secrets deploy [WORKERNAME]`

Upload secrets from the exact .dev.vars files for the env, to a worker that already exists

```
USAGE
  $ monocf secrets deploy [WORKERNAME] [-a] [-b <value>] [--create] [-e <value>] [--json] [-r <value>] [-w <value>]

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
  Upload secrets from the exact .dev.vars files for the env, to a worker that already exists

EXAMPLES
  $ monocf secrets deploy orders -e production

  $ monocf secrets deploy -a -e production
```

_See code: [src/commands/secrets/deploy.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/secrets/deploy.ts)_

## `monocf whoami`

Show which account wrangler is logged in to

```
USAGE
  $ monocf whoami

DESCRIPTION
  Show which account wrangler is logged in to

EXAMPLES
  $ monocf whoami
```

_See code: [src/commands/whoami/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/whoami/index.ts)_

## `monocf worker [WORKERNAME]`

Deprecated: use monocf build, deploy, preview or dev, which take the same flags

```
USAGE
  $ monocf worker [WORKERNAME] -c build|deploy|dev|preview [-b <value>] [-r <value>] [-w <value>] [-a]
    [--concurrency <value>] [-d] [-F <value>] [-s] [-e <value>] [-f] [--json] [-M <value>] [-m] [-p <value>]

ARGUMENTS
  WORKERNAME  Worker name. default: the worker whose directory you are in

FLAGS
  -F, --deploy-from-version-id=<value>  Version ID to deploy instead of the latest uploaded version. Requires
                                        --from-version
  -M, --message=<value>                 Message for the version: on deploy, preview or --from-version
  -a, --all                             Run command for all workers
  -b, --base-config=<value>             Base wrangler config file
  -c, --command=<option>                (required) Command to execute
                                        <options: build|deploy|dev|preview>
  -d, --[no-]deploy-bindings            Also deploy or upload the workers it binds to, first
  -e, --env=<value>                     Environment to use (dev, production etc.)
  -f, --from-version                    Deploy from an existing version or latest uploaded version
  -m, --[no-]minify                     Minify the worker script during build/deploy
  -p, --port=<value>                    Port for dev: of the worker, or of the proxy with --all. default for the proxy:
                                        8787
  -r, --root-dir=<value>                Root directory of the project
  -s, --[no-]deploy-secrets             Also upload secrets, from the exact .dev.vars files for the env
  -w, --workers-dir-name=<value>        Workers directory name in monorepo
      --concurrency=<value>             How many workers run at once. default: the CPU count up to 8 for build, 1 for
                                        deploy and preview
      --json                            Print results as NDJSON on stdout

DESCRIPTION
  Deprecated: use monocf build, deploy, preview or dev, which take the same flags

EXAMPLES
  $ monocf worker my-worker -c deploy -e dev
```

_See code: [src/commands/worker/index.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/worker/index.ts)_

## `monocf worker create WORKERNAME`

Create a new worker in the workers directory

```
USAGE
  $ monocf worker create WORKERNAME [-r <value>] [-w <value>]

ARGUMENTS
  WORKERNAME  Worker name

FLAGS
  -r, --root-dir=<value>          Root directory of the project
  -w, --workers-dir-name=<value>  Workers directory name in monorepo

DESCRIPTION
  Create a new worker in the workers directory

EXAMPLES
  $ monocf worker create my-worker
```

_See code: [src/commands/worker/create.ts](https://github.com/omerfardemir/monocf/blob/v0.3.0/src/commands/worker/create.ts)_
<!-- commandsstop -->

## Continuous deployment

The short version: `check` and `plan` on pull requests, `plan` then `apply` on environment branches, one pipeline per environment at a time.

### Set up the state store

monocf remembers what it deployed in a manifest per env. CI uses an R2 bucket:

```sh
npx wrangler r2 bucket create my-monocf-state
```

Then pass `--state r2://my-monocf-state/monocf` to `plan` and `rollback`. The last part is a prefix, and one bucket can hold every env. The keys are `<env>/manifest.json` and `<env>/runs/<run-id>.json`.

- **`CLOUDFLARE_ACCOUNT_ID` is required for the state store** when the login reaches more than one account. State calls belong to no worker, so a worker's `account_id` doesn't reach them. Without it, `plan`, `apply` and `rollback` stop with exit 3 at the first state call and name the variable.
- A missing bucket is exit 3. A bucket with no manifest yet is a first run.
- `file:<dir>` also works, for tests and local use. The directory must exist, or it's exit 3.

The store is not a lock. Wrangler offers no conditional writes.

### API token

**Use an API token in CI, not OAuth.** Wrangler has no lock around refreshing an OAuth login, and parallel processes can race on it. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Start from the **Edit Cloudflare Workers** template in the Cloudflare dashboard, and narrow it. The token needs:

- Account: **Workers Scripts, Edit.** Under Cloudflare's newer Workers roles, Editor can deploy to a worker, and creating a new one takes Admin. Check this if a `create` step fails with a permissions error.
- Account: **Workers R2 Storage, Edit,** for the state store.
- Account: **Account Settings, Read,** and User: **User Details, Read,** which wrangler uses to work out who it is.
- Zone: **Workers Routes, Edit,** on each zone, if your workers have routes.

Check [Cloudflare's roles and permissions page](https://developers.cloudflare.com/workers/authorization/) too, as these names change.

### A worker's own account

Each worker goes to one account, for reads and writes alike. monocf works it out as wrangler does:

1. `account_id` in the worker's config, for the env. Leave it out of the base config unless every worker shares it.
2. `CLOUDFLARE_ACCOUNT_ID` in the real environment.
3. `CLOUDFLARE_ACCOUNT_ID` in the worker's own `.env`, `.env.local`, `.env.<env>` or `.env.<env>.local`, in that order, with the later files winning. The real environment always beats these files.

`plan` prints a mask of each account, such as `abcd…wxyz`, or `chosen by wrangler` when it doesn't know. The ID itself never reaches state, plans or logs.

### Pull requests

```sh
monocf check --all-envs --strict     # exit 2 on any error or warning, but not on a note
monocf plan -e staging --state r2://my-monocf-state/monocf --markdown plan.md --out plan.json
```

`plan` deploys nothing. It runs the same rules as `check` for its env first, and any error stops it with exit 2 and no plan, so a pull request that fails `check` gets no plan either. Warnings don't stop it. `--markdown` writes a summary to post as a comment. It holds worker names, actions and reasons, and no values.

### Environment branches

```sh
monocf plan -e production --state r2://my-monocf-state/monocf --on-drift fail --out plan.json
monocf apply plan.json --expect-branch-tip origin/main --summary-file "$GITHUB_STEP_SUMMARY"
```

`plan` then `apply` does this:

1. Queue consumers the config dropped are detached, before anything can attach one. Cloudflare takes one worker consumer per queue, so this is what lets one commit move a consumer from one worker to another.
2. New workers are created with `wrangler deploy`, callees first.
3. Everything else is uploaded with `wrangler versions upload`, in parallel. Nothing receives traffic yet.
4. Promotes run callees first: `wrangler versions deploy`, then `wrangler triggers deploy` when the triggers changed. A `full-deploy` runs `wrangler deploy` here instead.

Here "triggers" means everything a new version doesn't carry, so that a promote alone can't change it: crons, routes, `workers_dev`, `preview_urls`, `queues.consumers`, the Workflows a worker defines, `tail_consumers` and `streaming_tail_consumers`. A change to any of them runs `triggers deploy` after the promote, which attaches and updates queue consumers and registers Workflows. Tail consumers are set by the promote itself. Wrangler never takes these away when a config drops them, not even `wrangler deploy`, so `apply` does what it can itself:

- A queue consumer the config dropped is detached with `wrangler queues consumer remove`, if it's still attached, in step 1. A queue that no longer exists counts as detached, as there's nothing to detach. If the run stops after that and before the worker taking the consumer over attaches it, the queue has no consumer until the next `apply`, which attaches it. Messages wait in the queue meanwhile. A failed detach fails its worker before any of its new code goes live.
- Tail consumer lists the config dropped are written as empty lists, which is what clears them, as `"crons": []` does for crons.
- A Workflow the config dropped stays registered, still pointing at the worker, as nothing in wrangler deletes one and deleting it deletes its instances. `plan` says so with a `workflow-removed` note that names the command, `wrangler workflows delete <name>`.

When monocf didn't put a consumer or tail consumer there, as with one added by hand, it leaves it alone.

After each promote or deploy, `apply` reads what Cloudflare serves, as wrangler's exit 0 doesn't prove the version went live, and fails the worker with `verify-mismatch` if it's another. Cloudflare can still name the version just replaced for a few seconds, as it can right after a rollback, so that read is made again for up to 30 s before it counts. `rollback` checks its promotes the same way.

If a worker fails, the workers that call it are skipped and independent ones carry on. The exit code is 1, and state records what finished, so the next run heals the rest.

`apply` refuses a stale plan with exit 2, before doing anything: a plan marked not applicable, another commit, another wrangler version, a schema it doesn't know, a worker this checkout deploys under another name, a config or external input that differs from the plan, or uncommitted changes anywhere in the repository. The plan file, the plan's `--markdown` and `--bundle-dir`, the summary file, `.monocf/`, and the manifest, the temporary file a killed write of it leaves, and run records in a `file:` state directory don't count as changes. A state or bundle directory that contains the project root or a worker is refused, as it would hide a change to what gets deployed. Anything else your workflow writes into the checkout does, so send it to `$RUNNER_TEMP` or gitignore it. A worker with `build.command` only gets a notice for external inputs that differ, since its build makes them again at deploy, and the state records what was really uploaded. A worker without one whose gitignored assets a CI step builds needs a `build.command`, or the same files in the apply job. `--expect-branch-tip` also refuses when that ref has moved past the plan's commit, which stops a re-run of an old pipeline from deploying over something newer. Fetch the ref first, as in the sample below: on a re-run, `actions/checkout` points `origin/<branch>` at the old commit.

Each run ends with a record. Its ID is printed as `Run <id>` and is what `rollback --to-run` takes.

Once a run has gone through, `monocf secrets check` and your smoke tests are the next step. `plan` names the `Callers to check`: workers whose callees changed.

### Sample workflow

Everything here is made up. Change the bucket, the branches and the env names. In your own workflows, pin actions by full commit SHA.

```yaml
name: deploy

on:
  pull_request:
  push:
    branches: [main, staging]
  workflow_dispatch:
    inputs:
      first_run:
        description: Pass --first-run to plan, for the first deploy of an environment
        type: boolean
        default: false

permissions:
  contents: read

env:
  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  STATE: r2://my-monocf-state/monocf

jobs:
  pull-request:
    # A pull request from a fork gets no secrets, so it can't plan.
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npx monocf check --all-envs --strict
      - run: npx monocf plan -e staging --state "$STATE" --out plan.json --markdown plan.md
      - run: cat plan.md >> "$GITHUB_STEP_SUMMARY"

  deploy:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    # One pipeline per environment. A run that is already deploying finishes first.
    concurrency:
      group: deploy-${{ github.ref_name }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - name: Choose the environment
        run: |
          case "$GITHUB_REF_NAME" in
            main) echo "TARGET=production" >> "$GITHUB_ENV" ;;
            staging) echo "TARGET=staging" >> "$GITHUB_ENV" ;;
            *) echo "No environment for $GITHUB_REF_NAME"; exit 1 ;;
          esac
      - run: npx monocf check -e "$TARGET" --strict
      - run: npx monocf plan -e "$TARGET" --state "$STATE" --out plan.json --markdown plan.md ${{ inputs.first_run && '--first-run' || '' }}
      - run: cat plan.md >> "$GITHUB_STEP_SUMMARY"
      - run: git fetch --no-tags --depth=1 origin "+refs/heads/$GITHUB_REF_NAME:refs/remotes/origin/$GITHUB_REF_NAME"
      - run: npx monocf apply plan.json --expect-branch-tip "origin/$GITHUB_REF_NAME" --summary-file "$GITHUB_STEP_SUMMARY"
```

Keep the plan and the apply on the same commit and wrangler version. They can be separate jobs if you pass `plan.json` as an artifact.

`monocf bundle` can run ahead of `plan`, and `plan --bundle-dir <dir>` reuses its output. It's only reused if it describes this run exactly: the same env, commit and wrangler, the same configs, and a clean checkout. Otherwise `plan` says why and builds again.

### One pipeline per environment

Nothing stops two `apply` runs from racing on one environment except your CI. Use `concurrency:` in GitHub Actions, or the same thing elsewhere. Different environments can run at the same time.

### First run

**A new environment.** With no manifest and every selected worker missing, `plan` refuses with exit 3, because that's also what a wrong account or a wrong state location looks like. Check them, then pass `--first-run`. `apply` then creates everything, callees first. Until that first deploy, a pull request's `plan` for that env exits 3 too.

**Workers that already exist.** With no state entry for a worker that's live:

| What's live | `--on-drift warn` | `--on-drift fail` |
|---|---|---|
| The version tagged with this commit's fingerprint | `adopt`: nothing is deployed, and `apply` records it | `adopt` |
| Anything else | `upload`, reason `baseline`. `full-deploy` if the worker has migrations | `blocked`, exit 1 |

So run the first plan over existing workers with `--on-drift warn`. Once a manifest exists, `fail` is safe for production. `warn` is the default.

Secrets you already set survive the upload, since a new version inherits them.

### Workers in only some environments

A worker used only in production stays out of the other pipelines with one line in [`.monocfignore`](#monocfignore):

```gitignore
workers/nightly-report except production,local
```

`plan` then selects it for `production` and leaves it out of `dev` and `staging`, and `graph`, `check`, `bundle` and `deploy -a` agree. `local` keeps `-e local` working, and has to be an env a config defines: in a project without one, write `except production`, or every command stops on the unknown env. Two things happen when you change such a line for a worker that already exists.

**A worker that's live and now left out stays live.** If the state knows it, `plan` adds an `ignored-but-deployed` note. monocf never touches it, so deleting it, if you don't want it there, is a person's job. A line with no scope gets no such note.

**A worker a scope brings back can turn every merge red.** If it's live and the state has no entry for it, it's the `Anything else` row under [First run](#first-run). With `--on-drift fail`, `plan` marks it `blocked` and exits 1, on every run, until someone acts. Run one plan and apply with `--on-drift warn`, which uploads this commit over it and records it, and `fail` is safe again. Look at what's live first.

`apply` refuses a plan that deploys a worker the file now leaves out of its env. `rollback --to-run` skips such a worker with a note and leaves it as it is, and `rollback <worker>` refuses it. Fingerprints don't depend on this file, so changing a line doesn't redeploy anything else.

### Guards against a wrong account

A real account with no such worker answers the same as a first run does. So `plan` refuses, with exit 3 and a plan marked not applicable, in three cases:

| What it sees | The flag that accepts it |
|---|---|
| No manifest, and every selected worker reads as missing | `--first-run` |
| The manifest knows two or more selected workers, and more than half of them read as missing | `--allow-recreate` |
| A worker's account differs from the one that last deployed it, by a hash kept in the manifest | `--allow-recreate` |

One recreated worker in a larger set stays a normal `create`. Use `--allow-recreate` when you really did delete the workers or move accounts. Check `account_id` and `CLOUDFLARE_ACCOUNT_ID` first.

### Drift

Drift means the active version on Cloudflare isn't the one in the manifest, for example after someone ran `wrangler deploy` by hand. A split rollout counts too.

- `--on-drift warn` deploys over it with a warning, and applies the triggers again, because a manual deploy applies its own.
- `--on-drift fail` marks that worker `blocked`. The plan is still written, with `applicable: false`, and `plan` exits 1. `apply` refuses it with exit 2. Nothing is deployed until someone has looked. Then plan again with `warn` to take over.

Every upload is tagged `monocf:<fingerprint>`, which is how monocf tells drift from a run that crashed before writing state. If the tag matches, it isn't drift: `plan` notes `state-behind` and recovers.

**A secret rotation isn't drift.** `wrangler secret put`, `wrangler secret bulk` and `monocf secrets deploy` make a new active version with no tag, and Cloudflare marks where it came from. For a worker in the manifest whose live code is the code the manifest names, `plan` gives `upload` with the reason `secret-changed`, even under `--on-drift fail`. That upload tags known code, and the secret carries over. A secret command on top of anything else, such as a manual deploy, keeps that code live, so it's drift, and `--on-drift` decides.

### Secrets

Secrets are managed separately. `plan` and `apply` never read or upload them.

```sh
monocf secrets deploy -a -e production   # from .dev.vars.production
monocf secrets check -e production       # names only, never values
```

`secrets deploy` refuses a worker that doesn't exist yet, because wrangler would otherwise create a new one from a typo. `--create` allows it.

`secrets check` expects the names in `secrets.required`, which wrangler doesn't inherit into an env, and the keys of a `.dev.vars.example` next to the worker's config. A missing name is exit 1, and an unexpected one is a warning. The results go to stdout, one line per worker, so `monocf secrets check -e production | grep missing` works, and notices go to stderr. A worker with neither source is skipped with a note.

**`secrets.required` limits `apply`.** Wrangler enforces it itself: `versions upload` and `deploy` refuse while a name is unset. A worker that doesn't exist yet could only get one through `--secrets-file`, which `apply` doesn't pass. So `plan` can say `upload` or `create`, and `apply` then fails that worker with exit 1. Run `secrets check` before `apply` and set what's missing first. Don't add `secrets.required` to a worker until it exists.

### Recreated workers

When a provider is deleted and created again, its callers stay broken until they get a new version. Redeploying the old version doesn't help.

monocf handles this when it does the creating. Before `apply` creates a worker the manifest knows, it writes the worker's direct callers to a `needsNewVersion` marker in the manifest, before the provider exists. So the need survives a crash. `plan` turns a marked caller into `upload` with the reason `provider-recreated`. The marker clears once that caller gets a new version. A caller that isn't selected keeps its marker and gets a `caller-not-selected` note. A caller `.monocfignore` leaves out of this env is named in a `caller-ignored` note and left alone.

**If you delete and recreate a provider by hand, redeploy its callers too.** Nothing can see that it happened.

### Routes that are removed

Wrangler only publishes a route list with something in it, so removing a worker's last route leaves it attached on Cloudflare. monocf has no zone to check against, so `plan` adds a `routes-removed` note. Remove the route by hand, in the dashboard or the API.

### Rollback

```sh
monocf rollback -e production --state r2://my-monocf-state/monocf --to-run 20260101T000000Z-abc123 --dry-run
monocf rollback -e production --state r2://my-monocf-state/monocf --to-run 20260101T000000Z-abc123
monocf rollback orders -e production --state r2://my-monocf-state/monocf --to 1a2b3c4d --force
```

`--to-run` restores what that run changed, using its record. It goes callers first, and a worker that's refused or fails skips the workers it calls. State goes back to the earlier entries, so the next `plan` compares against what's really live, and a new record lets a later `--to-run` undo the rollback. If what the run replaced wasn't what the state knew, such as a manual hotfix, the next `plan` uploads over it.

A run that failed or was interrupted can be rolled back too. `apply` reads what's live when a step doesn't finish, and records whether it changed. If it can't tell, the summary says so and rollback treats the worker as changed. A worker the run left alone is only checked, and the rollback fails if something else has replaced it since.

`<worker> --to <version-id>` has no record to vouch for the version, so it needs `--force`. The next `plan` will upload over it.

Its limits:

- **Triggers.** Code, vars and secrets follow a version. Crons and routes don't, so monocf restores them separately, for `--to-run` only. `--to` leaves them as they are.
- **Durable Objects.** Cloudflare refuses a rollback across a class addition, and takes one across a class deletion with exit 0, leaving the class broken. So monocf refuses any rollback across a Durable Object change. `--force` accepts that risk.
- **Retained versions.** Cloudflare keeps a limited number of versions. A version it no longer has fails that worker with exit 1.
- **Workers the run created** have nothing to go back to. They're skipped with a note, and stay deployed.
- **A recreated provider.** A caller's earlier version can't reach a provider that was recreated. If the run created that provider, the rollback refuses that caller without `--force`. Whichever way a caller goes back, the next `plan` gives it a new version.
- **A first route.** If the run gave a worker its first route, the rollback leaves it attached, as wrangler only publishes a list with something in it, and says so. Remove it by hand.
- **A broken `.monocfignore`.** A line `check` calls `ignored-malformed` or `ignored-unknown-env` stops a rollback, as it stops every command that selects workers. Rollback doesn't need a clean checkout, so fixing the line, even uncommitted, lets it run.

## Exit codes and JSON output

These are a stable contract.

| Code | Meaning |
|---|---|
| 0 | Everything requested succeeded |
| 1 | One or more workers failed. `plan`: drift blocks a worker. `bundle`: a service binding names an entrypoint that doesn't exist |
| 2 | Usage or config error, or a stale plan. Nothing was attempted |
| 3 | Environment error: wrangler missing or too old, a state store or manifest that can't be used, an output path that can't be written, or a `plan` refused by a guard |
| 129, 130, 143 | Interrupted by SIGHUP, SIGINT or SIGTERM. Partial results are reported |
| 128 + n | A wrangler process was killed by signal n from outside |

A wrangler that fails gives exit 1, and its own exit code appears in the message. On Windows a kill from outside can't be told apart from exit 1.

`stdout` carries results only. Progress and wrangler's output go to `stderr`.

With `--json`, commands print one JSON object per line. Each has a `schemaVersion` and a `type`:

| `type` | Fields |
|---|---|
| `run-started` | `action`, `env`, `workers` |
| `step-started` | `action`, `worker` |
| `step-finished` | `action`, `worker`, `status` (`ok`, `failed`, `skipped`, `cancelled`), and `versionId`, `message` or `reason` where they apply |
| `notice` | `message`, `worker` |
| `finding` | `level`, `rule`, `message`, `worker`, `env` |
| `bundle-written` | `path`, `manifest` |
| `plan` | `path`, `plan` |
| `secrets-check` | `worker`, `missing`, `extra`, `present`, `note` |
| `run-finished` | `exitCode`, `status` (`ok`, `failed`, `interrupted`) |
| `error` | `exitCode`, `message` |

`graph --json` and `check --json` instead print one document, with `schemaVersion` at its top level. Without `--json`, `plan` and `bundle` print the path of the file they wrote on `stdout`.

A plan file and a bundle's `manifest.json` carry a `schemaVersion` too. `schemaVersion` changes only when something that exists changes its meaning. New fields can appear in version 1, so ignore what you don't know. `apply` refuses a plan with a schema version it doesn't know, and a state manifest with a newer one stops the run with exit 3.

A parser error, such as an unknown flag, comes from the CLI framework: exit 2, a message on `stderr`, and no JSON.

## What causes a redeploy

`plan` compares what this commit would upload with what's deployed, not two commits. So a failed or skipped run heals itself on the next one.

```text
bundleHash   = sha256( the built output directory )
configHash   = sha256( the resolved config, for this env, without RELEASE )
externalHash = sha256( what wrangler uploads from outside the output directory )
fingerprint  = sha256( bundleHash, configHash, externalHash )
```

**`bundleHash`** comes from `wrangler deploy --dry-run` without minifying, even if the deploy will minify, because minifier output can change when an unrelated export does. Source maps and wrangler's generated `README.md` don't count. Paths under pnpm's `.pnpm` directory are normalised, so Windows and Linux agree.

**`configHash`** covers the top level and the selected env's section, so a change to another env's values doesn't redeploy this one. A top-level field that the env overrides can still cause a redeploy with no effect. `VERSION` is in the config, so a version bump in `package.json` causes a deploy. `RELEASE` isn't, so a new commit alone doesn't. Crons and routes are in the config too, so changing them gives an `upload` that also applies the triggers.

**`externalHash`** exists because wrangler writes only code to its output directory. It covers:

- `assets.directory`, following `.assetsignore`. `_headers`, `_redirects` and `.assetsignore` itself always count.
- `site.bucket`.
- Modules: `wasm_modules`, `text_blobs`, `data_blobs`, and the `unsafe.capnp` schema files.
- Containers: the Dockerfile and build context of each `containers[]` entry with a local `image`, and of named `images` with a `dockerfile`.

When in doubt, a file counts: a false "changed" costs one redeploy, and a false "unchanged" never ships the change. So everything under a site bucket or a build context counts, except `.git`, `.wrangler`, `.monocf` and the bundle's own output.

**`site` and containers go through `full-deploy`.** `versions upload` refuses a `site`, and for a container it builds nothing and exits 0, so the image would never ship. A worker with either reaches Cloudflare by `wrangler deploy`, which also means no separate promote: the plan shows the reason `needs-deploy`.

| Action | When | Reasons |
|---|---|---|
| `skip` | Nothing changed | `unchanged` |
| `upload` | Code, config or external inputs changed | `bundle-changed`, `config-changed`, `external-changed`, and more below |
| `triggers` | The code is live, and only its triggers are behind (see [Continuous deployment](#continuous-deployment)), or a crash may have stopped short of them. When its tail consumers may be behind, `apply` also gives the live version again with `versions deploy`, as only that sets them | `triggers-changed`, `state-behind` |
| `full-deploy` | Durable Object classes or migrations changed, or `upload` can't carry the change | `do-changed`, `needs-deploy` |
| `create` | The worker doesn't exist | `new` |
| `adopt` | Live with the right tag, but no state entry. No new version: `apply` runs `triggers deploy` and records it | `state-missing` |
| `blocked` | Drift, under `--on-drift fail` | `drift`, `split`, `baseline` |

`upload` can also carry `drift`, `split`, `baseline`, `secret-changed` or `provider-recreated`, as the sections above describe.

**A worker gone from the repository** gets an `orphan` note while the state knows it. monocf never deletes a worker, so the note stays while the worker is live. Delete it yourself with `wrangler delete <deployed name>`. The next `plan` reads it, finds it gone, and notes `orphan-gone`, and that plan's `apply` drops its entry from the state, which clears the note. The read uses `CLOUDFLARE_ACCOUNT_ID`, and only when that's the account the entry recorded, as another account would say any worker is gone.

Removing every cron is handled too: `apply` writes an explicit `"crons": []`, since wrangler leaves deployed crons alone when the key is absent.

**Upgrading wrangler can redeploy workers whose bundle bytes change.** The wrangler version isn't part of the fingerprint, so a worker redeploys only if its bytes differ. Pin wrangler to an exact version and upgrade on purpose, then read the plan. A plan made with one version can't be applied with another.

**Other things that change bytes:** a dependency's code, a text module's line endings on a Windows checkout with `core.autocrlf=true`, and anything `build.command` generates.

## Known limits

- Only `wrangler.jsonc` counts as a worker config, and a worker must be a direct child of the workers directory.
- A worker can't remove what it inherits from the base config.
- The state store has no lock, so CI has to allow one pipeline per environment.
- Removing a worker's last route takes a person, and so does deleting a Workflow a worker no longer defines.
- `plan` and `apply` don't handle secrets, and `secrets.required` can make `apply` fail: see [Secrets](#secrets).
- A provider recreated by hand needs its callers redeployed by hand.
- A cycle of bindings is an error in `check`, so it stops `plan` too. A cycle that only a queue closes is a note, which `--strict` doesn't count, as a queue needs no order at deploy time.
- A Python entry at the top of a worker's directory fails with wrangler's message about `python_modules`. Move the entry into a subdirectory.
- `site` and containers follow wrangler's source, and haven't been run against real Cloudflare by this project's tests.
- `dev -a` starts one wrangler process per worker, so memory grows with the number of workers.
- On Windows, `dev -a` calls between workers fail with "Network connection lost" when any worker sets `tail_consumers`. It works on Linux and macOS, and in a single `dev <worker>` session. Remove `tail_consumers` from the env you run locally, or use WSL.
- On Windows, local D1, KV and Durable Object storage can fail under a long project path, as their files nest deep below it. Keep the project at a short path, such as `C:\Users\you\src\app`, or use WSL.
- Not verified against real Cloudflare: that streaming tail consumers receive events, as the test's consumer received none, and that `observability: {"enabled": false}` takes effect, as the settings API didn't show the field. monocf passes both to wrangler as written.

## Migrating from 0.2

The [changelog](https://github.com/omerfardemir/monocf/blob/main/CHANGELOG.md) lists every change in 0.3.0, the breaking ones first.

Install and floors:

- wrangler is now a peer dependency, at 4.151.0 or newer. Add it to your project and pin it.
- Node.js 22 or newer.

Removed:

- `docker start` and `docker stop`. Their files under `.monocf/` can be deleted.

Delete these if a crashed run left any behind. monocf doesn't write them any more:

- `.temp.wrangler.jsonc`, `.temp.base.wrangler.jsonc` and `.temp.dev.vars`, in any worker directory or the root.
- `dist/wrangler.jsonc`.

Also look at your `.dev.vars` files. 0.2 rewrote them in place, so a crash could leave root values merged into a worker's file, and it dropped comments and quotes. An empty `.dev.vars` it created stops wrangler reading the worker's `.env`. monocf no longer touches these files, but it can't repair them.

These now fail with exit 2 where they used to be ignored or misread:

- `--deploy-from-version-id` without `--from-version`.
- `--from-version` with `--all` or `--deploy-bindings`.
- `--message` or `--deploy-bindings` on `build` or `dev`, `--deploy-secrets` on `build` or `dev`, `--port` on anything but `dev`, `--minify` on `dev`.
- A blank value for a string flag, and an unknown `--env`.
- A named worker that's missing, or ignored in this env, including one inferred from the directory you run in. 0.2 skipped an ignored worker with exit 0 and ran nothing, apart from `secrets deploy`, which did run. A package script such as `monocf worker -c build` in an ignored worker now fails a monorepo build, so change its line in `.monocfignore`, as above, or take the worker out of that script.
- An unknown key in `monocf.config.json`.
- An unknown placeholder, or one outside a string, as in `"cpu_ms": {cpu}`.
- `null` in a worker config under a base config.
- A secrets upload with no file for exactly this env. The fallback to `.dev.vars` is gone.

Other changes:

- `monocf worker -c <action>` still works and prints a deprecation line. Use `monocf <action>`.
- `-e dev` now reads `.dev.vars.dev`, like any other env.
- Exit codes follow the table above. A failed wrangler gives 1, not its own code.
- `secrets deploy -a` honours `.monocfignore`, and it refuses a worker that doesn't exist unless you pass `--create`.
- `build` and `dev` now write the env suffix into service bindings, as `deploy` always did.
- `worker create` writes a small embedded template, and no longer downloads one or runs an install.
- A config value holding a JSON escape is used as parsed, so remove any double-escaping you added to work around 0.2.

## License

MIT
