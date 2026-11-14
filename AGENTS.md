# AGENTS.md

To use monocf in a project, read [skills/monocf/SKILL.md](skills/monocf/SKILL.md). The rest of this file is for working on monocf itself.

## Commands

- `npm run build` compiles to `dist`. The README and skill tests read the commands from `dist`, and the test setup rebuilds it first.
- `npm test` runs vitest, then lint. The tests are in-process unit tests and take seconds. None runs the CLI as a process or the real wrangler, so try a change to a command by hand with `./bin/run.js` before calling it done.
- `npm run readme` regenerates the command reference in README.md. Run it after changing a command's flags, args, description or examples.
- `npm run docs` regenerates the tables of codes in docs/json-output.md, and the tables of plan reasons and `.monocfignore` rules in README.md, from the registry. Run it after `npm run build` when a code changes.

## Layout

- `src/commands/**` are thin oclif commands. Each declares `safety` and `exitCodes`, which `monocf commands --json` prints. The logic is in `src/app/**`.
- `src/errors.ts` has `MonocfError`. Throw it, or `ConfigError` for a usage or config error, with a `code`.
- `src/explain/registry.ts` holds every error code, `check` rule and plan reason, with what it means and what to do. A code, rule or reason that isn't there doesn't compile.
- `src/report/events.ts` has the NDJSON events. docs/json-output.md describes each.
- `test/helpers/harness.ts` creates a fixture project with a fake wrangler, `test/helpers/fake-wrangler.mjs`, and a fake Cloudflare, for the tests that spawn wrangler.

## Rules

- stdout carries results only. Progress and wrangler's output go to stderr.
- Don't change human-readable output without a reason: scripts read it.
- A new field or event is fine in schema version 1. Changing what an existing one means is not.
- Account IDs never reach output, state or logs. Mask them as `abcd…wxyz`.
- Comments say why, not what. README prose is plain and direct, and `test/documentation/readme.test.ts` checks every command and flag it names.
- Commit messages follow conventional commits, and CHANGELOG.md gets an entry under `## Unreleased`.
