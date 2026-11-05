// Stand-in for the wrangler CLI. A fixture installs a stub at node_modules/wrangler/wrangler-dist/cli.js that imports
// this file. Every invocation appends one JSON line to FAKE_WRANGLER_LOG; behaviour comes from FAKE_WRANGLER_RULES.
import {spawn} from 'node:child_process'
import {appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {basename, dirname, join, resolve} from 'node:path'
import dotenv from 'dotenv'
import {parse} from 'jsonc-parser'

const argv = process.argv.slice(2)

function flagValues(names) {
  const values = []
  for (const [index, arg] of argv.entries()) {
    if (names.includes(arg)) {
      values.push(argv[index + 1])
      continue
    }

    const name = names.find((candidate) => arg.startsWith(`${candidate}=`))
    if (name) values.push(arg.slice(name.length + 1))
  }

  return values
}

function modeOf(path) {
  // eslint-disable-next-line no-bitwise
  return statSync(path).mode & 0o777
}

function readSecretFile(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  let vars
  try {
    vars = JSON.parse(raw)
  } catch {
    vars = dotenv.parse(raw)
  }

  return {mode: modeOf(filePath), name: basename(filePath), raw, vars}
}

function startsWithCommand(prefix) {
  const words = prefix.split(' ')
  return words.every((word, index) => argv[index] === word)
}

const configPaths = flagValues(['-c', '--config']).map((configPath) => resolve(configPath))
const configs = configPaths.map((configPath) => parse(readFileSync(configPath, 'utf8')))
const configPath = configPaths[0]
const config = configs[0] ?? null

const envName = flagValues(['--env', '-e'])[0]
const deployedName = (envName && config?.env?.[envName]?.name) || config?.name
const workerDir = configPath ? basename(dirname(configPath)) : undefined

const devVarsPath = configPath && join(dirname(configPath), '.dev.vars')
const mainPath = configPath && config?.main && resolve(dirname(configPath), config.main)

const entry = {
  argv,
  config,
  configDir: configPath && dirname(configPath),
  configDirMode: configPath && modeOf(dirname(configPath)),
  configPaths,
  configs,
  cwd: process.cwd(),
  devVars: devVarsPath && existsSync(devVarsPath) ? dotenv.parse(readFileSync(devVarsPath, 'utf8')) : null,
  devVarsMode: devVarsPath && existsSync(devVarsPath) ? modeOf(devVarsPath) : null,
  devVarsRaw: devVarsPath && existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : null,
  environment: Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        /^(CLOUDFLARE|CF)_/i.test(name) || ['HOME', 'USERPROFILE', 'WRANGLER_HOME', 'XDG_CONFIG_HOME'].includes(name),
    ),
  ),
  mainSource: mainPath && existsSync(mainPath) ? readFileSync(mainPath, 'utf8') : null,
  outputFile: process.env.WRANGLER_OUTPUT_FILE_PATH ?? null,
}

const secretsFile = flagValues(['--secrets-file'])[0]
if (startsWithCommand('secret bulk')) {
  entry.secretFile = readSecretFile(resolve(argv[argv.indexOf('bulk') + 1]))
} else if (secretsFile !== undefined) {
  entry.secretFile = readSecretFile(resolve(secretsFile))
}

if (process.env.FAKE_WRANGLER_LOG) {
  appendFileSync(process.env.FAKE_WRANGLER_LOG, `${JSON.stringify(entry)}\n`)
}

const rules = process.env.FAKE_WRANGLER_RULES ? JSON.parse(readFileSync(process.env.FAKE_WRANGLER_RULES, 'utf8')) : []
const rule =
  rules.find(
    (candidate) =>
      startsWithCommand(candidate.command) &&
      (candidate.worker === undefined || candidate.worker === workerDir || candidate.worker === deployedName),
  ) ?? {}

function writeOutputEntry(value) {
  if (process.env.WRANGLER_OUTPUT_FILE_PATH) {
    appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify(value)}\n`)
  }
}

if (rule.holdMs) {
  const received = (signal) => {
    appendFileSync(`${process.env.FAKE_WRANGLER_LOG}.signals`, `${workerDir ?? ''} ${signal}\n`)
    // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
    if (!rule.ignoreSignals) process.exit(0)
  }

  process.on('SIGHUP', () => received('SIGHUP'))
  process.on('SIGINT', () => received('SIGINT'))
  process.on('SIGTERM', () => received('SIGTERM'))
}

const delay = rule.delayMs ?? rule.holdMs
if (delay) {
  await new Promise((done) => {
    setTimeout(done, delay)
  })
}

const outdir = flagValues(['--outdir'])[0]
if (startsWithCommand('deploy') && argv.includes('--dry-run') && outdir) {
  const target = resolve(outdir)
  mkdirSync(target, {recursive: true})
  writeFileSync(join(target, 'index.js'), rule.bundle ?? `export default {} // ${deployedName}\n`)
  // As real wrangler: a timestamp in README.md. A source map differs here too, as one does across line endings.
  writeFileSync(join(target, 'README.md'), `Generated at ${Date.now()}-${process.pid}\n`)
  writeFileSync(join(target, 'index.js.map'), `{"id":"${Date.now()}-${process.pid}"}\n`)
}

function defaultStdout() {
  if (startsWithCommand('versions list') && argv.includes('--json')) {
    return JSON.stringify([
      {id: 'version-older', number: 1, metadata: {}, annotations: []},
      {id: 'version-latest', number: 2, metadata: {}, annotations: []},
    ])
  }

  if (startsWithCommand('whoami')) return 'fake-user\n'
  return ''
}

if (rule.stdoutAfterExit === undefined) {
  process.stdout.write(rule.stdout ?? defaultStdout())
} else {
  // A descendant that keeps the pipe open and writes once this process is gone, as wrangler's own children can.
  const script = `setTimeout(() => process.stdout.write(${JSON.stringify(rule.stdoutAfterExit)}), 500)`
  spawn(process.execPath, ['-e', script], {detached: true, stdio: ['ignore', 1, 2]}).unref()
}

if (rule.stderr) process.stderr.write(rule.stderr)

if (rule.signal) {
  process.kill(process.pid, rule.signal)
  await new Promise((done) => {
    setTimeout(done, 10_000)
  })
}

const exitCode = rule.exitCode ?? 0
if (exitCode === 0 && !rule.noOutputEntry) {
  const uploaded = {version_id: `version-of-${workerDir}`, worker_name: deployedName}
  if (startsWithCommand('deploy') && !argv.includes('--dry-run')) writeOutputEntry({type: 'deploy', ...uploaded})
  if (startsWithCommand('versions upload')) writeOutputEntry({type: 'version-upload', ...uploaded})
}

if (exitCode !== 0 && (rule.failCode !== undefined || rule.failMessage !== undefined)) {
  writeOutputEntry({code: rule.failCode, message: rule.failMessage, type: 'command-failed'})
}

process.exitCode = exitCode
