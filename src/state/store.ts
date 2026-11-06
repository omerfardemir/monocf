import {randomBytes} from 'node:crypto'
import {readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

import {ConfigError} from '../config/types.js'
import {EXIT_ENVIRONMENT, MonocfError} from '../errors.js'
import {writeFileAtomic} from '../runtime/atomic.js'
import {isSuccessful, readFailure, type WranglerCall} from '../wrangler/read.js'

export interface StateStore {
  /** Throws an environment error when the store can't be used. */
  check(): Promise<void>
  describe(): string
  /** Null means the key is missing. */
  read(key: string): Promise<null | string>
  write(key: string, body: string): Promise<void>
}

export type StateLocation = {bucket: string; kind: 'r2'; prefix: string; url: string} | {dir: string; kind: 'file'; url: string}

/** R2's own rule. It also keeps a name from being read as a flag by wrangler. */
const VALID_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/** Parses `file:<dir>` or `r2://<bucket>/<prefix>`. A relative directory counts from `cwd`. */
export function parseStateUrl(url: string, cwd: string = process.cwd()): StateLocation {
  if (url.startsWith('file:')) {
    const dir = url.slice('file:'.length)
    if (dir.trim() === '') throw new ConfigError(`--state ${url} names no directory.`)
    return {dir: resolve(cwd, dir), kind: 'file', url}
  }

  if (url.startsWith('r2://')) {
    const [bucket, ...prefix] = url.slice('r2://'.length).split('/')
    if (!VALID_BUCKET.test(bucket)) throw new ConfigError(`--state ${url} has no valid bucket name.`)
    return {bucket, kind: 'r2', prefix: prefix.filter((part) => part !== '').join('/'), url}
  }

  throw new ConfigError(`--state ${url} is not supported. Use file:<dir> or r2://<bucket>/<prefix>.`)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** A directory that isn't there is an error, as a missing bucket is: empty state would plan a redeploy of everything. */
function fileStore({dir, url}: Extract<StateLocation, {kind: 'file'}>): StateStore {
  return {
    async check() {
      let isDirectory = false
      try {
        isDirectory = statSync(dir).isDirectory()
      } catch (error) {
        if (!isMissing(error)) throw new MonocfError(`Can't use the state directory ${dir}: ${(error as Error).message}`, EXIT_ENVIRONMENT)
      }

      if (!isDirectory) throw new MonocfError(`The state directory ${dir} doesn't exist. Create it first.`, EXIT_ENVIRONMENT)
    },
    describe: () => url,
    async read(key) {
      try {
        return readFileSync(join(dir, key), 'utf8')
      } catch (error) {
        if (isMissing(error)) return null
        throw new MonocfError(`Can't read ${key} from ${url}: ${(error as Error).message}`, EXIT_ENVIRONMENT)
      }
    },
    async write(key, body) {
      writeFileAtomic(join(dir, key), body)
    },
  }
}

// `r2 object get` says this for a missing bucket too, which is why check() has to look at the bucket first.
const MISSING_KEY = /specified key does not exist/i
const MORE_THAN_ONE_ACCOUNT = /more than one account/i
// What the API says for a bucket that isn't there, as code 10006.
const MISSING_BUCKET = /specified bucket does not exist|\bcode: 10006\b/i

/**
 * Through wrangler, so CI needs no credentials beyond its Cloudflare token. Wrangler offers no conditional write, so this
 * can't act as a lock: CI must allow only one pipeline per environment.
 */
function r2Store({bucket, prefix, url}: Extract<StateLocation, {kind: 'r2'}>, call: WranglerCall, temporaryDir: string): StateStore {
  const fullKey = (key: string): string => (prefix === '' ? key : `${prefix}/${key}`)
  return {
    async check() {
      const result = await call({action: 'r2-bucket-info', bucket})
      if (result.signal) throw readFailure(`state bucket ${bucket}`, result)
      if (!isSuccessful(result)) {
        const {message} = readFailure(`state bucket ${bucket}`, result)
        // State calls have no worker, so no account_id: only the environment can say which account holds the bucket.
        if (MORE_THAN_ONE_ACCOUNT.test(result.stderr) && !process.env.CLOUDFLARE_ACCOUNT_ID) {
          throw new MonocfError(
            `Can't use the state bucket ${bucket}: this login has more than one account, and nothing says which holds it. Set CLOUDFLARE_ACCOUNT_ID to that account's ID.
${message}`,
            EXIT_ENVIRONMENT,
          )
        }

        // A rate limit or an outage left after the retries isn't a missing bucket, so only that answer gets the hint.
        const hint = MISSING_BUCKET.test(result.stderr) ? ` It doesn't exist. Create it with: wrangler r2 bucket create ${bucket}` : ''
        throw new MonocfError(`Can't use the state bucket ${bucket}.${hint}\n${message}`, EXIT_ENVIRONMENT)
      }
    },
    describe: () => url,
    async read(key) {
      const result = await call({action: 'r2-get', bucket, key: fullKey(key)})
      if (isSuccessful(result)) return result.stdout
      if (!result.signal && MISSING_KEY.test(result.stderr)) return null
      throw readFailure(`${url}: ${key}`, result)
    },
    async write(key, body) {
      const file = join(temporaryDir, `state-${randomBytes(6).toString('hex')}.json`)
      writeFileSync(file, body)
      try {
        const result = await call({action: 'r2-put', bucket, file, key: fullKey(key)})
        if (!isSuccessful(result)) throw readFailure(`${url}: ${key}`, result)
      } finally {
        rmSync(file, {force: true})
      }
    },
  }
}

export function openStateStore(location: StateLocation, call: WranglerCall, temporaryDir: string): StateStore {
  return location.kind === 'file' ? fileStore(location) : r2Store(location, call, temporaryDir)
}
