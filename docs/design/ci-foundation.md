# CI foundation design

Status: in progress on `feat/ci-foundation`. This document is the shared contract for the work packages that turn monocf into a safe base for continuous deployment of a Cloudflare Workers monorepo. Nothing here is specific to one consumer. Examples use made-up names.

## Goals

A CI job on an environment branch should be able to answer three questions, in this order:

1. **What needs deploying?** Compare what the current commit would upload with what is deployed. This is state-based, so a failed or skipped run heals itself on the next one.
2. **In what order?** Derive a dependency graph from the wrangler configs and deploy callees before callers.
3. **Did it work, and can we go back?** Report per-worker results in a machine-readable form, keep running independent branches after a failure, and offer a rollback.

Non-goals: a generic monorepo task runner, a plugin system, a Docker runtime, in-process bundling.

## Why the middle of monocf is being replaced

Today monocf merges configs by writing fixed-name temp files into worker directories, and it rewrites `.dev.vars` in place. That makes parallel runs fail or, worse, succeed with the wrong config. It also recurses through bindings with no memoization, so the cost grows exponentially with graph depth.

The oclif layer, the `monocf.config.json` format and the existing flags stay.

## Architecture

```
flags + monocf.config + wrangler.jsonc files
        │
        ▼
   resolveProject()     pure: no writes, no process spawns
        │
        ▼
   buildGraph() → createPlan()     pure: serializable
        │
        ▼
   materialise()        writes only under one private run directory
        │
        ▼
   execute()            pool + events + signals; spawns wrangler with no shell
        │
        ▼
   reporter             human text on stderr, NDJSON on stdout with --json
```

Rules that follow from this:

- **The source tree is never written to** by build, deploy, preview or dev. No temp configs and no `.dev.vars` edits next to the source.
- **One run directory per process:** `<root>/.monocf/runs/<random-id>/<worker>/`. It is created with mode `0700`, and secret files with `0600`. It is removed on every exit path. A crash can leave secret files until the next run, which removes a run if its owner PID is dead or if it is older than a day. So a run writes `.monocf/.gitignore` containing `*`, and `git add -A` can't take them. MonoCF doesn't touch a consumer's own `.gitignore` except in `worker create`.
- **No shell, no wrapper.** Wrangler is spawned as `process.execPath <wrangler package>/wrangler-dist/cli.js ...argv`, with `shell: false`, resolved from the project root. With `shell: true`, or through `bin/wrangler.js`, a killed wrangler can keep deploying. The `bin/wrangler.js` wrapper also turns a signal death of its child into exit 0, which looks like success. The wrapper's version check is replaced by monocf's own floor check.
- **stdout carries results only.** Diagnostics and wrangler output go to stderr.
- **Everything before `materialise` is pure,** so it can be tested without a disk or a process.

### Modules

