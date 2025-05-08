import {execSync} from 'node:child_process'
import {readFileSync} from 'node:fs'

/**
 * Gets the version of the package
 * @returns The version and release (git sha) of the package
 */
export function getPackageVersion(packageJsonPath: string): {version: string; release: string} {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const pkgVersion = packageJson.version

  let gitSha = 'unknown'
  try {
    gitSha = execSync('git log -1 --pretty=format:%h').toString().trim()
  } catch (error) {
    console.error(`Git commit cannot be retrieved: ${error}`)
  }

  return {
    version: pkgVersion,
    release: gitSha,
  }
}
