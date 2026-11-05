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
- **One run directory per process:** `<root>/.monocf/runs/<random-id>/<worker>/`. It is created with mode `0700`, and secret files with `0600`. It is removed on every exit path. A crash leaves only ignorable files, and at startup a run is removed if its owner PID is dead or if it is older than a day. MonoCF doesn't touch a consumer's `.gitignore` except in `worker create`, and the docs advise adding `.monocf/`.
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
| 130 / 143 | Interrupted; partial results reported |
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
  - Its account cache goes to the nearest `node_modules/.cache/wrangler` above the run directory, which is the one at the project root rather than the worker's.
  - `.dev.vars` and, with `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV`, `.env` are read next to the config. They already were, so a `.env` in a worker's source directory is not read, and monocf writes only the `.dev.vars` it merged. Wrangler 4.151 reads no other `.env` from the working directory.

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

Deploys go by level, callees first. **Callers are used for PR warnings and smoke-test scope, not for the deploy list:** a caller whose bundle didn't change gains nothing from a redeploy, because a binding resolves to the callee's active version at runtime.

## Fingerprint

```
bundleHash  = sha256( sorted (path, bytes) of the output directory, pnpm store directories normalised )
configHash  = sha256( canonical JSON of the resolved config, this env only, minus RELEASE )
fingerprint = sha256( bundleHash + "\n" + configHash )
```

- The bundle is produced by `wrangler deploy --dry-run --outdir <dir>` **without** `--minify`, and with `minify` removed from the config it reads. Minifier output changes across workers when an unrelated, tree-shaken export changes, which would cause false redeploys. Measured on a 30-worker monorepo: 26 of 30 minified bundles changed from one unused export; 0 of 30 unminified bundles did.
- Deploy artifacts are still minified when configured. The fingerprint is a comparison key, not a description of the upload.
- `VERSION` stays in the config, so a version bump causes a deploy.
- Only the selected env's section is hashed, so a change to another env's values doesn't redeploy this one. The top level stays in, since an env can inherit from it. A top-level field the env overrides can therefore cause a redeploy with no effect, which is the safe direction.
- `README.md` at the top of the output directory holds a timestamp, `.map` files change with line endings, and `wrangler.json*` at the top is the config, hashed on its own. All are excluded.
- pnpm cuts long `.pnpm/<dir>` names at a limit that differs per platform, and esbuild writes module paths into comments and `__commonJS` keys. Measured on a 30-worker monorepo: 14 of 30 bundles differed between Windows and Linux, in those paths only. So `bundleHash` reads every `node_modules/.pnpm/<dir>/node_modules/` in a script as one spelling. A package whose code changes still changes the hash.
- Module path comments in the bundle run from the config's directory in the run directory. The random run ID is one path segment, so the `../` count doesn't depend on it and it never appears. `--out` doesn't matter either.
- The bundle differs between wrangler versions, so wrangler must be pinned. Upgrading it redeploys everything.
- Each upload is tagged `monocf:<fingerprint>`, 64 hex characters. A tag allows up to 100 characters; a longer one fails the upload.
- `triggersHash` covers the effective `triggers.crons`, `routes` or `route`, `workers_dev` and `preview_urls`. All four inherit from the top level. `crons` is `null` when the config doesn't set it, because wrangler then leaves the deployed crons alone, unlike an explicit `[]`. `workersDev` follows wrangler's default: true when there are no routes.
- `doHash` covers the effective `migrations` and `exports`. A binding alone isn't a class lifecycle change.

`monocf bundle` writes these to `<out>/manifest.json` only when every worker built. A run that fails leaves no manifest, so an old one can't be taken for this run's. Two runs at once must use different output directories, which the default `.monocf/bundle/<env>` does for different envs. `worker -c build` shares the worker's `dist`, so running it for two envs at once can fail: wrangler may read a source map the other process is writing.

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
      "fingerprint": "sha256:…",
      "triggers": {"crons": [], "routes": [], "workersDev": true},
      "triggersHash": "sha256:…",
      "doHash": "sha256:…",
      "versionId": "…",
      "version": "1.4.0",
      "commit": "…",
      "deployedAt": "…"
    }
  }
}
```

Adapters: `file:<path>` for tests and local use, `r2://<bucket>/<prefix>` through `wrangler r2 object get|put --remote`, so CI needs no credentials beyond its Cloudflare token. Each run also writes `runs/<run-id>.json`, which rollback reads.

The R2 adapter checks the bucket first, because `r2 object get` gives the same error for a missing key and a missing bucket. Treating a missing bucket as empty state would plan a full redeploy. Wrangler has no conditional writes, so the store can't act as a lock: CI must allow one pipeline per environment.

The active version comes from `wrangler deployments status --json`. `versions list`, `secret list` and the settings endpoint follow the latest upload, not the active version.

**Drift** means the active version on Cloudflare isn't the one in the manifest, for example after a manual deploy. The fingerprint tag tells these apart: if the active version carries the expected tag, an earlier run deployed it and crashed before writing state, so it isn't drift. The caller chooses the policy: `--on-drift warn` overwrites and warns; `--on-drift fail` stops that worker. A split rollout counts as drift.

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
monocf plan     -e env --state <url> [--out plan.json] [--markdown file] [--on-drift warn|fail] [--json]
monocf apply    <plan.json> [--concurrency n] [--expect-branch-tip ref] [--summary-file path] [--json]
monocf rollback -e env --state <url> (--to-run <id> | <worker> --to <version-id>) [--force] [--json]
monocf secrets check -e env [--json]
```

`monocf worker -c <action>` keeps working on top of the same core. `build` takes `--concurrency`, with the CPU count up to 8 as its default, and a failed build holds no other back. `deploy` and `preview` take it too, with a default of 1, in graph order, and a failure skips the worker's transitive callers while independent workers carry on. A wrangler killed by a signal from outside stops new steps. Windows can't tell such a kill from exit 1.

`graph`, `check` and `bundle` need no credentials, and the first two need no wrangler. `check` exits 2 on any error, and on any warning with `--strict`. A cycle that only a queue edge closes is a warning, as queues need no order at deploy time. A failure to resolve that isn't an unknown placeholder is reported under the rule `resolve-failed`. `bundle` also reports `unknown-entrypoint`, an error that exits 1, since Cloudflare never rejects a wrong entrypoint and it can fall through to the default handler.

A plan records the commit and wrangler version it was made for. `apply` refuses to run on any other. `--expect-branch-tip` stops a re-run of an old pipeline from deploying an old commit over a newer one.

CI should authenticate with an API token. Wrangler has no lock around OAuth refresh, and token auth stays off that path.

## Testing

Black-box tests run the built CLI against generated fixtures with a fake wrangler installed at `node_modules/wrangler`. The fake records argv, cwd and the config it receives. These tests describe behaviour rather than structure, so they survive the refactor. Pure modules get unit tests. Fixtures are synthetic.

Some facts only real wrangler can show: bundling through rebased paths, env values surviving the trip through its own `.dev.vars` reader, service bindings in `dev`, and a kill of the process doing the work. Those tests link the wrangler from this repository's dev dependencies into the fixture, with a dummy token, a closed port as the API base, `CLOUDFLARE_CF_FETCH_ENABLED=false` and metrics off, so nothing reaches Cloudflare.