```
src/
  commands/      oclif classes: parse flags, call one app function
  app/           run orchestration, exit codes
  project/       monocf.config loading, option precedence, worker discovery, .monocfignore
  config/        merge, placeholder substitution, resolve, validate
  graph/         nodes and edges, levels, cycle detection, callers
  plan/          plan creation and types
  runtime/       run directory, materialise, secrets files, pool, signals
  wrangler/      locate bin, build argv (pure), spawn and capture
  state/         StateStore interface, R2 and file adapters, manifest types
  fingerprint/   canonical config, bundle hashing
  report/        events, human sink, NDJSON sink
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Everything requested succeeded |
| 1 | One or more workers failed |
| 2 | Usage or config error; nothing was attempted |
| 3 | Environment error: wrangler missing, wrong version, no auth |
| 129 / 130 / 143 | Interrupted by SIGHUP, SIGINT or SIGTERM; partial results reported |
| 128 + n | A wrangler process was killed by signal n, without monocf being interrupted |

A `wrangler` that fails gives exit 1, and its own exit code appears in the message.

### Option precedence

`flags > monocf.config.json > defaults`. Booleans support `--no-x`. Unsupported flag combinations are errors, never ignored.

## Config resolution

- Base and worker configs are parsed with `jsonc-parser`, not with wrangler's `experimental_*` APIs.
- **Merge semantics stay compatible by default.** Arrays are concatenated, objects merge recursively, and scalars from the worker win. Any change needs an opt-in and a diff tool.
- Placeholders are replaced on parsed strings. An unknown placeholder is an error. A string that needs literal braces maps the variable to itself: `"id": "{id}"`.
- Injected vars: `NAME`, `ENVIRONMENT`, `VERSION`. A value set in the worker's own config is kept. A value from the base config is overwritten, as before.
- Every command receives the same resolved config: a service binding given by directory name becomes the target's deployed name for the env. `build` and `dev` used to leave out the env suffix. For `dev` that form fails with an env: real `wrangler dev` answers 503 "Worker not found", in one session and across `dev --all`, because the target runs under its name for the env. A test against real wrangler covers both.
- A worker that can't be resolved stops only a run that reaches it, so one broken config doesn't block unrelated deploys. A selection fails when any transitive callee failed to resolve, through any edge in the graph table except a queue. That includes a hardcoded deployed name of a failed worker, when its name can still be computed from the parts of its config that were readable.
- `RELEASE` is **not** part of the resolved config. It is passed with `--var RELEASE:<sha>` to `deploy`, `versions upload` and `dev`, and not to a dry-run build, so a new commit with an unchanged bundle has an unchanged fingerprint. A `RELEASE` in a wrangler config is overridden. The SHA is resolved once per run, from `GITHUB_SHA` (cut to 7 characters) when set, else `git rev-parse --short HEAD`, else `unknown` with a notice.
- An unknown `--env` is an error, so a typo can't create an orphan worker.
- Moving a config into the run directory means relative path fields must be rebased. The list of these fields lives in one file. A test reads wrangler's `config-schema.json` and fails when a new path-like field appears. That test only shows that each field was classified, so real-wrangler tests in `test/real/rebase.test.ts` check that wrangler finds and uses the files.
- **Wrangler runs with its working directory in the worker's run directory, next to its config.** Wrangler resolves some things from the config's directory and others from the working directory, and it assumes the two are one directory: it makes `tsconfig` relative to the working directory and esbuild then reads it from the config's. Paths monocf passes on the command line are absolute. What follows from this:
  - `build.cwd` and `unsafe.capnp` are read from the working directory, so they are rebased like the rest. A `build.command` with no `build.cwd` gets the worker's source directory written in, so the command still runs there.
  - Service-binding siblings in one `dev` session have one working directory, the first worker's. Their run directories are at the same depth, so a rebased relative path means the same from any of them.
  - Wrangler's own `.wrangler` directory lands in the run directory. Only `--persist-to` keeps local data in the source tree.
  - Python: wrangler looks for `python_modules` and `cf-requirements.txt` next to the config, so monocf copies them into the run directory for a worker whose entry ends in `.py`. Wrangler refuses a `python_modules` inside the module root unless that root is the config's directory, which it never is here, so a Python entry at the top of the worker's directory fails with wrangler's message. Move the entry into a subdirectory.
  - Its account cache goes to the nearest `node_modules/.cache/wrangler` above the run directory, which is the one at the project root rather than the worker's.
  - At startup, wrangler loads `.env`, `.env.local`, `.env.<env>` and `.env.<env>.local` from its working directory into its own environment, later files first in precedence, with `$VAR` expansion, and the real environment winning. That reaches `build.command` and everything wrangler reads from its environment, including `CLOUDFLARE_ACCOUNT_ID`. The working directory is now the run directory, so monocf reads those files from the worker's source directory, with the same rules, and adds the result to the spawn's environment. Reads of a worker get the same values as its writes, so both go to one account. It doesn't pass `--env-file`, which makes wrangler skip `.dev.vars`. Values are never printed. `monocf whoami` belongs to no worker, so it sees only the real environment.
  - `dev` reads local values from `.dev.vars` next to the config, or from `.env` files there when there is none. Monocf writes the `.dev.vars` it merged, or else copies the worker's `.env` files into the run directory, with the same permissions and clean-up.

### Deliberate differences from monocf 0.2

The old flow edited config text and read it back through wrangler's patch function. These inputs now behave differently, on purpose:

| Input | Old | New |
|---|---|---|
| A variable value with JSON escapes, such as a backslash and `n` in the parsed value | Decoded a second time: a real newline | Used as the parsed string, so an old double-escaped workaround now keeps its backslashes. Remove the extra escaping |
| A duplicate key in a config | Edits went to the first copy and reads came from the last, so edits could get lost | The parser reads the last value, and merges apply to it |
| An unquoted placeholder, as in `"cpu_ms": {cpu}` | Worked with no base config | A parse error. Quote it and read the value as a string |
| `null` in a worker config, under a base config | Depends on the wrangler version: a crash, or `null` written out | An error that names the key |
| `{1abc}`, `{şehir}`, `{ v }` | Deployed as literal text | Unknown placeholder errors. `{3}` and `{3,5}` are quantifiers and pass |

## Graph

Edges come from:

| Source | Target |
|---|---|
| `services[].service` | Worker |
| `workflows[].script_name` | Worker |
| `durable_objects.bindings[].script_name` | Worker |
| `tail_consumers[].service` | Worker |
| `streaming_tail_consumers[].service` | Worker |
| `dispatch_namespaces[].outbound.service` | Worker |
| Queue producers and consumers | Logical edge: consumer of a queue the worker produces to |
| Queue `consumers[].dead_letter_queue` | Logical edge: consumer of the dead letter queue |

Binding names that match no local worker pass through as external, with a notice. They are not part of the graph.

A queue edge needs no order at deploy time, so one that closes a cycle is left out of ordering, and the service bindings in that cycle keep theirs. When `a` binds to `b` and `b` sends to a queue that `a` consumes, `b` deploys first, and a failed `b` skips `a`. `check` still reports such a cycle, as a warning.

Deploys go by level, callees first. **Callers are used for PR warnings and smoke-test scope, not for the deploy list:** a caller whose bundle didn't change gains nothing from a redeploy, because a binding resolves to the callee's active version at runtime.

## Fingerprint

```
bundleHash   = sha256( sorted (path, bytes) of the output directory, pnpm store directories normalised )
configHash   = sha256( canonical JSON of the resolved config, this env only, minus RELEASE )
externalHash = sha256( sorted (label, relative path, bytes) of what wrangler uploads from outside the output directory )
fingerprint  = sha256( bundleHash + "\n" + configHash + "\n" + externalHash )
```

`externalHash` exists because wrangler writes only code to `--outdir`. These reach Cloudflare from the source, and `configHash` holds only their paths:

- `assets.directory`, also for an assets-only worker, whose output is a fixed file.
- `site.bucket`, `wasm_modules`, `text_blobs`, `data_blobs`, and the `unsafe.capnp` schema files.
- For each `containers[]` entry with a local `image`, or named `images` with a `dockerfile`: the Dockerfile and its build context.

Rules for it:

- It uses the values for the env, and it runs after the dry run, since `build.command` can generate these inputs.
- Each input has a label, so a file moving from one input to another changes the hash, and paths are relative to the input, so a checkout path doesn't.
- **When in doubt, a file counts.** A false "changed" costs one redeploy, while a false "unchanged" never ships the change. So everything under a site bucket or a build context counts, and `include`, `exclude` and `.dockerignore` aren't read. `.git`, `.wrangler`, `.monocf` and the bundle's own output directory never count, as they change with no change to the worker.
- Assets follow wrangler's `createAssetsIgnoreFunction`: a file `.assetsignore` names isn't uploaded, so it doesn't count. `_headers`, `_redirects` and `.assetsignore` always do. Wrangler leaves them out of the asset manifest, but it sends the first two as configuration, and the third decides what the rest is.
- A configured input that's missing gets its absence hashed. Whether that's an error is wrangler's call, and the dry run has already made it.

**What `versions upload` can't carry.** It takes assets and blobs the way `deploy` does. It refuses a `site` with exit 1. For a container with an `image`, it builds nothing and rolls nothing out, with exit 0 (`containers.standard.builtImages` stays empty on that path), so the image change would never ship. So a worker with `site` or `containers` reaches Cloudflare only by `deploy`: the manifest lists these under `needsDeploy`, and an `upload` for that worker becomes a `full-deploy` with the reason `needs-deploy`.

- The bundle is produced by `wrangler deploy --dry-run --outdir <dir>` **without** `--minify`, and with `minify` removed from the config it reads. Minifier output changes across workers when an unrelated, tree-shaken export changes, which would cause false redeploys. Measured on a 30-worker monorepo: 26 of 30 minified bundles changed from one unused export; 0 of 30 unminified bundles did.
- Deploy artifacts are still minified when configured. The fingerprint is a comparison key, not a description of the upload.
- `VERSION` stays in the config, so a version bump causes a deploy.
- Only the selected env's section is hashed, so a change to another env's values doesn't redeploy this one. The top level stays in, since an env can inherit from it. A top-level field the env overrides can therefore cause a redeploy with no effect, which is the safe direction.
- `README.md` at the top of the output directory holds a timestamp, and a source map changes with line endings. Both are excluded, a `.map` only when the file it maps sits beside it, since with `find_additional_modules` any name can be a real module. Wrangler writes no config of its own to `--outdir`, so a `wrangler.json` there is a module and counts. A module called `README.md` is overwritten in the output by wrangler's own, so with additional modules on, `<base_dir>/README.md` counts as an external input whichever rules match it. That can give a false "changed", never a false "unchanged".
- pnpm cuts long `.pnpm/<dir>` names at a limit that differs per platform, and esbuild writes module paths into comments and `__commonJS` keys. Measured on a 30-worker monorepo: 14 of 30 bundles differed between Windows and Linux, in those paths only. So `bundleHash` reads every `node_modules/.pnpm/<dir>/node_modules/` in a script as one spelling. A package whose code changes still changes the hash.
- Module path comments in the bundle run from the config's directory in the run directory. The random run ID is one path segment, so the `../` count doesn't depend on it and it never appears. `--out` doesn't matter either.
- Text and data modules are hashed as bytes, like external inputs. A Windows checkout with `core.autocrlf=true` therefore gives a text module another `bundleHash` than CI does; esbuild hides this only for JavaScript. CI isn't affected and the error is in the safe direction, so line endings aren't normalised.
- The bundle differs between wrangler versions, so wrangler must be pinned. Upgrading it can redeploy a worker, wherever its bytes change. The version isn't part of the fingerprint.
- Each upload is tagged `monocf:<fingerprint>`, 64 hex characters. A tag allows up to 100 characters; a longer one fails the upload.
- `triggersHash` covers the effective `triggers.crons`, `routes` or `route`, `workers_dev` and `preview_urls`. All four inherit from the top level. `crons` is `null` when the config doesn't set it, because wrangler then leaves the deployed crons alone, unlike an explicit `[]`. `workersDev` follows wrangler's default: true when there are no routes.
- `doHash` covers the effective `migrations` and `exports`. A binding alone isn't a class lifecycle change.

`monocf bundle` writes these to `<out>/manifest.json` only when every worker built. A run that fails leaves no manifest, so an old one can't be taken for this run's. Two runs at once must use different output directories, which the default `.monocf/bundle/<env>` does for different envs. `worker -c build` shares the worker's `dist`, and running it for two envs at once failed 8 times in 40 with "Unexpected end of JSON input", against 0 in 40 for `bundle`. The shared directory is the likely cause, but the exact read that fails has not been isolated.

## State

A `StateStore` holds a per-environment manifest:

```jsonc
{
  "schemaVersion": 1,
  "env": "staging",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "workers": {
    "orders": {
      "deployedName": "orders-v1-staging",
      "bundleHash": "…",
      "configHash": "…",
      "externalHash": "…",
      "fingerprint": "…",
      "triggers": {"crons": null, "previewUrls": null, "routes": [], "workersDev": true},
      "triggersHash": "…",
      "doHash": "…",
      "versionId": "…",
      "version": "1.4.0",
      "commit": "…",
      "deployedAt": "…"
    }
  }
}
```

Hashes are plain hex, as in the bundle manifest. `bundleHash`, `configHash` and `externalHash` are required too, because they tell `bundle-changed`, `config-changed` and `external-changed` apart. A manifest with a newer `schemaVersion`, for another env, or that can't be read stops the run with exit 3: treating it as empty would plan a redeploy of everything.

Adapters: `file:<dir>` for tests and local use, written through a rename, and `r2://<bucket>/<prefix>` through `wrangler r2 object get|put --remote`, so CI needs no credentials beyond its Cloudflare token. Keys are `<env>/manifest.json` and `<env>/runs/<run-id>.json`, which rollback reads. Any other scheme is a usage error.

