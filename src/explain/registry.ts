import type {FindingLevel} from '../check/rules.js'
import type {PlanReason} from '../plan/plan.js'

/**
 * What every code monocf prints means, and what to do about it. `monocf explain`, the error events, docs/json-output.md and the
 * README's tables all come from or are checked against this, so they can't disagree.
 */
export interface Explanation {
  meaning: string
  /** What to do next. Absent when there's nothing to do. */
  next?: string
}

/** A signal has no one exit code: it's 128 + the signal's number, such as 130 for SIGINT. `monocf commands` uses this key too. */
export const SIGNAL_EXIT = '128+n'

export type ExitCodeOf = 1 | 2 | 3 | typeof SIGNAL_EXIT

/** How an exit code reads in a table or a line of text, where `128+n` would look like a typo. */
export function exitCodeText(exitCode: ExitCodeOf): string {
  return exitCode === SIGNAL_EXIT ? '128 + n' : String(exitCode)
}

export interface ErrorExplanation extends Explanation {
  exitCode: ExitCodeOf
}

const REPLAN = 'Plan again on this commit, and apply the new plan.'

export const ERROR_CODES = {
  'account-ambiguous': {
    exitCode: 3,
    meaning: 'The login has more than one account, and nothing says which one holds the state bucket.',
    next: "Set CLOUDFLARE_ACCOUNT_ID to that account's ID.",
  },
  'auth-rate-limited': {
    exitCode: 3,
    meaning: 'Cloudflare reports too many authentication failures (10502).',
    next: 'Check the token, and wait for this to clear before trying again.',
  },
  'base-config-missing': {
    exitCode: 2,
    meaning: 'The base config that monocf.config.json or --base-config names does not exist.',
    next: 'Fix the path, or remove the setting.',
  },
  'binding-unresolved': {
    exitCode: 2,
    meaning: 'A binding targets a worker whose config could not be resolved.',
    next: 'Run monocf check to see why that worker fails to resolve.',
  },
  'branch-tip-moved': {
    exitCode: 2,
    meaning: 'The ref given to --expect-branch-tip is at a newer commit than the plan, so a newer run has taken over.',
    next: "Don't apply this plan. Let the newer run deploy.",
  },
  'check-failed': {
    exitCode: 2,
    meaning: '`plan` found check errors, so it wrote no plan.',
    next: 'Run monocf check -e <env> --json, fix the errors, and plan again.',
  },
  'checkout-dirty': {
    exitCode: 2,
    meaning: "The checkout has changes the plan doesn't include.",
    next: 'Commit them and plan again, or remove them.',
  },
  'checkout-unknown': {
    exitCode: 2,
    meaning: "git can't say whether the checkout has changes, so nothing says that the plan describes it.",
    next: 'Run apply in a git checkout with git on the PATH.',
  },
  'command-needed': {
    exitCode: 2,
    meaning: "The command line names a topic, such as secrets, and none of its commands. Without --json, monocf prints the topic's help instead.",
    next: "Run monocf commands --json, and name one of the topic's commands.",
  },
  'config-invalid': {
    exitCode: 2,
    meaning: "A config file can't be read or used: monocf.config.json, a wrangler config, the base config or a package.json. Bad JSON, an unknown key, a field of the wrong type, a null under a base config, or a worker with no name.",
    next: 'Fix the file the message names, then run monocf check.',
  },
  'entrypoint-missing': {
    exitCode: 1,
    meaning: "A service binding names an entrypoint that the worker it targets doesn't export.",
    next: 'Fix the entrypoint in the binding, or export it from the target worker.',
  },
  'flag-conflict': {
    exitCode: 2,
    meaning: "Flags that can't be used together, a flag that needs another one, or a worker name with --all.",
    next: 'Run monocf <command> --help, and drop one of the flags.',
  },
  'flag-unsupported': {
    exitCode: 2,
    meaning: 'The flag exists, but means nothing to this command or this combination of flags.',
    next: 'Run monocf <command> --help, and drop the flag.',
  },
  'force-required': {
    exitCode: 2,
    meaning: "With no run record, rollback can't check Durable Object compatibility for the version given with --to.",
    next: 'Ask a person whether to pass --force, or roll back a run with --to-run.',
  },
  'ignore-file-invalid': {
    exitCode: 2,
    meaning: '.monocfignore has a line nothing can read, or a scope naming an env no config defines.',
    next: 'Run monocf check, and fix the lines it reports as ignored-malformed or ignored-unknown-env.',
  },
  'internal-error': {
    exitCode: 1,
    meaning: 'Something went wrong that monocf did not expect.',
    next: 'Run again with DEBUG=1 for a stack trace, and report it at https://github.com/omerfardemir/monocf/issues.',
  },
  interrupted: {
    exitCode: SIGNAL_EXIT,
    meaning: 'monocf was interrupted by SIGHUP, SIGINT or SIGTERM. Partial results were reported.',
    next: 'For apply or rollback, plan again or run the rollback again, which picks up where it stopped.',
  },
  'invalid-flag-value': {
    exitCode: 2,
    meaning: "A flag or argument has a value it doesn't accept: not one of its options, not a number, empty, or not a run ID.",
    next: 'Run monocf <command> --help for the values it takes.',
  },
  'live-version-changed': {
    exitCode: 1,
    meaning: 'The version live on Cloudflare changed after the plan was made.',
    next: REPLAN,
  },
  'missing-argument': {
    exitCode: 2,
    meaning: "A required argument is missing, such as a worker name outside a worker's directory.",
    next: 'Run monocf <command> --help.',
  },
  'missing-flag': {
    exitCode: 2,
    meaning: 'A required flag is missing.',
    next: 'Run monocf <command> --help.',
  },
  'no-active-version': {
    exitCode: 1,
    meaning: 'Cloudflare reports no active version for a worker.',
    next: 'Deploy the worker once, or look at it in the dashboard.',
  },
  'no-versions': {
    exitCode: 1,
    meaning: 'The worker has no uploaded versions to deploy from.',
    next: 'Upload one first with monocf preview <worker>.',
  },
  'no-workers': {
    exitCode: 2,
    meaning: 'No workers are left to run, after .monocfignore.',
    next: 'Check the workers directory and .monocfignore.',
  },
  'node-too-old': {
    exitCode: 3,
    meaning: 'The installed wrangler needs a newer Node.js.',
    next: 'Use a newer Node.js.',
  },
  'not-authenticated': {
    exitCode: 3,
    meaning: 'wrangler has no credentials for Cloudflare.',
    next: 'Set CLOUDFLARE_API_TOKEN, or run wrangler login in a terminal.',
  },
  'output-path-unsafe': {
    exitCode: 2,
    meaning: 'An output path would empty or hold source files, or sits inside something a worker uploads.',
    next: 'Write it to a directory of its own.',
  },
  'output-unwritable': {
    exitCode: 3,
    meaning: "An output file, such as the plan or its markdown, can't be written.",
    next: 'Check the path and its permissions.',
  },
  'plan-blocked': {
    exitCode: 2,
    meaning: 'The plan is marked as not applicable: a step is blocked, usually by drift under --on-drift fail.',
    next: 'Look at the blocked steps and their notes. Plan again with --on-drift warn only if a person agrees to deploy over what is live.',
  },
  'plan-invalid': {
    exitCode: 2,
    meaning: "The plan file can't be read, isn't JSON, or isn't a plan.",
    next: 'Plan again, and pass the path plan printed.',
  },
  'plan-missing': {
    exitCode: 2,
    meaning: 'There is no plan at that path. A plan that fails writes none, and removes an earlier one there.',
    next: 'Check that plan succeeded, and pass the path it printed.',
  },
  'plan-refused': {
    exitCode: 2,
    meaning: 'apply was given a plan that a guard refused when it was made, as it looked like the wrong account or state. That plan run exited 3, and apply exits 2.',
    next: "Read the plan's refused field. Check account_id and CLOUDFLARE_ACCOUNT_ID, then plan again, with --first-run or --allow-recreate only if a person confirms it.",
  },
  'plan-schema-unsupported': {
    exitCode: 2,
    meaning: 'The plan was written by a monocf with another plan schema version.',
    next: 'Plan again with this monocf.',
  },
  'plan-stale': {
    exitCode: 2,
    meaning: "The plan doesn't describe this checkout: another commit, other configs, or a worker now ignored.",
    next: REPLAN,
  },
  'plan-wrangler-mismatch': {
    exitCode: 2,
    meaning: 'The plan was made with another wrangler version, which changes bundles.',
    next: 'Install the wrangler the plan names, or plan again.',
  },
  'record-worker-missing': {
    exitCode: 1,
    meaning: 'A worker in the run record has no directory in this checkout.',
    next: 'Roll back from a checkout that has the worker, or roll back that worker with --to.',
  },
  'rollback-refused': {
    exitCode: 1,
    meaning: "rollback refused a worker, as going back would cross a Durable Object change or one that can't be checked.",
    next: 'Ask a person whether to pass --force.',
  },
  'root-dir-missing': {
    exitCode: 2,
    meaning: "The root directory doesn't exist.",
    next: 'Fix --root-dir.',
  },
  'run-not-found': {
    exitCode: 2,
    meaning: 'The state has no run with that ID for this env.',
    next: 'Use a run ID from an earlier apply, as its run-started output or state/<env>/runs/ shows.',
  },
  'secret-env-missing': {
    exitCode: 2,
    meaning: 'secrets deploy --from-env found no value for a name a worker declares, so it uploaded nothing. An empty variable counts as unset.',
    next: "Set the variables the message names in the job's environment, for example from the CI's secrets. Never print a value.",
  },
  'secret-prefix-collision': {
    exitCode: 2,
    meaning: 'Two worker directories give the same variable prefix for secrets deploy --from-env, such as user-service and user_service.',
    next: "Rename one worker's directory, or upload those secrets from .dev.vars files.",
  },
  'secret-value-invalid': {
    exitCode: 2,
    meaning: "A secret's value can't be written to a .dev.vars file without changing it.",
    next: 'Change the value, or upload that secret with wrangler secret put.',
  },
  'secrets-file-missing': {
    exitCode: 2,
    meaning: 'Uploading secrets needs the exact .dev.vars.<env> file, and there is none.',
    next: 'Ask a person to create it. Never print or read its values.',
  },
  'state-invalid': {
    exitCode: 3,
    meaning: "The state manifest or a run record can't be trusted: a field is missing, or its schema version is newer.",
    next: 'Use a newer monocf, or ask a person to look at the state store.',
  },
  'state-scheme-unsupported': {
    exitCode: 2,
    meaning: '--state names a scheme monocf does not support.',
    next: 'Use file:<dir> or r2://<bucket>/<prefix>.',
  },
  'state-unusable': {
    exitCode: 3,
    meaning: "The state store can't be reached or read: a missing directory, a bucket that doesn't exist, or a failed read.",
    next: 'Check --state, create the directory or bucket, and check the token.',
  },
  'state-url-invalid': {
    exitCode: 2,
    meaning: '--state names no directory, or no valid bucket.',
    next: 'Use file:<dir> or r2://<bucket>/<prefix>.',
  },
  'state-write-failed': {
    exitCode: 1,
    meaning: "The state store couldn't record what a run was about to do, so nothing was changed.",
    next: 'Check the state store, and apply again.',
  },
  'unexpected-argument': {
    exitCode: 2,
    meaning: "An argument the command doesn't take.",
    next: 'Run monocf <command> --help.',
  },
  'unknown-code': {
    exitCode: 2,
    meaning: 'monocf explain was given a code it does not know.',
    next: 'Run monocf explain to list every code.',
  },
  'unknown-command': {
    exitCode: 2,
    meaning: "The command doesn't exist.",
    next: 'Run monocf commands --json to list the commands.',
  },
  'unknown-env': {
    exitCode: 2,
    meaning: 'The env is defined neither in the base config nor in the config of the worker.',
    next: 'Define it under "env", or pick another --env.',
  },
  'unknown-flag': {
    exitCode: 2,
    meaning: "A flag the command doesn't take.",
    next: 'Run monocf <command> --help.',
  },
  'unknown-placeholder': {
    exitCode: 2,
    meaning: 'A config uses a placeholder that monocf.config.json does not define, or one outside a string.',
    next: 'Define it under "variables" in monocf.config.json. To keep it literal, map it to itself there.',
  },
  'upload-unconfirmed': {
    exitCode: 1,
    meaning:
      "wrangler exited 0, but monocf can't confirm the upload: a deploy reported no version ID, or after secrets deploy Cloudflare doesn't serve a new version that holds every name.",
    next: 'After a deploy, plan again: the plan shows what went live. After secrets deploy, run secrets check, then upload again.',
  },
  'verify-mismatch': {
    exitCode: 1,
    meaning: 'After a promote, Cloudflare serves something other than the version apply deployed.',
    next: 'Look at what is live, then plan again.',
  },
  'version-not-live': {
    exitCode: 1,
    meaning: "The version the run deployed isn't live any more, and the run didn't change it, so there's nothing of its to undo.",
    next: 'Use rollback <worker> --to <version-id> to choose a version.',
  },
  'worker-exists': {
    exitCode: 2,
    meaning: 'A worker with that name already exists.',
    next: 'Pick another name.',
  },
  'worker-ignored': {
    exitCode: 2,
    meaning: '.monocfignore leaves the named worker out of this env.',
    next: 'Change its line in .monocfignore, or name another worker.',
  },
  'worker-name-invalid': {
    exitCode: 2,
    meaning: 'A worker name may hold only lowercase letters, digits and dashes, starting with a letter or a digit.',
    next: 'Pick another name.',
  },
  'worker-not-deployed': {
    exitCode: 1,
    meaning: "The worker doesn't exist on Cloudflare, so secrets deploy won't create it from what may be a typo.",
    next: 'Deploy it first, or pass --create if a person confirms the name.',
  },
  'worker-not-found': {
    exitCode: 2,
    meaning: 'No worker directory has that name.',
    next: 'Run monocf graph to list the workers.',
  },
  'workers-dir-missing': {
    exitCode: 2,
    meaning: 'The workers directory does not exist.',
    next: 'Check --root-dir, --workers-dir-name and monocf.config.json.',
  },
  'workers-failed': {
    exitCode: 1,
    meaning: 'More than one worker failed, in different ways. The exit code is the one they share, or 1.',
    next: 'Read each failure in the message, or the step-finished events.',
  },
  'wrangler-failed': {
    exitCode: 1,
    meaning: "A wrangler command failed. Its exit code and message are in monocf's message.",
    next: "Read wrangler's message, and its output on stderr.",
  },
  'wrangler-killed': {
    exitCode: SIGNAL_EXIT,
    meaning: 'A wrangler process was killed by a signal from outside.',
    next: 'Find what killed it, such as a CI timeout or a lack of memory, and run again.',
  },
  'wrangler-output-invalid': {
    exitCode: 1,
    meaning: "wrangler printed something monocf can't read.",
    next: 'Check that the wrangler version is supported, and run again.',
  },
  'wrangler-too-old': {
    exitCode: 3,
    meaning: 'The installed wrangler is older than monocf supports.',
    next: 'Install wrangler 4.151.0 or newer in the project, and pin it.',
  },
  'wrangler-unusable': {
    exitCode: 3,
    meaning: "wrangler isn't installed in the project, or it's broken, or it can't start.",
    next: 'Install wrangler as a dev dependency of the project.',
  },
} as const satisfies Record<string, ErrorExplanation>

