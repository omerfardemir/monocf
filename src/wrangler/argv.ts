export type Step =
  | {action: 'build'; configPath: string; outdir: string}
  | {action: 'deploy' | 'preview'; configPath: string; secretsFile?: string}
  | {action: 'deployment-status' | 'triggers-deploy' | 'versions-list'; configPath: string}
  | {action: 'dev'; configPaths: string[]; inspectorPort?: number; persistTo: string; port?: number}
  | {action: 'secret-bulk'; configPath: string; file: string}
  | {action: 'versions-deploy'; configPath: string; versionId: string}
  | {action: 'whoami'}

export interface ArgvOptions {
  env?: string
  message?: string
  minify?: boolean
  /** Goes to a real upload or a dev session, as `--var RELEASE:<value>`. A dry run has no use for it. */
  release?: string
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
  {env, message, minify, release}: ArgvOptions,
): string[] {
  return [
    ...command,
    ...flag('--env', env),
    ...(minify ? ['--minify'] : []),
    ...flag('--message', message),
    ...flag('--var', release === undefined ? undefined : `RELEASE:${release}`),
    ...flag('--secrets-file', step.secretsFile),
    ...config(step.configPath),
  ]
}

/** Turns a step into wrangler's arguments. Pure, so every action and flag combination can be tested without a process. */
export function buildArgv(step: Step, options: ArgvOptions = {}): string[] {
  const {env, message, minify, release} = options
  const envFlag = flag('--env', env)
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

    case 'versions-list': {
      return ['versions', 'list', '--json', ...envFlag, ...config(step.configPath)]
    }

    case 'versions-deploy': {
      return [
        'versions',
        'deploy',
        '--yes',
        '--version-id',
        step.versionId,
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
