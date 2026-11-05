import {existsSync, readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'

import {EXIT_ENVIRONMENT, MonocfError} from '../errors.js'

export const WRANGLER_FLOOR = '4.151.0'

export interface Wrangler {
  /** The real entry. bin/wrangler.js turns a signal death of this process into exit 0, so it's never spawned. */
  cli: string
  version: string
}

function environmentError(message: string): MonocfError {
  return new MonocfError(message, EXIT_ENVIRONMENT)
}

function parseVersion(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? match.slice(1, 4).map(Number) : undefined
}

/** Compares the numeric parts only. Returns undefined when either side isn't a version. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return undefined
  for (const [index, part] of left.entries()) {
    if (part !== right[index]) return part - right[index]
  }

  return 0
}

/** Reads the floor from an `engines.node` such as `>=22.0.0`. Any other form isn't a floor monocf can check. */
export function nodeFloor(engines: unknown): string | undefined {
  const match = typeof engines === 'string' ? /^\s*>=\s*(\d+(?:\.\d+){0,2})\s*$/.exec(engines) : null
  if (!match) return undefined
  const parts = match[1].split('.')
  while (parts.length < 3) parts.push('0')
  return parts.join('.')
}

function findPackageJson(rootDir: string): string {
  try {
    return createRequire(join(rootDir, 'package.json')).resolve('wrangler/package.json')
  } catch (error) {
    const {code, message} = error as NodeJS.ErrnoException
    if (code === 'MODULE_NOT_FOUND') {
      throw environmentError(
        `Could not find wrangler from ${rootDir}. Install it in your project: npm install --save-dev wrangler@">=${WRANGLER_FLOOR}"`,
      )
    }

    throw environmentError(`The wrangler installed for ${rootDir} can't be used: ${message}`)
  }
}

function readPackageJson(path: string): {engines?: {node?: unknown}; version?: unknown} {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw environmentError(`The wrangler package at ${path} is broken: ${(error as Error).message}`)
  }
}

/**
 * Finds wrangler from the project root, and only there, because the bundle depends on its version. Spawning its entry
 * directly skips the Node check in bin/wrangler.js, so the Node floor is checked here too.
 */
export function locateWrangler(rootDir: string, nodeVersion: string = process.versions.node): Wrangler {
  const packagePath = findPackageJson(rootDir)
  const {engines, version} = readPackageJson(packagePath)

  if (typeof version !== 'string' || compareVersions(version, WRANGLER_FLOOR) === undefined) {
    throw environmentError(`The wrangler package at ${packagePath} has no valid version.`)
  }

  if (compareVersions(version, WRANGLER_FLOOR)! < 0) {
    throw environmentError(`monocf needs wrangler ${WRANGLER_FLOOR} or newer, but ${rootDir} resolves ${version}.`)
  }

  const floor = nodeFloor(engines?.node)
  if (floor && compareVersions(nodeVersion, floor)! < 0) {
    throw environmentError(`wrangler ${version} needs Node.js ${floor} or newer, but this is ${nodeVersion}.`)
  }

  const cli = join(dirname(packagePath), 'wrangler-dist', 'cli.js')
  if (!existsSync(cli)) {
    throw environmentError(`The wrangler package at ${packagePath} has no wrangler-dist/cli.js.`)
  }

  return {cli, version}
}
