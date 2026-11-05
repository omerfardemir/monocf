// Stand-in for the wrangler CLI. A fixture installs a stub at node_modules/wrangler/wrangler-dist/cli.js that imports
// this file. Every invocation appends one JSON line to FAKE_WRANGLER_LOG; behaviour comes from FAKE_WRANGLER_RULES.
// What Cloudflare holds comes from the JSON file at FAKE_WRANGLER_CF, which a rule for the same command overrides.
import {spawn} from 'node:child_process'
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs'
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
const deployedName = flagValues(['--name'])[0] || (envName && config?.env?.[envName]?.name) || config?.name
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
  dotEnvFiles: configPath
    ? Object.fromEntries(
        readdirSync(dirname(configPath))
          .filter((name) => name.startsWith('.env'))
          .map((name) => [name, modeOf(join(dirname(configPath), name))]),
      )
    : {},
  // What came from a worker's .env in these tests, whatever the name: nothing else sets a variable that starts like this.
  dotEnvValues: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('FROM_'))),
  environment: Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        /^(CLOUDFLARE|CF)_/i.test(name) || ['HOME', 'USERPROFILE', 'WRANGLER_HOME', 'WRANGLER_LOG', 'XDG_CONFIG_HOME'].includes(name),
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
// A rule with `times` applies that many times, and then the command behaves as if the rule weren't there.
function timesUsed(index) {
  const path = `${process.env.FAKE_WRANGLER_RULES}.${index}.used`
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0
}

const ruleIndex = rules.findIndex(
  (candidate, index) =>
    startsWithCommand(candidate.command) &&
    (candidate.worker === undefined || candidate.worker === workerDir || candidate.worker === deployedName) &&
    (candidate.times === undefined || timesUsed(index) < candidate.times),
)
const rule = ruleIndex === -1 ? {} : rules[ruleIndex]
if (rule.times !== undefined) writeFileSync(`${process.env.FAKE_WRANGLER_RULES}.${ruleIndex}.used`, String(timesUsed(ruleIndex) + 1))

// The messages and codes are the ones the Cloudflare spike saw from real wrangler. API errors quote a URL with the account.
function apiError(detail) {
  const url = '/accounts/0123456789abcdef0123456789abcdef/workers/services'
  return `✘ [ERROR] A request to the Cloudflare API (${url}) failed.\n\n  ${detail}\n`
}

/** Parallel runs share the one Cloudflare file, so each change of it has to see the last one. */
function withCloudflareLock(path, work) {
  const lock = `${path}.lock`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }

  try {
    return work()
  } finally {
    rmSync(lock, {force: true, recursive: true})
  }
}

function deploymentsAnswer(state, name) {
  const worker = state.workers?.[name]
  if (!worker) return {exitCode: 1, stderr: apiError('This Worker does not exist on your account. [code: 10007]')}
  const versions = worker.active.map(([id, percentage]) => ({percentage, version_id: id}))
  return {stdout: JSON.stringify({annotations: {}, id: 'deployment', source: 'wrangler', strategy: 'percentage', versions})}
}

function versionAnswer(state, name, id) {
  const worker = state.workers?.[name]
  if (!worker) return {exitCode: 1, stderr: apiError('This Worker does not exist on your account. [code: 10007]')}
  if (!worker.tags || !(id in worker.tags)) return {exitCode: 1, stderr: apiError('Unknown version. [code: 100146]')}
  const tag = worker.tags[id]
  const triggeredBy = worker.triggeredBy?.[id]
  const annotations = {...(tag !== null && {'workers/tag': tag}), ...(triggeredBy && {'workers/triggered_by': triggeredBy})}
  const bindings = (worker.secrets ?? []).map((secret) => ({name: secret, text: 'never-printed', type: 'secret_text'}))
  return {stdout: JSON.stringify({annotations, id, metadata: {}, resources: {bindings: [...bindings, {name: 'PLAIN', text: 'x', type: 'plain_text'}]}})}
}

function r2Answer(state, path) {
  if (startsWithCommand('r2 bucket info')) {
    return state.buckets?.[argv[3]]
      ? {stdout: `name: ${argv[3]}\n`}
      : {exitCode: 1, stderr: apiError('The specified bucket does not exist. [code: 10006]')}
  }

  const [bucket, ...rest] = argv[3].split('/')
  const key = rest.join('/')
  if (startsWithCommand('r2 object get')) {
    // As real wrangler: a missing bucket reads the same as a missing key.
    const body = state.buckets?.[bucket]?.[key]
    return body === undefined ? {exitCode: 1, stderr: '✘ [ERROR] The specified key does not exist.\n'} : {stdout: body}
  }

  if (!state.buckets?.[bucket]) return {exitCode: 1, stderr: apiError('The specified bucket does not exist. [code: 10006]')}
  state.buckets[bucket][key] = readFileSync(resolve(flagValues(['--file'])[0]), 'utf8')
  writeFileSync(path, JSON.stringify(state))
  return {stdout: 'Upload complete.\n'}
}

