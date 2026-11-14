import {execFileSync, execSync} from 'node:child_process'
import {mkdtempSync, realpathSync, rmSync, symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {repoRoot} from './commands.js'

export interface Packed {
  /** The packed copy's `bin/run.js`. */
  bin: string
  /** Where the package was extracted, as it would be under node_modules/monocf. */
  dir: string
  /** Every path `npm pack` put in the tarball. */
  files: string[]
  remove(): void
}

/**
 * What `npm pack` publishes, extracted. Scripts are skipped, as `prepack` writes oclif.manifest.json into this checkout, where a
 * killed run would leave a stale one for every later run to load. The manifest is written in the copy instead, as `prepack` would.
 * Dependencies come from this checkout, through a link.
 */
export function packPackage(): Packed {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'monocf-pack-')))
  // npm is a script on Windows, so it needs a shell.
  const output = execSync(`npm pack --ignore-scripts --json --pack-destination "${parent}"`, {cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})
  const [{filename, files}] = JSON.parse(output) as [{filename: string; files: {path: string}[]}]
  // A relative name, as GNU tar reads `C:` in a path as a remote host.
  execFileSync('tar', ['-xzf', filename], {cwd: parent, stdio: 'ignore'})
  const dir = join(parent, 'package')
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'), 'junction')
  execFileSync(process.execPath, [join(repoRoot, 'node_modules', 'oclif', 'bin', 'run.js'), 'manifest'], {cwd: dir, stdio: 'ignore'})
  return {
    bin: join(dir, 'bin', 'run.js'),
    dir,
    files: files.map(({path}) => path.replaceAll('\\', '/')),
    remove() {
      rmSync(parent, {force: true, maxRetries: 5, recursive: true, retryDelay: 200})
    },
  }
}
