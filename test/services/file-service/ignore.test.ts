import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {FileService} from '../../../src/services/file-service.js'
import {ErrorService} from '../../../src/services/error-service.js'
import {WRANGLER_FILE} from '../../../src/types/wrangler-types.js'

function createTempProject() {
  const root = mkdtempSync(join(tmpdir(), 'monocf-ignore-test-'))
  const workersDir = 'workers'
  const workersRoot = join(root, workersDir)
  mkdirSync(workersRoot, {recursive: true})
  // create some worker folders
  const workers = ['alpha', 'bravo', 'charlie']
  for (const worker of workers) {
    const workerDir = join(workersRoot, worker)
    mkdirSync(workerDir)
    writeFileSync(join(workerDir, WRANGLER_FILE), JSON.stringify({name: worker}, null, 2), 'utf8')
  }

  return {root, workersDir}
}

describe('FileService.loadIgnoreFile / isIgnoredWorker', () => {
  let projectRoot: string
  let workersDir: string

  beforeAll(() => {
    const tempProject = createTempProject()
    projectRoot = tempProject.root
    workersDir = tempProject.workersDir
  })

  afterAll(() => {
    rmSync(projectRoot, {recursive: true, force: true})
  })

  beforeEach(() => {
    rmSync(join(projectRoot, '.monocfignore'), {force: true})
  })

  it('ignores workers listed by name in .monocfignore', () => {
    // ignore bravo and charlie by name
    writeFileSync(join(projectRoot, '.monocfignore'), ['bravo', 'charlie'].join('\n'), 'utf8')

    const fsService = new FileService(new ErrorService())
    fsService.loadIgnoreFile(projectRoot, workersDir)

    expect(fsService.isIgnoredWorker('alpha')).toBe(false)
    expect(fsService.isIgnoredWorker('bravo')).toBe(true)
    expect(fsService.isIgnoredWorker('charlie')).toBe(true)
  })

  it('ignores workers when patterns include directory prefixes or globs', () => {
    // patterns with directory prefix and glob
    writeFileSync(join(projectRoot, '.monocfignore'), ['workers/charlie', '**/bravo'].join('\n'), 'utf8')

    const fsService = new FileService(new ErrorService())
    fsService.loadIgnoreFile(projectRoot, workersDir)

    expect(fsService.isIgnoredWorker('alpha')).toBe(false)
    expect(fsService.isIgnoredWorker('bravo')).toBe(true)
    expect(fsService.isIgnoredWorker('charlie')).toBe(true)
  })

  it('does nothing when .monocfignore does not exist', () => {
    const fsService = new FileService(new ErrorService())
    fsService.loadIgnoreFile(projectRoot, workersDir)

    expect(fsService.isIgnoredWorker('alpha')).toBe(false)
    expect(fsService.isIgnoredWorker('bravo')).toBe(false)
    expect(fsService.isIgnoredWorker('charlie')).toBe(false)
  })
})