export type ErrorCode = keyof typeof ERROR_CODES

/** The codes a ConfigError can carry: nothing was attempted. */
export type UsageErrorCode = {[K in ErrorCode]: (typeof ERROR_CODES)[K]['exitCode'] extends 2 ? K : never}[ErrorCode]

/** The codes of a problem with the machine, not the project, such as a missing wrangler. */
export type EnvironmentErrorCode = {[K in ErrorCode]: (typeof ERROR_CODES)[K]['exitCode'] extends 3 ? K : never}[ErrorCode]

/** A rule reports at one level, or at a second in some cases, as a cycle only a queue closes is a note. */
export interface CheckRuleExplanation extends Explanation {
  levels: readonly FindingLevel[]
}

/** A new rule needs an entry here before it can report anything. */
export const CHECK_RULES = {
  'cross-env-binding': {
    levels: ['error'],
    meaning: "A binding targets another env's deployed name of a worker.",
    next: 'Use the directory name of the target, which monocf rewrites for each env.',
  },
  'cross-env-route': {
    levels: ['error'],
    meaning: 'One route is claimed under more than one deployed name across envs, often a top-level route every env inherits, so whichever apply ran last holds it.',
    next: 'Move the route into the env that should serve it.',
  },
  cycle: {
    levels: ['error', 'note'],
    meaning: 'Workers bind to each other in a cycle, so nothing can deploy first. A cycle only a queue closes is a note.',
    next: 'Break the cycle, for example with a queue.',
  },
  'duplicate-binding-name': {
    levels: ['error'],
    meaning: 'A worker has more than one binding with the same name, which wrangler rejects.',
    next: 'Rename one of them.',
  },
  'duplicate-name': {
    levels: ['error'],
    meaning: 'Two workers, or one worker in two envs, deploy under the same name, so each deploy overwrites the other.',
    next: 'Give one of them another name.',
  },
  'duplicate-route': {
    levels: ['error'],
    meaning: 'Two workers claim the same route.',
    next: 'Remove the route from one of them.',
  },
  'external-binding': {
    levels: ['warning'],
    meaning: 'A binding targets a name that matches no local worker, so it passes through as external, and monocf neither orders nor checks it.',
    next: 'Nothing, if that is meant. Otherwise fix the name.',
  },
  'hardcoded-binding': {
    levels: ['error'],
    meaning: 'A service binding hardcodes a deployed name, such as orders-dev, which monocf would not rewrite for another env.',
    next: 'Use the directory name of the target.',
  },
  'ignored-dependency': {
    levels: ['error'],
    meaning: "A selected worker binds to one that's ignored in that env.",
    next: 'Stop ignoring the target in that env, or remove the binding.',
  },
  'ignored-malformed': {
    levels: ['error'],
    meaning:
      "A .monocfignore line nothing can read: a scope with no names, an empty name or something that isn't a name, as in `workers/x except a,,b` or `workers/x except production # note`; a pattern with unescaped whitespace inside or at the start, as in `workers/x excpet production`; or a scoped line whose pattern matches no directory. Every command that selects workers stops on this too, as nothing says what the line was meant to leave out.",
    next: String.raw`Fix the line. Write a space in a directory name as "\ ".`,
  },
  'ignored-negation-unused': {
    levels: ['warning'],
    meaning: 'A .monocfignore line starting with `!`, scoped or not, reaches only workers that no line before it ignores, so it does nothing.',
    next: 'Remove it. `!` undoes an earlier line; it does not mean "not".',
  },
  'ignored-stale': {
    levels: ['warning'],
    meaning: 'A .monocfignore line with no scope matches no directory.',
    next: 'Remove the line if its worker is gone.',
  },
  'ignored-unknown-env': {
    levels: ['error'],
    meaning:
      '.monocfignore has a scope naming an env that neither the base config nor any worker defines, as in `except produciton`. Every command that selects workers stops on this too.',
    next: 'Fix the env name.',
  },
  'inherited-route': {
    levels: ['warning'],
    meaning: 'This env inherits a top-level route that another env inherits too, so their workers fight over it. `check --all-envs` reports it as `cross-env-route`.',
    next: 'Move the route into the env that should serve it.',
  },
  'missing-env': {
    levels: ['error'],
    meaning: 'A selected worker does not define the env.',
    next: 'Define it under "env", or ignore the worker in that env in .monocfignore.',
  },
  'missing-main': {
    levels: ['error'],
    meaning: 'A worker has no main file that exists, and no assets or site.',
    next: 'Fix main in its config.',
  },
  'name-length': {
    levels: ['error'],
    meaning: 'A deployed name is over 63 characters, or holds something other than lowercase letters, digits and inner dashes.',
    next: 'Shorten or change the name.',
  },
  'no-compat-date': {
    levels: ['warning'],
    meaning: 'A worker has no compatibility_date.',
    next: 'Set one, in the base config or the worker config.',
  },
  'resolve-failed': {
    levels: ['error'],
    meaning: "A worker's config failed to resolve.",
    next: 'Read the message, and fix the file it names.',
  },
  'script-name-directory': {
    levels: ['error'],
    meaning: 'A Durable Object or Workflow binding names a directory, which reaches wrangler as written, not as a deployed name.',
    next: 'Use the deployed name the message gives.',
  },
  'self-binding': {
    levels: ['warning'],
    meaning: 'A worker binds to itself. It adds no order, and a first deploy of such a worker fails on Cloudflare.',
    next: 'Remove the binding, or deploy the worker once without it.',
  },
  'tail-service-directory': {
    levels: ['error'],
    meaning: 'A tail consumer or a dispatch namespace outbound names a directory, which reaches wrangler as written, not as a deployed name.',
    next: 'Use the deployed name the message gives.',
  },
  'unknown-entrypoint': {
    levels: ['error', 'warning'],
    meaning: "bundle: a service binding names an entrypoint the target doesn't export. A warning when the target's exports can't be read.",
    next: 'Fix the entrypoint, or export it.',
  },
  'unknown-placeholder': {
    levels: ['error'],
    meaning: 'A config uses a placeholder that monocf.config.json does not define, or one outside a string.',
    next: 'Define it under "variables" in monocf.config.json.',
  },
  'worker-name': {
    levels: ['warning'],
    meaning: 'A worker name deploys as something other than what is written, or starts or ends with a dash.',
    next: 'Rename it to lowercase letters, digits and inner dashes.',
  },
} as const satisfies Record<string, CheckRuleExplanation>

