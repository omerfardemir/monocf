// Stand-in for the wrangler CLI. A fixture installs a stub at node_modules/wrangler/bin/wrangler.js that imports
// this file. Every invocation appends one JSON line to FAKE_WRANGLER_LOG; behaviour comes from FAKE_WRANGLER_RULES.
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {basename, dirname, join, resolve} from 'node:path'
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

function parseDotenv(filePath) {
  if (!existsSync(filePath)) return null

  const vars = {}
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line)
    if (match) vars[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }

  return vars
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

const entry = {
  argv,
  cwd: process.cwd(),
  config,
  configs,
  devVars: configPath ? parseDotenv(join(dirname(configPath), '.dev.vars')) : null,
}

const uploadsSecrets = startsWithCommand('secret bulk') || startsWithCommand('versions secret bulk')
if (uploadsSecrets) {
  const secretFile = argv[argv.indexOf('bulk') + 1]
  entry.secretFile = {name: basename(secretFile), vars: parseDotenv(resolve(secretFile))}
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

if (rule.delayMs) {
  await new Promise((done) => {
    setTimeout(done, rule.delayMs)
  })
}

const outdir = flagValues(['--outdir'])[0]
if (startsWithCommand('deploy') && argv.includes('--dry-run') && outdir) {
  const target = resolve(outdir)
  mkdirSync(target, {recursive: true})
  writeFileSync(join(target, 'index.js'), `export default {} // ${deployedName}\n`)
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

process.stdout.write(rule.stdout ?? defaultStdout())
if (rule.stderr) process.stderr.write(rule.stderr)

if (rule.signal) {
  process.kill(process.pid, rule.signal)
  await new Promise((done) => {
    setTimeout(done, 10_000)
  })
}

process.exitCode = rule.exitCode ?? 0
