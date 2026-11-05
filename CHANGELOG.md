# Changelog

## 0.3.0

monocf can now run a Cloudflare Workers monorepo from CI: a dependency graph, a plan, an apply that deploys only what changed, and a rollback. The middle of the tool was rewritten, so runs no longer write temp files or edit `.dev.vars` next to your source. See the [migration notes](README.md#migrating-from-02).

### Breaking changes

- **Node.js 22 or newer** is required.
- **wrangler is a peer dependency,** at 4.151.0 or newer. Install it in your project and pin it. monocf finds it from your project root and refuses an older one with exit 3.
- **`docker start` and `docker stop` are removed.** They couldn't work as written.
- **Secret uploads have no fallback.** `-s` and `secrets deploy` read the exact `.dev.vars.<env>` file, or stop with exit 2. Before, development values could reach production when that file was missing.
- **`-e dev` reads `.dev.vars.dev`,** like any other env.
- **Mistakes that used to pass now fail with exit 2:** an unknown `--env`, a named worker that is missing or in `.monocfignore`, an unknown key in `monocf.config.json`, an unknown placeholder, `null` in a worker config under a base config, and a flag that means nothing to its command, such as `--deploy-from-version-id` without `--from-version`.
- **Exit codes changed.** 1 means a worker failed, 2 a usage or config error, 3 an environment error. A failed wrangler gives 1, with its own code in the message. A wrangler killed by a signal no longer counts as success.
- **A worker in `.monocfignore` named on the command line fails with exit 2.** 0.2.1 printed `Worker orders is ignored, skipping` and exited 0 with nothing run, for `worker orders -c build` and the rest, also when the worker came from the directory you ran in. Only `secrets deploy` really ran in an ignored worker. So a monorepo `build` that runs a per-worker script such as `monocf worker orders -c build` in an ignored worker used to pass and now fails. Remove the line, or scope it so that it doesn't apply in the env the script uses: a script with `-e local` needs `local` in an `except` list, as in `except production,local`, and a script with no `-e` needs an `in` line. Or take the worker out of the script.
- **A line with a whole word `in` or `except` after its pattern is now a scope** in `.monocfignore`. A directory with such a name can still be written by escaping the space.
- **Whitespace inside or at the start of a `.monocfignore` pattern is now an error,** in a file with no scopes too. `workers/x excpet production`, `workers/x IN dev`, `workers/x # except production` and an indented `  workers/x` all used to stay patterns that matched nothing, and the worker was selected everywhere. They now fail `check`, and every command that selects workers exits 2. Write a space in a directory name as `\ `, and take out the indent. A line such as `my worker` that was valid before is refused too. Comments, indented ones included, blank lines, and whitespace at the end of a line are as before.
- **`VERSION`, `ENVIRONMENT` and `NAME` in a worker's own config win.** 0.2.1 overwrote them with its injected values. Now a worker that sets one in its own config, in the section for the env, such as `"VERSION": "mine"`, keeps its own, so a deployed worker's value can change with no diff in your configs. One from the base config is still overwritten. See [Injected vars](README.md#injected-vars).
- **`RELEASE` goes to wrangler as `--var RELEASE:<sha>`,** at `deploy`, `preview`, `dev` and `apply` only, and comes from `GITHUB_SHA` when it's set. 0.2.1 wrote it into the config vars from `git log` for every command, `build` and `secrets` included.
- **`main`, `types` and the `.d.ts` files are gone from the package.** monocf is a command-line tool, and `import('monocf')` now fails with `ERR_MODULE_NOT_FOUND`.
- **`secrets deploy` refuses a worker that doesn't exist,** unless you pass `--create`, and `-a` now honours `.monocfignore`.
- **`build` and `dev` write the env suffix into service bindings,** as `deploy` always did.
- **`worker create`** writes a small embedded template. It no longer downloads one or runs an install.
- **`dist/wrangler.jsonc` is no longer written** by `build`.

### Added

- `monocf graph`, `check` and `bundle`, which need no credentials.
- `monocf plan`, `apply` and `rollback`, with per-environment state in an R2 bucket.
- `monocf secrets check`, which compares secret names with what's live, and prints its results on stdout.
- A `.monocfignore` line can apply to some environments: `workers/load-test in dev,staging`, or `workers/nightly-report except production`. Every command resolves the ignored set for its env. `except` also covers `local` and a command with no env, so write `except production,local` to allow `-e local`. **Scoped lines need 0.3.0 or later:** an older monocf reads one as a literal pattern, so the worker silently stops being ignored.
- `check` rules `ignored-malformed` and `ignored-unknown-env`, and an `ignored-but-deployed` note in `plan`. Both rules stop every command that selects workers too. A scoped line whose pattern matches no directory, as in `workers/nightlly except production`, is malformed, while a line with no scope that matches nothing stays an `ignored-stale` warning. When a scope names an env that no config defines and a config doesn't parse, the message names that config. A warning, `ignored-negation-unused`, for a `!` line that undoes nothing because no line before it ignores what it reaches.
- `apply` refuses, with exit 2, a checkout with changes git doesn't ignore, or one whose commit isn't the plan's. Anything a job writes before `apply` has to go outside the checkout or be ignored. In a `file:` state directory only the manifests, a temporary file a killed manifest write leaves, and run records are exempt, and `plan` and `apply` refuse a state or `--bundle-dir` directory that contains the project root or a worker.
- `rollback --to-run` works on a run that failed or was interrupted: `apply` reads what's live when a step doesn't finish and records whether it changed. A worker it can't account for is refused, with exit 1, and not reported as fine. A rollback that fails reads what's live in the same way.
- `apply` stops a `triggers` or `adopt` step, with nothing written, if what's live has moved since the plan. Under a `build.command`, the state records what was really uploaded, so a file going back to what the plan saw is a change.
- `plan` refuses a `--markdown` path inside something a selected worker uploads, such as its assets directory.
- `apply` sees a change to `queues.consumers`, the Workflows a worker defines, `tail_consumers` and `streaming_tail_consumers` on a live worker, and makes it reach Cloudflare: a promote alone never did, and `apply` exited 0 with the old settings live. It detaches a queue consumer the config dropped, and clears tail consumers the config dropped. A Workflow the config dropped stays registered, as nothing in wrangler deletes one, and `plan` says so with a `workflow-removed` note. `rollback` puts all of these back too.
- An `r2://` state bucket that a login with several accounts can't choose an account for names `CLOUDFLARE_ACCOUNT_ID`, rather than giving wrangler's message alone.
- A Cloudflare API rate limit (`[code: 10429]`, "Rate limited") is retried like a 429, on the state bucket too. A state bucket that can't be used gets the advice to create it only when it doesn't exist. `apply` on a plan file that isn't there says there's no plan, and that a plan that fails removes an earlier one.
- With `CI` set, wrangler's output is piped and has the account ID taken out even on a terminal, as a CI can allocate a pty.
- `monocf build`, `deploy`, `preview` and `dev`, over the same code as `monocf worker -c`.
- `dev <worker>` also starts the workers it reaches through a Durable Object or Workflow binding with a `script_name`, gives every worker in the session `RELEASE`, and says when a queue consumer or tail consumer it sends to isn't in the session.
- `--json` on every command that runs workers, with a `schemaVersion`.
- A `check` warning, `worker-name`, for a name that deploys as something other than what's written, such as `orDers`, which deploys as `or-ers`, or that starts or ends with a dash. The same notice shows on every command that resolves the worker.
- A Durable Object, Workflow or tail consumer that names the deployed name of the same env, as it has to, gets no "hardcodes" notice any more. The notice that remains names its field, as in `services B`.
- A `note` level in `check`, which `--strict` doesn't count. A cycle that only a queue closes is a note, as it's fine at deploy time, so it no longer fails `check --strict`. `check --json` has a `notes` count.
- `--no-` forms of `--deploy-bindings`, `--deploy-secrets` and `--minify`.
- `--concurrency` on `build`, `deploy` and `preview`.
- `build`, `dev`, `preview` and `deploy` list in `--help` only the flags each one takes. A flag another of them takes is refused with exit 2, as before.
- Bindings to workers outside the monorepo pass through, with a notice.
- JSONC in `monocf.config.json`.

### Deprecated

- `monocf worker -c <action>`. It still works, and prints one line on stderr. Use `monocf <action>`.
- `worker create --rootDir` and `--workersDirName`. They still work. Use `--root-dir` and `--workers-dir-name`, as every other command does.

### Fixed

- Parallel runs no longer fail or deploy the wrong config, because each run has a private directory.
- `.dev.vars` is never rewritten, so values can't be truncated and root secrets can't leak into a worker's file.
- Binding cycles no longer hang `build` and `dev`.
- Wrangler runs with no shell, so paths with spaces and messages with spaces work, and a message can't inject a command.
- A signal stops wrangler and cleans up, rather than leaving a deploy running.
- Debug output is gone from stdout.
- `worker create` creates the workers directory when it doesn't exist yet, rather than failing.
- An `orphan` note clears: once the worker is deleted from Cloudflare too, `plan` notes `orphan-gone` and `apply` drops its entry from the state.
- `apply` and `rollback` exit with 128 + n when a wrangler is killed by signal n from outside, as single-worker commands did, rather than 1.
