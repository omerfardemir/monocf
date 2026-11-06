export type Step =
  | {action: 'active-version'; name: string}
  | {action: 'r2-bucket-info'; bucket: string}
  | {action: 'r2-get'; bucket: string; key: string}
  | {action: 'r2-put'; bucket: string; file: string; key: string}
  | {action: 'version-view'; name: string; versionId: string}
  | {action: 'versions-of'; name: string}
  | {action: 'build'; configPath: string; outdir: string}
  | {action: 'deploy' | 'preview'; configPath: string; secretsFile?: string}
  | {action: 'deployment-status' | 'triggers-deploy' | 'versions-list'; configPath: string}
  | {action: 'dev'; configPaths: string[]; inspectorPort?: number; persistTo: string; port?: number}
  | {action: 'secret-bulk'; configPath: string; file: string}
  | {action: 'versions-deploy'; configPath: string; versionId: string}
  | {action: 'queue-consumer-remove'; queue: string; script: string}
  | {action: 'queue-consumers'; queue: string}
  | {action: 'whoami'}

export interface ArgvOptions {
  env?: string
  message?: string
  minify?: boolean
  /** Goes to a real upload or a dev session, as `--var RELEASE:<value>`. A dry run has no use for it. */
  release?: string
  /** Goes to a real upload, as `--tag`. It's how `plan` knows monocf put a version there. */
  tag?: string
}

function flag(name: string, value: number | string | undefined): string[] {
  return value === undefined ? [] : [name, String(value)]
}

function config(configPath: string): string[] {
  return ['--config', configPath]
}

function upload(
  command: string[],
  step: {configPath: string; secretsFile?: string},
  {env, message, minify, release, tag}: ArgvOptions,
): string[] {
  return [
    ...command,
    ...flag('--env', env),
    ...(minify ? ['--minify'] : []),
    ...flag('--tag', tag),
    ...flag('--message', message),
    ...flag('--var', release === undefined ? undefined : `RELEASE:${release}`),
    ...flag('--secrets-file', step.secretsFile),
    ...config(step.configPath),
  ]
}

type QueueStep = Extract<Step, {action: 'queue-consumer-remove' | 'queue-consumers'}>
type R2Step = Extract<Step, {action: 'r2-bucket-info' | 'r2-get' | 'r2-put'}>

function isQueueStep(step: Step): step is QueueStep {
  return step.action.startsWith('queue-')
}

function isR2Step(step: Step): step is R2Step {
  return step.action.startsWith('r2-')
}

function queueArgv(step: QueueStep): string[] {
  return step.action === 'queue-consumers'
    ? ['queues', 'consumer', 'worker', 'list', step.queue, '--json']
    : ['queues', 'consumer', 'remove', step.queue, step.script]
}

function r2Argv(step: R2Step): string[] {
  switch (step.action) {
    // --pipe, not --file: on a miss --file leaves a 0-byte file behind.
    case 'r2-get': {
      return ['r2', 'object', 'get', `${step.bucket}/${step.key}`, '--remote', '--pipe']
    }

    case 'r2-put': {
      return [
        'r2',
        'object',
        'put',
        `${step.bucket}/${step.key}`,
        '--remote',
        '--file',
        step.file,
        '--content-type',
        'application/json',
      ]
    }

    case 'r2-bucket-info': {
      return ['r2', 'bucket', 'info', step.bucket]
    }
  }
}

/** Turns a step into wrangler's arguments. Pure, so every action and flag combination can be tested without a process. */
export function buildArgv(step: Step, options: ArgvOptions = {}): string[] {
  const {env, message, minify, release} = options
  const envFlag = flag('--env', env)
  if (isQueueStep(step)) return queueArgv(step)
  if (isR2Step(step)) return r2Argv(step)
  switch (step.action) {
    case 'build': {
      return [
        'deploy',
        '--dry-run',
        '--outdir',
        step.outdir,
        ...envFlag,
        ...(minify ? ['--minify'] : []),
        ...config(step.configPath),
      ]
    }

    case 'deploy': {
      return upload(['deploy'], step, options)
    }

    case 'preview': {
      return upload(['versions', 'upload'], step, options)
    }

    case 'dev': {
      return [
        'dev',
        ...envFlag,
        ...flag('--port', step.port),
        ...flag('--inspector-port', step.inspectorPort),
        '--persist-to',
        step.persistTo,
        ...flag('--var', release === undefined ? undefined : `RELEASE:${release}`),
        ...step.configPaths.flatMap((path) => config(path)),
      ]
    }

    case 'secret-bulk': {
      return ['secret', 'bulk', step.file, ...envFlag, ...config(step.configPath)]
    }

    case 'deployment-status': {
      return ['deployments', 'status', '--json', ...envFlag, ...config(step.configPath)]
    }

    case 'active-version': {
      return ['deployments', 'status', '--name', step.name, '--json']
    }

    case 'version-view': {
      return ['versions', 'view', step.versionId, '--name', step.name, '--json']
    }

    case 'versions-of': {
      return ['versions', 'list', '--name', step.name, '--json']
    }

    case 'versions-list': {
      return ['versions', 'list', '--json', ...envFlag, ...config(step.configPath)]
    }

    case 'versions-deploy': {
      return [
        'versions',
        'deploy',
        `${step.versionId}@100%`,
        '--yes',
        ...envFlag,
        ...flag('--message', message),
        ...config(step.configPath),
      ]
    }

    case 'triggers-deploy': {
      return ['triggers', 'deploy', ...envFlag, ...config(step.configPath)]
    }

    case 'whoami': {
      return ['whoami']
    }
  }
}