function cloudflareAnswer() {
  const name = flagValues(['--name'])[0]
  const isRead = name !== undefined && (startsWithCommand('deployments status') || startsWithCommand('versions view'))
  if (!isRead && !startsWithCommand('r2')) return null
  const path = process.env.FAKE_WRANGLER_CF
  if (!path) return {exitCode: 1, stderr: 'fake wrangler: this test set no Cloudflare state\n'}
  return withCloudflareLock(path, () => {
    const state = JSON.parse(readFileSync(path, 'utf8'))
    if (startsWithCommand('r2')) return r2Answer(state, path)
    return startsWithCommand('versions view') ? versionAnswer(state, name, argv[2]) : deploymentsAnswer(state, name)
  })
}

const cloudflare = Object.keys(rule).length === 0 ? cloudflareAnswer() : null

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
  process.stdout.write(rule.stdout ?? cloudflare?.stdout ?? defaultStdout())
} else {
  // A descendant that keeps the pipe open and writes once this process is gone, as wrangler's own children can.
  const script = `setTimeout(() => process.stdout.write(${JSON.stringify(rule.stdoutAfterExit)}), 500)`
  spawn(process.execPath, ['-e', script], {detached: true, stdio: ['ignore', 1, 2]}).unref()
}

function effectiveTriggers() {
  return (envName && config?.env?.[envName]?.triggers) ?? config?.triggers ?? null
}

/** What a real write leaves behind. Nothing happens without a Cloudflare to keep it in. */
function cloudflareWrite() {
  const path = process.env.FAKE_WRANGLER_CF
  const isDeploy = startsWithCommand('deploy') && !argv.includes('--dry-run')
  const isWrite = isDeploy || startsWithCommand('versions upload') || startsWithCommand('versions deploy') || startsWithCommand('triggers deploy')
  if (!path || !isWrite) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))
  state.workers ??= {}
  const notFound = {exitCode: 1, stderr: apiError('This Worker does not exist on your account. [code: 10007]')}
  const save = (answer) => {
    writeFileSync(path, JSON.stringify(state))
    return answer
  }

  const nextVersion = (worker) => {
    state.nextVersion = (state.nextVersion ?? 0) + 1
    const id = `version-${state.nextVersion}-of-${workerDir}`
    worker.tags = {...worker.tags, [id]: flagValues(['--tag'])[0] ?? null}
    return id
  }

  if (isDeploy) {
    state.workers[deployedName] ??= {active: [], tags: {}}
    const worker = state.workers[deployedName]
    const versionId = nextVersion(worker)
    worker.active = [[versionId, 100]]
    worker.triggers = effectiveTriggers()
    return save({versionId})
  }

  const worker = state.workers[deployedName]
  if (!worker) return notFound
  if (startsWithCommand('versions upload')) return save({versionId: nextVersion(worker)})
  if (startsWithCommand('triggers deploy')) {
    worker.triggers = effectiveTriggers()
    return save({})
  }

  const versionId = argv[2].replace(/@100%$/, '')
  if (!worker.tags || !(versionId in worker.tags)) {
    return {exitCode: 1, failCode: 100_146, stderr: apiError('Unknown version. [code: 100146]')}
  }

  worker.active = [[versionId, 100]]
  return save({})
}

// `effectThenFail` takes effect and then fails anyway, as a process killed right after `Uploaded` does. `noEffect` exits 0 and
// changes nothing, as the loser of two parallel writes does.
const failsAnyway = (rule.exitCode ?? cloudflare?.exitCode ?? 0) !== 0
const written = !rule.noEffect && (!failsAnyway || rule.effectThenFail) && process.env.FAKE_WRANGLER_CF ? withCloudflareLock(process.env.FAKE_WRANGLER_CF, cloudflareWrite) : null

const stderrText = rule.stderr ?? cloudflare?.stderr ?? written?.stderr
if (stderrText) process.stderr.write(stderrText)

if (rule.signal) {
  process.kill(process.pid, rule.signal)
  await new Promise((done) => {
    setTimeout(done, 10_000)
  })
}

const exitCode = rule.exitCode ?? cloudflare?.exitCode ?? written?.exitCode ?? 0
if (exitCode === 0 && !rule.noOutputEntry) {
  const uploaded = {version_id: written?.versionId ?? `version-of-${workerDir}`, worker_name: deployedName}
  if (startsWithCommand('deploy') && !argv.includes('--dry-run')) writeOutputEntry({type: 'deploy', ...uploaded})
  if (startsWithCommand('versions upload')) writeOutputEntry({type: 'version-upload', ...uploaded})
}

if (exitCode !== 0 && (rule.failCode !== undefined || rule.failMessage !== undefined || written?.failCode !== undefined)) {
  writeOutputEntry({code: rule.failCode ?? written?.failCode, message: rule.failMessage ?? written?.stderr, type: 'command-failed'})
}

process.exitCode = exitCode
