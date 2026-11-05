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
- **A worker in `.monocfignore` no longer runs by name.** In 0.2.1, a per-worker script such as `monocf worker orders -c build` ran in an ignored worker. Now it exits 2, and that fails a monorepo's `build` for that worker. Remove the line, or scope it so that it leaves out the env the script uses: `except production,local` for a script with `-e local`, and `in <envs>` for a script with no `-e`, which any `except` line covers. Or take the worker out of the script.
- **A line with a whole word `in` or `except` after its pattern is now a scope** in `.monocfignore`. A directory with such a name can still be written by escaping the space.
- **A pattern with an unescaped space inside it is now an error** in `.monocfignore`, in a file with no scopes too. `workers/x excpet production` used to stay a literal pattern that matched nothing, with a warning, and the worker was selected everywhere. It now fails `check`, and every command that selects workers exits 2. Write a space in a directory name as `\ `. Comments, blank lines, and whitespace at the start or end of a line are as before.
- **`secrets deploy` refuses a worker that doesn't exist,** unless you pass `--create`, and `-a` now honours `.monocfignore`.
- **`build` and `dev` write the env suffix into service bindings,** as `deploy` always did.
- **`worker create`** writes a small embedded template. It no longer downloads one or runs an install.
- **`dist/wrangler.jsonc` is no longer written** by `build`.

### Added

- `monocf graph`, `check` and `bundle`, which need no credentials.
- `monocf plan`, `apply` and `rollback`, with per-environment state in an R2 bucket.
- `monocf secrets check`, which compares secret names with what's live.
- A `.monocfignore` line can apply to some environments: `workers/load-test in dev,staging`, or `workers/nightly-report except production`. Every command resolves the ignored set for its env. `except` also covers `local` and a command with no env, so write `except production,local` to allow `-e local`. **Scoped lines need 0.3.0 or later:** an older monocf reads one as a literal pattern, so the worker silently stops being ignored.
- `check` rules `ignored-malformed` and `ignored-unknown-env`, and an `ignored-but-deployed` note in `plan`.
- `apply` refuses, with exit 2, a checkout with changes git doesn't ignore, or one whose commit isn't the plan's. Anything a job writes before `apply` has to go outside the checkout or be ignored. In a `file:` state directory only the manifests and run records are exempt, and `plan` and `apply` refuse a state or `--bundle-dir` directory that contains the project root or a worker.
- `rollback --to-run` works on a run that failed or was interrupted: `apply` reads what's live when a step doesn't finish and records whether it changed. A worker it can't account for is refused, with exit 1, and not reported as fine. A rollback that fails reads what's live in the same way.
- `apply` stops a `triggers` or `adopt` step, with nothing written, if what's live has moved since the plan. Under a `build.command`, the state records what was really uploaded, so a file going back to what the plan saw is a change.
- `plan` refuses a `--markdown` path inside something a selected worker uploads, such as its assets directory.
- With `CI` set, wrangler's output is piped and has the account ID taken out even on a terminal, as a CI can allocate a pty.
- `monocf build`, `deploy`, `preview` and `dev`, over the same code as `monocf worker -c`.
- `--json` on every command that runs workers, with a `schemaVersion`.
- `--no-` forms of `--deploy-bindings`, `--deploy-secrets` and `--minify`.
- `--concurrency` on `build`, `deploy` and `preview`.
- Bindings to workers outside the monorepo pass through, with a notice.
- JSONC in `monocf.config.json`.

### Deprecated

- `monocf worker -c <action>`. It still works, and prints one line on stderr. Use `monocf <action>`.

### Fixed

- Parallel runs no longer fail or deploy the wrong config, because each run has a private directory.
- `.dev.vars` is never rewritten, so values can't be truncated and root secrets can't leak into a worker's file.
- Binding cycles no longer hang `build` and `dev`.
- Wrangler runs with no shell, so paths with spaces and messages with spaces work, and a message can't inject a command.
- A signal stops wrangler and cleans up, rather than leaving a deploy running.
- Debug output is gone from stdout.
