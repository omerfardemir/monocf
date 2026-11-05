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
- **One run directory per process:** `<root>/.monocf/runs/<random-id>/<worker>/`. It is created with mode `0700`, and secret files with `0600`. It is removed on every exit path. A crash leaves only ignorable files, and stale runs are removed at startup.
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

### Option precedence

`flags > monocf.config.json > defaults`. Booleans support `--no-x`. Unsupported flag combinations are errors, never ignored.

## Config resolution

- Base and worker configs are parsed with `jsonc-parser`, not with wrangler's `experimental_*` APIs.
- **Merge semantics stay compatible by default.** Arrays are concatenated, objects merge recursively, and scalars from the worker win. Any change needs an opt-in and a diff tool.
- Placeholders are replaced on parsed strings. An unknown placeholder is an error. A string that needs literal braces maps the variable to itself: `"id": "{id}"`.
- Injected vars: `NAME`, `ENVIRONMENT`, `VERSION`. A value set in the worker's own config is kept. A value from the base config is overwritten, as before.
- The resolved config is the form `deploy` and `preview` receive: a service binding given by directory name becomes the target's deployed name for the env. `build` and `dev` used to leave out the env suffix.
- A worker that can't be resolved stops only a run that selects it or has a service binding to it, so one broken config doesn't block unrelated deploys.
- `RELEASE` is **not** part of the resolved config. It is passed at deploy time with `--var RELEASE:<sha>`, so a new commit with an unchanged bundle has an unchanged fingerprint. The SHA is resolved once per run, from `GITHUB_SHA` when set, else `git rev-parse --short HEAD`.
- An unknown `--env` is an error, so a typo can't create an orphan worker.
- Moving a config into the run directory means relative path fields must be rebased. The list of these fields lives in one file. A test reads wrangler's `config-schema.json` and fails when a new path-like field appears.

## Graph

Edges come from:

| Source | Target |
|---|---|
| `services[].service` | Worker |
| `workflows[].script_name` | Worker |
| `durable_objects.bindings[].script_name` | Worker |
| `tail_consumers[].service` | Worker |
| Queue producers and consumers | Logical edge: consumer of a queue the worker produces to |

Binding names that match no local worker pass through as external, with a notice. They are not part of the graph.

Deploys go by level, callees first. **Callers are used for PR warnings and smoke-test scope, not for the deploy list:** a caller whose bundle didn't change gains nothing from a redeploy, because a binding resolves to the callee's active version at runtime.

## Fingerprint

```
sha256( canonical(resolved config minus RELEASE) + sorted(path + bytes of each bundled module) )
```

- The bundle is produced by `wrangler deploy --dry-run --outdir <dir>` **without** `--minify`. Minifier output changes across workers when an unrelated, tree-shaken export changes, which would cause false redeploys. Measured on a 30-worker monorepo: 26 of 30 minified bundles changed from one unused export; 0 of 30 unminified bundles did.
- Deploy artifacts are still minified when configured. The fingerprint is a comparison key, not a description of the upload.
- `VERSION` stays in the config, so a version bump causes a deploy.
- `README.md` in the output directory holds a timestamp, and `.map` files change with line endings, so both are excluded. `index.js` was byte-identical across Windows and Linux, checkout path, working directory and Node version.
- The bundle differs between wrangler versions, so wrangler must be pinned. Upgrading it redeploys everything.
- Each upload is tagged `monocf:<fingerprint>`. A tag allows up to 100 characters; a longer one fails the upload.

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
monocf graph    [-e env] [--json | --mermaid]
monocf check    [-e env | --all-envs] [--json]
monocf bundle   [workers...] -e env [--out dir] [--concurrency n] [--json]
monocf plan     -e env --state <url> [--out plan.json] [--markdown file] [--on-drift warn|fail] [--json]
monocf apply    <plan.json> [--concurrency n] [--expect-branch-tip ref] [--summary-file path] [--json]
monocf rollback -e env --state <url> (--to-run <id> | <worker> --to <version-id>) [--force] [--json]
monocf secrets check -e env [--json]
```

`monocf worker -c <action>` keeps working on top of the same core.

A plan records the commit and wrangler version it was made for. `apply` refuses to run on any other. `--expect-branch-tip` stops a re-run of an old pipeline from deploying an old commit over a newer one.

CI should authenticate with an API token. Wrangler has no lock around OAuth refresh, and token auth stays off that path.

## Testing

Black-box tests run the built CLI against generated fixtures with a fake wrangler installed at `node_modules/wrangler`. The fake records argv, cwd and the config it receives. These tests describe behaviour rather than structure, so they survive the refactor. Pure modules get unit tests. Fixtures are synthetic.
