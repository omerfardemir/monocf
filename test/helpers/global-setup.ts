import {execFileSync} from 'node:child_process'
import {rmSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export default function setup(): void {
  // Start clean so a command deleted from src can't survive in dist and pass a test.
  rmSync(join(repoRoot, 'dist'), {force: true, recursive: true})
  rmSync(join(repoRoot, 'tsconfig.tsbuildinfo'), {force: true})
  execFileSync(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
}