Both adapters refuse a location that isn't there, with exit 3. The R2 adapter checks the bucket first with `r2 bucket info`, because `r2 object get` gives the same error for a missing key and a missing bucket. A missing key in a bucket that exists is a first run. Wrangler has no conditional writes, so the store can't act as a lock: CI must allow one pipeline per environment, with `concurrency:` in GitHub Actions.

The active version comes from `wrangler deployments status --name <deployed-name> --json`. Only exit 1 with `code: 10007` means the worker doesn't exist, and any other failure stops the plan. `versions list`, `secret list` and the settings endpoint follow the latest upload, not the active version. The tag takes one more request, `versions view`, so it is read only when the version ID alone doesn't settle things. A read by name has no config for wrangler to find an `account_id` in, so a worker's own `account_id` is passed as `CLOUDFLARE_ACCOUNT_ID` for its reads. The state bucket uses the account of the environment.

**Drift** means the active version on Cloudflare isn't the one in the manifest, for example after a manual deploy. The fingerprint tag tells these apart: if the active version carries the expected tag, an earlier run deployed it and crashed before writing state, so it isn't drift. The caller chooses the policy: `--on-drift warn` overwrites and warns; `--on-drift fail` stops that worker. A split rollout counts as drift.

## Plan

`monocf plan` runs the `check` rules, where any error stops with exit 2, reuses `--bundle-dir` if its manifest matches this env, commit, wrangler and selection and otherwise bundles, then reads state and the active versions, and calls a pure function. It deploys nothing.

