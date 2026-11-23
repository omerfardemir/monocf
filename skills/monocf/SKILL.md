---
name: monocf
description: Check, plan, deploy and roll back a monorepo of Cloudflare Workers with the monocf CLI. Use when a repository has a monocf.config.json or a workers directory deployed with monocf, or when asked to plan, deploy or roll back its workers, read a monocf plan, or explain a monocf error.
---

# monocf

monocf wraps wrangler for a monorepo of Workers. It works out which worker binds to which, and deploys only what changed, callees first. This skill says how to use it safely. For flags, run `monocf <command> --help`, or `monocf commands --json` for every command at once.

## Safety

Before running a command, know what it does to Cloudflare. `monocf commands --json` gives each command's `safety`:

- `offline`: `check`, `graph`, `bundle`, `build`, `explain`, `commands`, `worker create`. Safe to run.
- `reads-cloudflare`: `plan`, `secrets check`, `whoami`, `dev`. They change nothing on Cloudflare. `plan` writes a plan file locally. `dev` runs `wrangler dev`, which reaches Cloudflare for remote bindings and can ask to log in.
- `writes-cloudflare`: `apply`, `deploy`, `preview`, `rollback`, `secrets deploy`, and the deprecated `worker`.

Rules:

- **Don't run a `writes-cloudflare` command unless a person asked for it,** for that env. `rollback --dry-run` is the one exception: it changes nothing.
- **Don't pass `--force`, `--allow-recreate` or `--first-run`, or `--on-drift warn` over a blocked plan,** unless a person asked for that flag. Each accepts a risk a guard was put there to catch.
- **Never read, print or copy `.dev.vars` files or `.env` files,** or any secret value. `secrets check` gives names only, and that's enough.
- `secrets deploy --from-env` reads values from environment variables that the CI sets from its secret store. Don't set or print them yourself. A `secret-env-missing` error names the variables a person has to add.
- `dev` keeps running until it's stopped. Don't start it in a step that waits for it to exit.

## The workflow

1. `monocf check -e <env> --json`. Exit 2 means errors: fix them first, as `plan` refuses to run over them.
2. `monocf graph -e <env> --json` to see the workers and what calls what.
3. `monocf plan -e <env> --state <url> --json`. The state URL is in the project's CI workflow, as `--state r2://...`. Read the last event, `plan`, as below.
4. Show the person the plan. Only if they agree: `monocf apply <plan file> --json`.
5. Verify: `monocf secrets check -e <env> --json`, then the project's smoke tests. A changed worker's `callers` in the plan are worth checking too.
6. If something went wrong and a person asks for it: `monocf rollback -e <env> --state <url> --to-run <run-id> --dry-run --json` first, then without `--dry-run`. The run ID is the `runId` of the `run-started` event of `apply`.

## Reading results

Pass `--json`. stdout then carries only JSON. Progress goes to stderr, which you can read but shouldn't parse.

- **Exit codes:** 0 ok; 1 a worker failed, or `plan` found drift that blocks a worker; 2 a usage or config error, or a stale plan, and nothing was attempted; 3 an environment problem, such as no wrangler, no credentials or an unusable state store; 128 + n a signal. `plan` also exits 3 when a guard refuses the plan: it still prints the `plan` event, with `refused` set, and no `error` event. `apply` of that plan fails with `plan-refused`, exit 2.
- **Every failure ends in one `error` event:** `{"type":"error","code":"...","exitCode":2,"message":"...","hint":"..."}`. Act on `code` and `hint`, not on the message. `monocf explain <code>` says what a code means and what to do next.
- **A plan** is in the `plan` event's `plan` field and in the file at `path`. Look at:
  - `applicable`: false means `apply` will refuse it.
  - `refused`: a guard thinks this is the wrong account or state. Tell the person; don't add `--first-run` or `--allow-recreate` yourself.
  - `steps[].action`: `skip`, `upload`, `triggers`, `full-deploy`, `create`, `adopt` or `blocked`.
  - `steps[].reasons`: why. `monocf explain <reason>` explains each one, such as `drift` or `provider-recreated`.
  - `notes[]`: what to know, with a `kind` and a `message`.
- **check** prints one document, with `findings[]`, each with a `rule`. `monocf explain <rule>` says how to fix it.

docs/json-output.md in the monocf package describes every event and field.

## Usual recoveries

- `missing-flag`, `unknown-flag`, `flag-conflict`: read `monocf <command> --help`.
- `check-failed`: run `monocf check -e <env> --json`, fix the findings, plan again.
- A blocked plan (`plan` exits 1, steps with `blocked` and reason `drift`): someone changed what's live. Tell the person what the notes say. Plan again with `--on-drift warn` only if they agree to deploy over it.
- `plan-stale`, `checkout-dirty`, `plan-wrangler-mismatch`, `live-version-changed`: plan again on a clean checkout of the commit to deploy, then apply the new plan.
- `branch-tip-moved`: a newer commit has taken over. Don't apply this plan.
- `not-authenticated`, `account-ambiguous`: the environment needs `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` when the login reaches more than one account. Ask the person; don't log in for them.
- `state-unusable`: check the `--state` URL. A missing bucket or directory is for a person to create.
- `wrangler-unusable`, `wrangler-too-old`: wrangler 4.151.0 or newer must be installed in the project.
- Exit 1 from `apply` or `rollback` with `wrangler-failed`: read the `step-finished` events with `status: "failed"`. State records what finished, so planning again picks up from there.