export type CheckRule = keyof typeof CHECK_RULES

export const PLAN_REASONS = {
  baseline: {
    meaning: 'The worker exists with no state entry, and its tag differs from this bundle: monocf has never deployed it, or lost track of it.',
    next: 'Check that it is the worker you mean. Under --on-drift fail it is blocked until a person agrees to plan with --on-drift warn.',
  },
  'bundle-changed': {meaning: 'The built code differs from what is deployed.'},
  'config-changed': {meaning: 'The resolved config for this env differs from what is deployed.'},
  'do-changed': {meaning: 'Durable Object classes or migrations changed, so the worker goes out by wrangler deploy.'},
  drift: {
    meaning: "The active version on Cloudflare isn't the one in the state, for example after someone ran wrangler deploy by hand.",
    next: 'Find out who deployed what. Under --on-drift fail the worker is blocked until a person agrees to deploy over it.',
  },
  'external-changed': {
    meaning: 'What wrangler uploads from outside the output directory changed: assets, a site bucket, modules, or a container build context.',
  },
  'needs-deploy': {meaning: "The worker has a site or a container, which versions upload can't carry, so it goes out by wrangler deploy."},
  new: {meaning: "The worker doesn't exist on Cloudflare, so apply creates it."},
  'provider-recreated': {
    meaning: 'A worker this one binds to was created again, so this one needs a new version to reach it.',
  },
  'secret-changed': {
    meaning: 'A secret command made the active version over known code. The upload tags it, and the secret carries over. Not drift.',
  },
  split: {
    meaning: 'A split rollout is live, across more than one version.',
    next: 'Finish or undo the rollout, or let a person decide to deploy over it.',
  },
  'state-behind': {
    meaning: 'The live version carries monocf\'s tag, but the state names another: a run likely stopped before writing state. apply records it and applies the triggers.',
  },
  'state-missing': {
    meaning: 'The worker is live with the tag of this bundle, but the state has no entry. apply adopts it with no new version.',
  },
  'triggers-changed': {meaning: 'The code is live, and only its triggers, such as crons or routes, are behind.'},
  unchanged: {meaning: 'Nothing changed.'},
} as const satisfies Record<PlanReason, Explanation>

export type ExplainKind = 'check-rule' | 'error' | 'plan-reason'

export interface ExplainEntry extends Explanation {
  code: string
  /** An error code's only. */
  exitCode?: ExitCodeOf
  kind: ExplainKind
  /** A check rule's only. */
  levels?: readonly FindingLevel[]
}

function entries(kind: ExplainKind, table: Record<string, CheckRuleExplanation | ErrorExplanation | Explanation>): ExplainEntry[] {
  return Object.entries(table).map(([code, explanation]) => ({code, kind, ...explanation}))
}

/** Every code, sorted by kind and then code. A code such as `drift` can be more than one kind. */
export function allEntries(): ExplainEntry[] {
  return [...entries('error', ERROR_CODES), ...entries('check-rule', CHECK_RULES), ...entries('plan-reason', PLAN_REASONS)]
}

export function explain(code: string): ExplainEntry[] {
  return allEntries().filter((entry) => entry.code === code)
}