| Situation | Action | Reasons |
|---|---|---|
| Worker doesn't exist on Cloudflare | `create` | `new` |
| Exists, no manifest entry, a different tag, and migrations in the config | `full-deploy`, since `versions upload` refuses pending migrations and nothing says which are applied | `baseline` |
| Exists, no manifest entry, active tag is `monocf:<fingerprint>` | `adopt`: no deploy, `apply` records it in state | `state-missing` |
| Exists, no manifest entry, another tag or none | `upload` with `--on-drift warn`, `blocked` with `fail` | `baseline`, or `drift` and `baseline` when blocked |
| Manifest version is active, same fingerprint, same triggers | `skip` | `unchanged` |
| Manifest version is active, same fingerprint, other triggers | `triggers` | `triggers-changed` |
| Manifest version is active, other fingerprint, same DO hash | `upload`, with `triggersChanged` when they differ too | `bundle-changed`, `config-changed`, `external-changed` |
| Other fingerprint, other DO hash | `full-deploy` | `do-changed` |
| Another version is active, tag is `monocf:<manifest fingerprint>` | As if in sync, with the note `state-behind` | As above |
| Another version is active, tag is `monocf:<this bundle's fingerprint>` | `skip`, or `triggers` when they differ from the manifest, with the note `state-behind`: a crashed run already deployed this | `unchanged`, `triggers-changed` |
| Another version is active, any other tag | Drift | |
| Split rollout | Drift, also with no manifest entry | Adds `split` |

