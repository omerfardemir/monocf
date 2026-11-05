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
- **`secrets deploy` refuses a worker that doesn't exist,** unless you pass `--create`, and `-a` now honours `.monocfignore`.
- **`build` and `dev` write the env suffix into service bindings,** as `deploy` always did.
- **`worker create`** writes a small embedded template. It no longer downloads one or runs an install.
- **`dist/wrangler.jsonc` is no longer written** by `build`.

### Added

- `monocf graph`, `check` and `bundle`, which need no credentials.
- `monocf plan`, `apply` and `rollback`, with per-environment state in an R2 bucket.
- `monocf secrets check`, which compares secret names with what's live.
- `apply` refuses, with exit 2, a checkout with changes git doesn't ignore, or one whose commit isn't the plan's. Anything a job writes before `apply` has to go outside the checkout or be ignored.
- `rollback --to-run` works on a run that failed or was interrupted: `apply` reads what's live when a step doesn't finish and records whether it changed. A worker it can't account for is refused, with exit 1, and not reported as fine.
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
