import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join, resolve} from 'node:path'

import {WranglerError} from '../types/error-types.js'

const WRANGLER_MISSING_EXIT_CODE = 3

function findBin(requireFrom: string): string | undefined {
  try {
    const packagePath = createRequire(requireFrom).resolve('wrangler/package.json')
    const {bin} = JSON.parse(readFileSync(packagePath, 'utf8')) as {bin?: Record<string, string> | string}
    const relativeBin = typeof bin === 'string' ? bin : bin?.wrangler
    return relativeBin ? resolve(dirname(packagePath), relativeBin) : undefined
  } catch {
    return undefined
  }
}

/**
 * Finds the wrangler bin script: the project's own wrangler first, then monocf's dependency.
 * @param rootDir Project root directory
 * @returns Absolute path to the wrangler bin script
 */
export function locateWranglerBin(rootDir: string): string {
  const bin = findBin(join(rootDir, 'package.json')) ?? findBin(import.meta.url)
  if (!bin) {
    throw new WranglerError(
      `Could not find wrangler from ${rootDir}. Install it in your project.`,
      WRANGLER_MISSING_EXIT_CODE,
      'wrangler',
      [],
    )
  }

  return bin
}