Drift with `--on-drift warn` takes the action the table gives, with `drift` first in its reasons and a warning. A worker that is otherwise the same still gets an `upload`, because something else is live. `triggersChanged` is true, because a manual `wrangler deploy` applies its own triggers, so what is live is unknown. With `--on-drift fail`, the worker is `blocked`, the plan is still written with `applicable: false`, and the exit code is 1. A worker with no manifest entry and another tag counts here, so `fail` blocks a first run over workers that already exist. Run that one with `warn`.

- **A new deployed name** counts as a worker with no manifest entry, with the note `renamed`. The old name stays deployed.
- **Recreated provider:** when a worker that the manifest knows has to be created, each caller through a binding that would get no new version (`skip`, `adopt` or `triggers`) becomes an `upload`, reason `provider-recreated`. A queue edge holds no binding, so it doesn't count. A caller left out by `--workers` gets the note `caller-not-selected`.
- **Crons removed:** when the manifest's crons aren't empty and the new effective crons are, the step has `explicitEmptyCrons: true`, and `apply` writes `"crons": []`, since an absent key changes nothing.
- **Orphans:** a manifest entry whose directory is gone gets the note `orphan`, and is never read or deleted. A worker in `.monocfignore` gets no read, no step and no note.

`dependsOn` holds the nearest callees that do something. It looks through a `skip` or `adopt`, so an order that runs through one still holds. Members of a cycle only a queue closes don't wait for each other. `callers` and `transitiveCallers` come from the whole graph, whatever `--workers` selects, and give the smoke-test scope.

