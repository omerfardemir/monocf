# AGENTS.md

To use monocf in a project, read [skills/monocf/SKILL.md](skills/monocf/SKILL.md). The rest of this file is for working on monocf itself.

## Commands

- `npm run build` compiles to `dist`. The CLI tests run `bin/run.js`, which runs `dist`, and the test setup rebuilds it first.
- `npm test` runs vitest, then lint. Tests under `test/real` run the real wrangler with no network.
- `npm run readme` regenerates the command reference in README.md. Run it after changing a command's flags, args, description or examples.
- `npm run docs` regenerates the tables of codes in docs/json-output.md, and the tables of plan reasons and `.monocfignore` rules in README.md, from the registry. Run it after `npm run build` when a code changes.

## Layout

- `src/commands/**` are thin oclif commands. Each declares `safety` and `exitCodes`, which `monocf commands --json` prints. The logic is in `src/app/**`.
- `src/errors.ts` has `MonocfError`. Throw it, or `ConfigError` for a usage or config error, with a `code`.
- `src/explain/registry.ts` holds every error code, `check` rule and plan reason, with what it means and what to do. A code, rule or reason that isn't there doesn't compile.
- `src/report/events.ts` has the NDJSON events. docs/json-output.md describes each, and `test/cli/json-output.test.ts` checks both against each other and against real output.
- `test/helpers/harness.ts` runs the CLI against a fake wrangler, `test/helpers/fake-wrangler.mjs`, and a fake Cloudflare.

## Rules

- stdout carries results only. Progress and wrangler's output go to stderr.
- Don't change human-readable output without a reason: scripts read it.
- A new field or event is fine in schema version 1. Changing what an existing one means is not.
- Account IDs never reach output, state or logs. Mask them as `abcd…wxyz`.
- Comments say why, not what. README prose is plain and direct, and `test/cli/readme.test.ts` checks every command and flag it names.
- Commit messages follow conventional commits, and CHANGELOG.md gets an entry under `## Unreleased`.
