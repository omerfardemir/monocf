# JSON output

This is the contract for what monocf prints with `--json`, and for the files it writes that other tools read: the plan file and the bundle manifest. Tests keep it matched to `src/report/events.ts` and to real output.

- **stdout carries results only.** Progress and wrangler's output go to stderr.
- **Every object has a `schemaVersion`,** now 1. It changes only when something that exists changes its meaning. New fields and new event types can appear in version 1, so ignore what you don't know.
- **Commands that run something print NDJSON:** one event per line, each with a `type`. These are `plan`, `apply`, `rollback`, `bundle`, `build`, `deploy`, `preview`, `dev`, `secrets check`, `secrets deploy`, `whoami` and `worker create`.
- **Commands that answer a question print one JSON document:** `graph`, `check`, `commands` and `explain`.
- **Every failure prints one `error` event,** as the last line. That holds for every command, the document ones too, and for flag errors and unknown commands. With a flag error or an unknown command, it's the only line on stdout.
- **Optional fields are left out,** not set to `null`, unless the table says `null`.

Exit codes are in the [README](../README.md#exit-codes-and-json-output). `monocf explain <code>` explains any `code`, `rule` or `reason` below.

## Events

### `run-started`

The first event of a run.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | What runs, such as `plan`, `apply`, `deploy` or `bundle` |
| `env` | string, optional | The env, when there is one |
| `runId` | string, optional | For `apply` and `rollback`: the run record's ID, which `rollback --to-run` takes |
| `workers` | string[] | The workers it covers |

### `step-started`

| Field | Type | Meaning |
|---|---|---|
| `action` | string | The step, such as `build`, `upload`, `promote` or `restore` |
| `worker` | string | The worker |

### `step-finished`

| Field | Type | Meaning |
|---|---|---|
| `action` | string | The step |
| `message` | string, optional | Why it failed, when it failed |
| `reason` | string, optional | For `skipped`: the worker whose failure skipped it |
| `status` | string | `ok`, `failed`, `skipped` or `cancelled` |
| `versionId` | string, optional | The version a `deploy` or an upload made |
| `worker` | string | The worker |

### `notice`

Something worth knowing that doesn't stop the run.

| Field | Type | Meaning |
|---|---|---|
| `message` | string | What to know |
| `worker` | string, optional | The worker it's about |

### `finding`

A problem `bundle` found, such as `unknown-entrypoint`. `check --json` puts its findings in its document instead.

| Field | Type | Meaning |
|---|---|---|
| `env` | string, optional | The env, for a finding about a worker |
| `level` | string | `error`, `warning` or `note` |
| `message` | string | What's wrong |
| `rule` | string | A check rule, from the table below |
| `worker` | string, optional | The worker it's about |

### `bundle-written`

| Field | Type | Meaning |
|---|---|---|
| `manifest` | object | The [bundle manifest](#bundle-manifest) |
| `path` | string | Where the manifest was written |

### `plan`

The last event of a `plan` that wrote a plan, also when the plan is blocked or refused.

| Field | Type | Meaning |
|---|---|---|
| `path` | string | Where the plan was written |
| `plan` | object | The [plan](#plan-file) |

### `secrets-check`

One per worker. Names only, never values.

| Field | Type | Meaning |
|---|---|---|
| `extra` | string[], optional | Secrets the worker has that nothing expects |
| `missing` | string[], optional | Expected secrets the worker lacks. Any makes the exit 1 |
| `note` | string, optional | Why the worker was skipped, such as having nothing to expect |
| `present` | string[], optional | Expected secrets the worker has |
| `worker` | string | The worker |

### `run-finished`

The last event of a run, unless an `error` event follows it.

| Field | Type | Meaning |
|---|---|---|
| `exitCode` | number | The exit code of the run |
| `status` | string | `ok`, `failed` or `interrupted` |

### `whoami`

| Field | Type | Meaning |
|---|---|---|
| `accounts` | object[] | Each account the login reaches, as `{"account": "abcd…wxyz", "name": "..."}`. The ID is masked |
| `authType` | string, optional | How wrangler logged in, such as `User API Token` |
| `email` | string, optional | The login's email, when the token can read it |

### `worker-created`

| Field | Type | Meaning |
|---|---|---|
| `path` | string | The new worker's directory |
| `worker` | string | Its name |

### `error`

The last line of any failure.

| Field | Type | Meaning |
|---|---|---|
| `code` | string | What went wrong, from the [error codes](#error-codes). Stable across releases, unlike the message |
| `exitCode` | number | The exit code monocf exits with |
| `hint` | string, optional | What to do next |
| `message` | string | The same message as on stderr |

## Documents

### `graph --json`

| Field | Type | Meaning |
|---|---|---|
| `cycles` | string[][] | Binding cycles, each as its members |
| `edges` | object[] | Each binding as `{"binding", "from", "kind", "to"}`. `kind` is the config field, such as `services` or `queues` |
| `env` | string or `null` | The env, or `null` without one |
| `external` | object[] | Bindings to workers outside the repository |
| `ignored` | string[] | Workers `.monocfignore` leaves out of this env |
| `levels` | string[][] | Workers by deploy level, callees first |
| `nodes` | object[] | Each worker as `{"name", "deployedName", "callers", "transitiveCallers"}` |

`graph --json --callers <worker>` prints `{"worker", "callers", "transitiveCallers"}` instead.

### `check --json`

| Field | Type | Meaning |
|---|---|---|
| `envs` | (string or `null`)[] | The envs checked |
| `errors` | number | How many findings are errors. Any makes the exit 2 |
| `findings` | object[] | Each as a [`finding`](#finding) without its `type` |
| `notes` | number | How many are notes |
| `warnings` | number | How many are warnings. Any makes the exit 2 with `--strict` |

### `commands --json`

| Field | Type | Meaning |
|---|---|---|
| `commands` | object[] | Each command, as below |

Each command has `id`, such as `secrets check`, `summary`, `description`, `safety`, `args`, `flags`, `requiredFlags`, `exitCodes` and `examples`, and `deprecated` when it is. `safety` is `offline`, `reads-cloudflare` or `writes-cloudflare`. Each flag has `name`, `type` (`boolean` or `option`) and `required`, and `char`, `description`, `default`, `options`, `allowNo` and `exclusive` where they apply. `exitCodes` maps each exit code, as a string, or `128+n` for a signal, to what it means for that command.

### `explain --json`

| Field | Type | Meaning |
|---|---|---|
| `entries` | object[] | Each as `{"code", "kind", "meaning", "next", "exitCode", "levels"}`. `kind` is `error`, `check-rule` or `plan-reason`. `exitCode` is for an error code only, and is `128+n` for a signal, as in `commands --json`. `levels` is for a check rule only: the levels it reports at, `error`, `warning` or `note`. `next` is left out when there's nothing to do |

## Plan file

What `plan` writes, by default to `.monocf/plan/<env>.json`. `apply` reads it.

### Plan

| Field | Type | Meaning |
|---|---|---|
| `accounts` | string[], optional | The masked accounts the plan looked at, or `chosen by wrangler` |
| `applicable` | boolean | False when a step is `blocked` or the plan is refused. `apply` refuses it too |
| `commit` | string | The commit checked out when the plan was made. `apply` needs the same one |
| `createdAt` | string | When, as an ISO date |
| `env` | string | The env |
| `notes` | object[] | Each a [plan note](#plan-note) |
| `outputs` | string[], optional | Files the plan wrote or read inside the project, which `apply` doesn't count as changes |
| `refused` | string, optional | Why this looks like the wrong account or state, and which flag accepts it. `plan` exits 3 |
| `schemaVersion` | number | The plan's schema version. `apply` refuses one it doesn't know |
| `state` | string | The state store, as `--state` gave it |
| `steps` | object[] | Each a [plan step](#plan-step), callees first |
| `wrangler` | string | The wrangler version. `apply` needs the same one |

### Plan step

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `skip`, `upload`, `triggers`, `full-deploy`, `create`, `adopt` or `blocked` |
| `bundleHash` | string | The hash of the built code |
| `callers` | string[] | Workers that bind to this one directly |
| `configHash` | string | The hash of the resolved config for the env |
| `dependsOn` | string[] | Steps that run first |
| `deployedName` | string | The name on Cloudflare |
| `doHash` | string | The hash of the Durable Object classes and migrations |
| `explicitEmptyCrons` | boolean | `apply` writes `"crons": []`, so removed crons stop |
| `explicitEmptyTails` | string[], optional | Tail consumer fields `apply` writes as empty |
| `externalHash` | string | The hash of what wrangler uploads from outside the output directory |
| `fingerprint` | string | The hash of the three above, which tags the upload |
| `markCallers` | string[], optional | For a `create` of a worker the state knows: callers `apply` marks for a new version first |
| `previousVersionId` | string, optional | The version live now. Absent when the worker doesn't exist |
| `reasons` | string[] | Why, from the [plan reasons](#plan-reasons) |
| `recordState` | `true`, optional | A crashed run left this version live, so `apply` records it |
| `removedConsumers` | string[], optional | Queues this worker no longer consumes, which `apply` detaches |
| `transitiveCallers` | string[] | Workers that reach this one, directly or not |
| `triggers` | object | Routes, crons, queue consumers, tail consumers, Workflows, `workers_dev` and preview URLs, as the config sets them |
| `triggersChanged` | boolean | The triggers need applying |
| `triggersHash` | string | The hash of `triggers` |
| `version` | string, optional | The worker's `package.json` version |
| `worker` | string | The worker's directory name |

### Plan note

| Field | Type | Meaning |
|---|---|---|
| `deployedName` | string, optional | The name on Cloudflare, for a note about a worker the repository no longer has under that name |
| `kind` | string | Such as `drift`, `baseline`, `orphan`, `routes-removed` or `caller-not-selected` |
| `message` | string | What to know, and often what to do |
| `worker` | string | The worker |

## Bundle manifest

What `bundle` writes as `manifest.json` in its output directory, by default `.monocf/bundle/<env>`. `plan --bundle-dir` reads it.

### Bundle manifest

| Field | Type | Meaning |
|---|---|---|
| `commit` | string | The commit the bundle is for |
| `dirty` | boolean | The checkout had changes, so the commit doesn't describe the bundle |
| `env` | string | The env |
| `head` | string | What was checked out, whatever CI's variables said |
| `schemaVersion` | number | The manifest's schema version |
| `workers` | object | Each [bundle manifest worker](#bundle-manifest-worker), by directory name |
| `wrangler` | string | The wrangler version that built it |

### Bundle manifest worker

| Field | Type | Meaning |
|---|---|---|
| `bundleHash` | string | As in a plan step |
| `configHash` | string | As in a plan step |
| `deployedName` | string | The name on Cloudflare |
| `doHash` | string | As in a plan step |
| `externalHash` | string | As in a plan step |
| `fingerprint` | string | As in a plan step |
| `hasMigrations` | `true`, optional | The config has Durable Object migrations |
| `needsDeploy` | string[], optional | Fields `versions upload` can't carry, so the worker goes out by `wrangler deploy` |
| `triggers` | object | As in a plan step |
| `triggersHash` | string | As in a plan step |
| `version` | string, optional | The worker's `package.json` version |

## Codes

Generated from the registry `monocf explain` reads, by `npm run docs`.

<!-- codes -->
### Error codes

| Code | Exit | Meaning | What to do |
|---|---|---|---|
| `account-ambiguous` | 3 | The login has more than one account, and nothing says which one holds the state bucket. | Set CLOUDFLARE_ACCOUNT_ID to that account's ID. |
| `auth-rate-limited` | 3 | Cloudflare reports too many authentication failures (10502). | Check the token, and wait for this to clear before trying again. |
| `base-config-missing` | 2 | The base config that monocf.config.json or --base-config names does not exist. | Fix the path, or remove the setting. |
| `binding-unresolved` | 2 | A binding targets a worker whose config could not be resolved. | Run monocf check to see why that worker fails to resolve. |
| `branch-tip-moved` | 2 | The ref given to --expect-branch-tip is at a newer commit than the plan, so a newer run has taken over. | Don't apply this plan. Let the newer run deploy. |
| `check-failed` | 2 | `plan` found check errors, so it wrote no plan. | Run monocf check -e <env> --json, fix the errors, and plan again. |
| `checkout-dirty` | 2 | The checkout has changes the plan doesn't include. | Commit them and plan again, or remove them. |
| `checkout-unknown` | 2 | git can't say whether the checkout has changes, so nothing says that the plan describes it. | Run apply in a git checkout with git on the PATH. |
| `command-needed` | 2 | The command line names a topic, such as secrets, and none of its commands. Without --json, monocf prints the topic's help instead. | Run monocf commands --json, and name one of the topic's commands. |
| `config-invalid` | 2 | A config file can't be read or used: monocf.config.json, a wrangler config, the base config or a package.json. Bad JSON, an unknown key, a field of the wrong type, a null under a base config, or a worker with no name. | Fix the file the message names, then run monocf check. |
| `entrypoint-missing` | 1 | A service binding names an entrypoint that the worker it targets doesn't export. | Fix the entrypoint in the binding, or export it from the target worker. |
| `flag-conflict` | 2 | Flags that can't be used together, a flag that needs another one, or a worker name with --all. | Run monocf <command> --help, and drop one of the flags. |
| `flag-unsupported` | 2 | The flag exists, but means nothing to this command or this combination of flags. | Run monocf <command> --help, and drop the flag. |
| `force-required` | 2 | With no run record, rollback can't check Durable Object compatibility for the version given with --to. | Ask a person whether to pass --force, or roll back a run with --to-run. |
| `ignore-file-invalid` | 2 | .monocfignore has a line nothing can read, or a scope naming an env no config defines. | Run monocf check, and fix the lines it reports as ignored-malformed or ignored-unknown-env. |
| `internal-error` | 1 | Something went wrong that monocf did not expect. | Run again with DEBUG=1 for a stack trace, and report it at https://github.com/omerfardemir/monocf/issues. |
| `interrupted` | 128 + n | monocf was interrupted by SIGHUP, SIGINT or SIGTERM. Partial results were reported. | For apply or rollback, plan again or run the rollback again, which picks up where it stopped. |
| `invalid-flag-value` | 2 | A flag or argument has a value it doesn't accept: not one of its options, not a number, empty, or not a run ID. | Run monocf <command> --help for the values it takes. |
| `live-version-changed` | 1 | The version live on Cloudflare changed after the plan was made. | Plan again on this commit, and apply the new plan. |
| `missing-argument` | 2 | A required argument is missing, such as a worker name outside a worker's directory. | Run monocf <command> --help. |
| `missing-flag` | 2 | A required flag is missing. | Run monocf <command> --help. |
| `no-active-version` | 1 | Cloudflare reports no active version for a worker. | Deploy the worker once, or look at it in the dashboard. |
| `no-versions` | 1 | The worker has no uploaded versions to deploy from. | Upload one first with monocf preview <worker>. |
| `no-workers` | 2 | No workers are left to run, after .monocfignore. | Check the workers directory and .monocfignore. |
| `node-too-old` | 3 | The installed wrangler needs a newer Node.js. | Use a newer Node.js. |
| `not-authenticated` | 3 | wrangler has no credentials for Cloudflare. | Set CLOUDFLARE_API_TOKEN, or run wrangler login in a terminal. |
| `output-path-unsafe` | 2 | An output path would empty or hold source files, or sits inside something a worker uploads. | Write it to a directory of its own. |
| `output-unwritable` | 3 | An output file, such as the plan or its markdown, can't be written. | Check the path and its permissions. |
| `plan-blocked` | 2 | The plan is marked as not applicable: a step is blocked, usually by drift under --on-drift fail. | Look at the blocked steps and their notes. Plan again with --on-drift warn only if a person agrees to deploy over what is live. |
| `plan-invalid` | 2 | The plan file can't be read, isn't JSON, or isn't a plan. | Plan again, and pass the path plan printed. |
| `plan-missing` | 2 | There is no plan at that path. A plan that fails writes none, and removes an earlier one there. | Check that plan succeeded, and pass the path it printed. |
| `plan-refused` | 2 | apply was given a plan that a guard refused when it was made, as it looked like the wrong account or state. That plan run exited 3, and apply exits 2. | Read the plan's refused field. Check account_id and CLOUDFLARE_ACCOUNT_ID, then plan again, with --first-run or --allow-recreate only if a person confirms it. |
| `plan-schema-unsupported` | 2 | The plan was written by a monocf with another plan schema version. | Plan again with this monocf. |
| `plan-stale` | 2 | The plan doesn't describe this checkout: another commit, other configs, or a worker now ignored. | Plan again on this commit, and apply the new plan. |
| `plan-wrangler-mismatch` | 2 | The plan was made with another wrangler version, which changes bundles. | Install the wrangler the plan names, or plan again. |
| `record-worker-missing` | 1 | A worker in the run record has no directory in this checkout. | Roll back from a checkout that has the worker, or roll back that worker with --to. |
| `rollback-refused` | 1 | rollback refused a worker, as going back would cross a Durable Object change or one that can't be checked. | Ask a person whether to pass --force. |
| `root-dir-missing` | 2 | The root directory doesn't exist. | Fix --root-dir. |
| `run-not-found` | 2 | The state has no run with that ID for this env. | Use a run ID from an earlier apply, as its run-started output or state/<env>/runs/ shows. |
| `secret-value-invalid` | 2 | A secret's value can't be written to a .dev.vars file without changing it. | Change the value, or upload that secret with wrangler secret put. |
| `secrets-file-missing` | 2 | Uploading secrets needs the exact .dev.vars.<env> file, and there is none. | Ask a person to create it. Never print or read its values. |
| `state-invalid` | 3 | The state manifest or a run record can't be trusted: a field is missing, or its schema version is newer. | Use a newer monocf, or ask a person to look at the state store. |
| `state-scheme-unsupported` | 2 | --state names a scheme monocf does not support. | Use file:<dir> or r2://<bucket>/<prefix>. |
| `state-unusable` | 3 | The state store can't be reached or read: a missing directory, a bucket that doesn't exist, or a failed read. | Check --state, create the directory or bucket, and check the token. |
| `state-url-invalid` | 2 | --state names no directory, or no valid bucket. | Use file:<dir> or r2://<bucket>/<prefix>. |
| `state-write-failed` | 1 | The state store couldn't record what a run was about to do, so nothing was changed. | Check the state store, and apply again. |
| `unexpected-argument` | 2 | An argument the command doesn't take. | Run monocf <command> --help. |
| `unknown-code` | 2 | monocf explain was given a code it does not know. | Run monocf explain to list every code. |
| `unknown-command` | 2 | The command doesn't exist. | Run monocf commands --json to list the commands. |
| `unknown-env` | 2 | The env is defined neither in the base config nor in the config of the worker. | Define it under "env", or pick another --env. |
| `unknown-flag` | 2 | A flag the command doesn't take. | Run monocf <command> --help. |
| `unknown-placeholder` | 2 | A config uses a placeholder that monocf.config.json does not define, or one outside a string. | Define it under "variables" in monocf.config.json. To keep it literal, map it to itself there. |
| `upload-unconfirmed` | 1 | wrangler exited 0 without reporting a version ID, so the upload is unconfirmed. | Plan again: the plan shows what went live. |
| `verify-mismatch` | 1 | After a promote, Cloudflare serves something other than the version apply deployed. | Look at what is live, then plan again. |
| `version-not-live` | 1 | The version the run deployed isn't live any more, and the run didn't change it, so there's nothing of its to undo. | Use rollback <worker> --to <version-id> to choose a version. |
| `worker-exists` | 2 | A worker with that name already exists. | Pick another name. |
| `worker-ignored` | 2 | .monocfignore leaves the named worker out of this env. | Change its line in .monocfignore, or name another worker. |
| `worker-name-invalid` | 2 | A worker name may hold only lowercase letters, digits and dashes, starting with a letter or a digit. | Pick another name. |
| `worker-not-deployed` | 1 | The worker doesn't exist on Cloudflare, so secrets deploy won't create it from what may be a typo. | Deploy it first, or pass --create if a person confirms the name. |
| `worker-not-found` | 2 | No worker directory has that name. | Run monocf graph to list the workers. |
| `workers-dir-missing` | 2 | The workers directory does not exist. | Check --root-dir, --workers-dir-name and monocf.config.json. |
| `workers-failed` | 1 | More than one worker failed, in different ways. The exit code is the one they share, or 1. | Read each failure in the message, or the step-finished events. |
| `wrangler-failed` | 1 | A wrangler command failed. Its exit code and message are in monocf's message. | Read wrangler's message, and its output on stderr. |
| `wrangler-killed` | 128 + n | A wrangler process was killed by a signal from outside. | Find what killed it, such as a CI timeout or a lack of memory, and run again. |
| `wrangler-output-invalid` | 1 | wrangler printed something monocf can't read. | Check that the wrangler version is supported, and run again. |
| `wrangler-too-old` | 3 | The installed wrangler is older than monocf supports. | Install wrangler 4.151.0 or newer in the project, and pin it. |
| `wrangler-unusable` | 3 | wrangler isn't installed in the project, or it's broken, or it can't start. | Install wrangler as a dev dependency of the project. |

### Check rules

| Rule | Level | Meaning | What to do |
|---|---|---|---|
| `cross-env-binding` | error | A binding targets another env's deployed name of a worker. | Use the directory name of the target, which monocf rewrites for each env. |
| `cycle` | error or note | Workers bind to each other in a cycle, so nothing can deploy first. A cycle only a queue closes is a note. | Break the cycle, for example with a queue. |
| `duplicate-binding-name` | error | A worker has more than one binding with the same name, which wrangler rejects. | Rename one of them. |
| `duplicate-name` | error | Two workers, or one worker in two envs, deploy under the same name, so each deploy overwrites the other. | Give one of them another name. |
| `duplicate-route` | error | Two workers claim the same route. | Remove the route from one of them. |
| `external-binding` | warning | A binding targets a name that matches no local worker, so it passes through as external, and monocf neither orders nor checks it. | Nothing, if that is meant. Otherwise fix the name. |
| `hardcoded-binding` | error | A service binding hardcodes a deployed name, such as orders-dev, which monocf would not rewrite for another env. | Use the directory name of the target. |
| `ignored-dependency` | error | A selected worker binds to one that's ignored in that env. | Stop ignoring the target in that env, or remove the binding. |
| `ignored-malformed` | error | A .monocfignore line nothing can read: a scope with no names, an empty name or something that isn't a name, as in `workers/x except a,,b` or `workers/x except production # note`; a pattern with unescaped whitespace inside or at the start, as in `workers/x excpet production`; or a scoped line whose pattern matches no directory. Every command that selects workers stops on this too, as nothing says what the line was meant to leave out. | Fix the line. Write a space in a directory name as "\ ". |
| `ignored-negation-unused` | warning | A .monocfignore line starting with `!`, scoped or not, reaches only workers that no line before it ignores, so it does nothing. | Remove it. `!` undoes an earlier line; it does not mean "not". |
| `ignored-stale` | warning | A .monocfignore line with no scope matches no directory. | Remove the line if its worker is gone. |
| `ignored-unknown-env` | error | .monocfignore has a scope naming an env that neither the base config nor any worker defines, as in `except produciton`. Every command that selects workers stops on this too. | Fix the env name. |
| `missing-env` | error | A selected worker does not define the env. | Define it under "env", or ignore the worker in that env in .monocfignore. |
| `missing-main` | error | A worker has no main file that exists, and no assets or site. | Fix main in its config. |
| `name-length` | error | A deployed name is over 63 characters, or holds something other than lowercase letters, digits and inner dashes. | Shorten or change the name. |
| `no-compat-date` | warning | A worker has no compatibility_date. | Set one, in the base config or the worker config. |
| `resolve-failed` | error | A worker's config failed to resolve. | Read the message, and fix the file it names. |
| `script-name-directory` | error | A Durable Object or Workflow binding names a directory, which reaches wrangler as written, not as a deployed name. | Use the deployed name the message gives. |
| `self-binding` | warning | A worker binds to itself. It adds no order, and a first deploy of such a worker fails on Cloudflare. | Remove the binding, or deploy the worker once without it. |
| `tail-service-directory` | error | A tail consumer or a dispatch namespace outbound names a directory, which reaches wrangler as written, not as a deployed name. | Use the deployed name the message gives. |
| `unknown-entrypoint` | error or warning | bundle: a service binding names an entrypoint the target doesn't export. A warning when the target's exports can't be read. | Fix the entrypoint, or export it. |
| `unknown-placeholder` | error | A config uses a placeholder that monocf.config.json does not define, or one outside a string. | Define it under "variables" in monocf.config.json. |
| `worker-name` | warning | A worker name deploys as something other than what is written, or starts or ends with a dash. | Rename it to lowercase letters, digits and inner dashes. |

### Plan reasons

| Reason | Meaning | What to do |
|---|---|---|
| `baseline` | The worker exists with no state entry, and its tag differs from this bundle: monocf has never deployed it, or lost track of it. | Check that it is the worker you mean. Under --on-drift fail it is blocked until a person agrees to plan with --on-drift warn. |
| `bundle-changed` | The built code differs from what is deployed. |  |
| `config-changed` | The resolved config for this env differs from what is deployed. |  |
| `do-changed` | Durable Object classes or migrations changed, so the worker goes out by wrangler deploy. |  |
| `drift` | The active version on Cloudflare isn't the one in the state, for example after someone ran wrangler deploy by hand. | Find out who deployed what. Under --on-drift fail the worker is blocked until a person agrees to deploy over it. |
| `external-changed` | What wrangler uploads from outside the output directory changed: assets, a site bucket, modules, or a container build context. |  |
| `needs-deploy` | The worker has a site or a container, which versions upload can't carry, so it goes out by wrangler deploy. |  |
| `new` | The worker doesn't exist on Cloudflare, so apply creates it. |  |
| `provider-recreated` | A worker this one binds to was created again, so this one needs a new version to reach it. |  |
| `secret-changed` | A secret command made the active version over known code. The upload tags it, and the secret carries over. Not drift. |  |
| `split` | A split rollout is live, across more than one version. | Finish or undo the rollout, or let a person decide to deploy over it. |
| `state-behind` | The live version carries monocf's tag, but the state names another: a run likely stopped before writing state. apply records it and applies the triggers. |  |
| `state-missing` | The worker is live with the tag of this bundle, but the state has no entry. apply adopts it with no new version. |  |
| `triggers-changed` | The code is live, and only its triggers, such as crons or routes, are behind. |  |
| `unchanged` | Nothing changed. |  |
<!-- codesstop -->