**Secret rotation isn't drift.** `secret put` and `secret bulk` make a new active version with no tag, and on real Cloudflare its `workers/triggered_by` annotation is `secret`. When the manifest knows the worker and the active version's tag matches nothing, that annotation gives `upload` with the reason `secret-changed`, at note level, and `--on-drift fail` doesn't block it. The upload tags known code and inherits the secret, also if the secret version came from an abandoned upload. A worker with no state entry stays a baseline, since its lineage is unknown.

Reads and the state store's wrangler calls run from a new empty directory under the OS temp directory, so wrangler finds no config, no cached account and no `.env` there. A `wrangler.jsonc` at the project root would otherwise beat the account monocf passes. The account is worked out as a write's is: the worker's `account_id`, then its `.env` files, then the environment. `WRANGLER_LOG` is dropped for these calls, since debug output reaches stdout. A write passes `--config`, which rules out a root config too.

A read that fails with `fetch failed`, a 429 or a 5xx is tried up to three times, with the backoff of a write.

`--bundle-dir` reuses a bundle only if it describes this run. The env, commit and wrangler version have to match, `configHash`, `doHash` and `triggersHash` are recomputed per selected worker from the resolved config, and the bundle manifest's `head` (the real `git rev-parse HEAD`, not `GITHUB_SHA`) has to be what's checked out. A bundle built on a dirty tree is refused, and so is reuse on one. `apply` and `--expect-branch-tip` use the real `HEAD` too.

The older plan and markdown at the output paths are removed right after flag parsing, so no failed run can leave one for `apply` or a PR comment. The markdown is written before the plan, so a plan appears only when everything has succeeded. A path that can't be written is exit 3.

## Deploy

Two phases, so a bad build can't leave half the chain updated:

1. **Upload,** in parallel: `wrangler versions upload --tag … --message … --var RELEASE:<sha>`. Nothing receives traffic yet.
2. **Promote,** callees first: `wrangler versions deploy <id>@100% --yes -c <config>`, then `wrangler triggers deploy` when the triggers hash changed.

Exceptions that need a plain `wrangler deploy`:

- A worker that doesn't exist yet, because `versions upload` can't create one. These run before the upload phase, callees first, because an upload fails when a service binding's target is missing.
- A change to Durable Object classes or migrations.

The scheduler is a ready queue over the graph. On failure it skips the transitive callers of the failed worker and continues with independent branches. Each worker has one writer at a time, because parallel writes to one worker all exit 0 with a silent winner. It retries `fetch failed`, 429 and 5xx with backoff. State is written as workers finish, so an interrupted run loses nothing.

**Exit 0 isn't proof.** A step succeeded when wrangler exited with code 0 and no signal, the output file holds a version ID (`deploy`, `versions upload`), and a read-back of `deployments status` shows the expected version at 100%.

