import {expect} from 'chai'
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {FileService} from '../../../src/services/file-service.js'
import {ErrorService} from '../../../src/services/error-service.js'
import {Commander} from '../../../src/types/command-types.js'

// Dummy commander for ErrorService
const commander: Commander = {
  cmdEvents: () => ({}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(_input: Error | string, _options?: any) {
    /* noop in tests */
  },
  warn: (input: Error | string) => input,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(_message?: string, ..._args: any[]) {
    /* noop */
  },
}

function createTempProject() {
  const root = mkdtempSync(join(tmpdir(), 'monocf-ignore-test-'))
  const workersDir = 'workers'
  const workersRoot = join(root, workersDir)
  mkdirSync(workersRoot, {recursive: true})
  // create some worker folders
  mkdirSync(join(workersRoot, 'alpha'))
  mkdirSync(join(workersRoot, 'bravo'))
  mkdirSync(join(workersRoot, 'charlie'))
  return {root, workersDir}
}

describe('FileService.loadIgnoreFile / isIgnoredWorker', () => {
  it('ignores workers listed by name in .monocfignore', () => {
    const {root, workersDir} = createTempProject()
    // ignore bravo and charlie by name
    writeFileSync(join(root, '.monocfignore'), ['bravo', 'charlie'].join('\n'), 'utf8')

    const fsService = new FileService(new ErrorService(commander))
    fsService.loadIgnoreFile(root, workersDir)

    expect(fsService.isIgnoredWorker('alpha')).to.equal(false)
    expect(fsService.isIgnoredWorker('bravo')).to.equal(true)
    expect(fsService.isIgnoredWorker('charlie')).to.equal(true)

    rmSync(root, {recursive: true, force: true})
  })

  it('ignores workers when patterns include directory prefixes or globs', () => {
    const {root, workersDir} = createTempProject()
    // patterns with directory prefix and glob
    writeFileSync(join(root, '.monocfignore'), ['workers/charlie', '**/bravo'].join('\n'), 'utf8')

    const fsService = new FileService(new ErrorService(commander))
    fsService.loadIgnoreFile(root, workersDir)

    expect(fsService.isIgnoredWorker('alpha')).to.equal(false)
    expect(fsService.isIgnoredWorker('bravo')).to.equal(true)
    expect(fsService.isIgnoredWorker('charlie')).to.equal(true)

    rmSync(root, {recursive: true, force: true})
  })

  it('does nothing when .monocfignore does not exist', () => {
    const {root, workersDir} = createTempProject()
    const fsService = new FileService(new ErrorService(commander))
    fsService.loadIgnoreFile(root, workersDir)

    expect(fsService.isIgnoredWorker('alpha')).to.equal(false)
    expect(fsService.isIgnoredWorker('bravo')).to.equal(false)
    expect(fsService.isIgnoredWorker('charlie')).to.equal(false)

    rmSync(root, {recursive: true, force: true})
  })
})