Behaviour this design has to work with:

| Change | How it reaches a running worker |
|---|---|
| Code, vars, bindings, compatibility date | `versions upload` + `versions deploy` |
| Observability | `versions deploy` with the config present, or `deploy` |
| Crons, routes, `workers_dev` | `triggers deploy` or `deploy` |
| Removing all crons | An explicit `"crons": []`; an absent key changes nothing |
| Durable Object class change | `deploy` |

A caller sees a new callee version without being redeployed, for both RPC and fetch. The exception is a callee that was deleted and recreated: its callers stay broken until they get a new version, so the planner uploads them too.

**Rollback** runs callers first. Code, vars and secrets follow the version; crons don't, so they are restored separately. Rolling back across a Durable Object class addition is refused by Cloudflare, but rolling back across a class deletion exits 0 and leaves the class broken, so monocf refuses any rollback across a DO change unless forced.

## Commands

```
monocf graph    [-e env] [--json | --mermaid] [--callers worker]
monocf check    [-e env | --all-envs] [--strict] [--json]
monocf bundle   [workers...] -e env [--out dir] [--concurrency n] [--json]
monocf plan     -e env --state <url> [--bundle-dir dir] [--out plan.json] [--markdown file] [--on-drift warn|fail] [--workers a,b] [--json]
monocf apply    <plan.json> [--concurrency n] [--expect-branch-tip ref] [--summary-file path] [--json]
monocf rollback -e env --state <url> (--to-run <id> | <worker> --to <version-id>) [--force] [--json]
monocf secrets check -e env [--json]
```

`monocf worker -c <action>` keeps working on top of the same core. `build` takes `--concurrency`, with the CPU count up to 8 as its default, and a failed build holds no other back. `deploy` and `preview` take it too, with a default of 1, in graph order, and a failure skips the worker's transitive callers while independent workers carry on. A wrangler killed by a signal from outside stops new steps. Windows can't tell such a kill from exit 1.

On Windows, stopping a process tree first runs `taskkill` without `/F`, and forces it after the 10 second grace period or on a second signal. That request only reaches a process with a window. Wrangler has none, so `taskkill` refuses and a stop that monocf starts itself, such as `dev -a` ending the others after one fails, waits out the grace period and then forces. Only a real Ctrl+C, which the console delivers to every process, lets wrangler exit by itself and remove its dev registry entry.

`graph`, `check` and `bundle` need no credentials, and the first two need no wrangler. `check` exits 2 on any error, and on any warning with `--strict`. A cycle that only a queue edge closes is a warning, as queues need no order at deploy time. `missing-main` stays quiet when a `build.command` is set, since it may generate the entry, and it takes `site` as an entry. A failure to resolve that isn't an unknown placeholder is reported under the rule `resolve-failed`. `bundle` also reports `unknown-entrypoint`, an error that exits 1, since Cloudflare never rejects a wrong entrypoint and it can fall through to the default handler. A provider with `no_bundle` keeps its author's text, which the last export statement needn't describe, so its exports count as unknown, with a warning.

A plan records the commit and wrangler version it was made for. `apply` refuses to run on any other. `--expect-branch-tip` stops a re-run of an old pipeline from deploying an old commit over a newer one.

CI should authenticate with an API token. Wrangler has no lock around OAuth refresh, and token auth stays off that path.

## Testing

Black-box tests run the built CLI against generated fixtures with a fake wrangler installed at `node_modules/wrangler`. The fake records argv, cwd and the config it receives. These tests describe behaviour rather than structure, so they survive the refactor. Pure modules get unit tests. Fixtures are synthetic.

Some facts only real wrangler can show: bundling through rebased paths, env values surviving the trip through its own `.dev.vars` reader, service bindings in `dev`, and a kill of the process doing the work. Those tests link the wrangler from this repository's dev dependencies into the fixture, with a dummy token, a closed port as the API base, `CLOUDFLARE_CF_FETCH_ENABLED=false` and metrics off, so nothing reaches Cloudflare.
